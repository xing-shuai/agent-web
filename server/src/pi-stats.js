// Pi session-file usage totals — same math as pi-open-tui's footer
// (extensions/open-tui/state.ts getUsageTotals): sum `usage` across assistant /
// toolResult messages and branch_summary / compaction entries in the session
// jsonl. Incremental: a per-file byte offset means only appended data is read,
// and `usage` objects are extracted by brace matching rather than parsing the
// whole line — session files can exceed 100 MB.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const MAP_PATH = path.join(os.homedir(), ".pi/pi-acp/session-map.json");
const SESSIONS_ROOT = path.join(os.homedir(), ".pi/agent/sessions");

const fileById = new Map(); // sessionId -> jsonl path | null (negative cached)
const parsers = new Map(); // file -> {offset, frag, totals, mtimeMs, size}
let mapCache = { at: 0, byId: new Map() };

function mapFiles() {
  if (Date.now() - mapCache.at < 10_000) return mapCache.byId;
  const byId = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
    for (const [sid, e] of Object.entries(j?.sessions || {})) {
      if (e?.sessionFile) byId.set(sid, e.sessionFile);
    }
  } catch {}
  mapCache = { at: Date.now(), byId };
  return byId;
}

// Files are named `<ts>_<sessionId>.jsonl` under --escaped-cwd-- dirs.
function scanFor(id) {
  try {
    for (const dir of fs.readdirSync(SESSIONS_ROOT)) {
      const d = path.join(SESSIONS_ROOT, dir);
      for (const n of fs.readdirSync(d)) {
        if (n.endsWith(`_${id}.jsonl`)) return path.join(d, n);
      }
    }
  } catch {}
  return null;
}

export function piSessionFile(id) {
  const hit = fileById.get(id);
  if (hit !== undefined) return hit; // positive hits only — see below
  let f = mapFiles().get(id) || null;
  if (!f || !fs.existsSync(f)) f = scanFor(id);
  // Only cache a found path: a brand-new session has no jsonl until its first
  // prompt lands, so a miss must stay re-probeable.
  if (f) fileById.set(id, f);
  return f;
}

// Extract the object literal following `"usage":` via brace matching, so we
// never JSON.parse a multi-KB entry line.
function usageAt(line, idx) {
  let i = idx + 7;
  while (line[i] === " " || line[i] === ":") i++;
  if (line[i] !== "{") return null;
  let depth = 0,
    inStr = false,
    esc = false;
  const start = i;
  for (; i < line.length; i++) {
    const c = line[i];
    if (esc) esc = false;
    else if (c === "\\") esc = true;
    else if (c === '"') inStr = !inStr;
    else if (!inStr) {
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        i++;
        break;
      }
    }
  }
  try {
    return JSON.parse(line.slice(start, i));
  } catch {
    return null;
  }
}

const num = (v) => (Number.isFinite(v) ? v : 0);

function accumLine(t, line) {
  // Only entry types that carry usage per pi-open-tui: assistant/toolResult
  // messages, branch_summary, compaction.
  const isMsg = line.startsWith('{"type":"message"');
  if (
    !isMsg &&
    !line.startsWith('{"type":"branch_summary"') &&
    !line.startsWith('{"type":"compaction"')
  )
    return;
  const isAssistant = isMsg && line.includes('"role":"assistant"');
  const isToolResult = isMsg && line.includes('"role":"toolResult"');
  if (isMsg && !isAssistant && !isToolResult) return;
  const idx = line.indexOf('"usage":');
  if (idx < 0) return;
  const u = usageAt(line, idx);
  if (!u) return;
  const input = num(u.input);
  const cr = num(u.cacheRead);
  const cw = num(u.cacheWrite);
  // input matches /session's "uncached" total: cacheWrite bills near full price.
  t.input += input + cw;
  t.output += num(u.output);
  t.cacheRead += cr;
  t.cacheWrite += cw;
  const cost = u.cost;
  t.cost += num(typeof cost === "object" ? cost?.total : cost);
  if (isAssistant) {
    const prompt = input + cr + cw;
    if (prompt > 0) t.cacheHitRate = (cr / prompt) * 100;
  }
}

// Read appended bytes (or the whole file on first call), fold complete lines,
// keep a trailing fragment for the next call.
async function update(file) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st) return null;
  let p = parsers.get(file);
  if (p && p.size === st.size && p.mtimeMs === st.mtimeMs) return p.totals;
  if (!p || st.size < p.offset) {
    p = {
      offset: 0,
      frag: "",
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHitRate: null },
    };
    parsers.set(file, p);
  }
  const len = st.size - p.offset;
  if (len <= 0) {
    p.mtimeMs = st.mtimeMs;
    return p.totals;
  }
  const fh = await fsp.open(file);
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, p.offset);
    p.offset = st.size;
    p.mtimeMs = st.mtimeMs;
    p.size = st.size;
    const text = p.frag + buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) {
      p.frag = text;
    } else {
      p.frag = text.slice(lastNl + 1);
      for (const line of text.slice(0, lastNl).split("\n")) {
        if (line.includes('"usage":')) accumLine(p.totals, line);
      }
    }
    // Trim the parser cache so long-lived servers don't pin stale entries.
    if (parsers.size > 2000) parsers.delete(parsers.keys().next().value);
    return p.totals;
  } finally {
    await fh.close();
  }
}

const inflight = new Map(); // id -> Promise

/** Usage totals for a pi session's jsonl, or null when no file is found.
 *  Coalesced + incremental: repeat calls only read newly appended bytes. */
export function piUsageStats(id) {
  if (!id) return Promise.resolve(null);
  let p = inflight.get(id);
  if (p) return p;
  p = (async () => {
    const file = piSessionFile(id);
    if (!file) return null;
    return await update(file);
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}
