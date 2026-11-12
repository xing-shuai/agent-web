// Transcript search worker: devin sqlite + pi JSONL scans run off the main
// thread so a 500 MiB store never freezes the WS streams. Scans sessions
// most-recent-first, one at a time, and posts each hit as it is found so an
// early termination still returns everything collected.
import { workerData, parentPort } from "node:worker_threads";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import readline from "node:readline";

const { q, qLower, sessions, devinDbPath, piSessionsDir, limit, deadline } = workerData;

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text || "").join("") : "";
const snippet = (text) => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const at = collapsed.toLowerCase().indexOf(qLower);
  if (at < 0) return null;
  const start = Math.max(0, at - 60), end = Math.min(collapsed.length, at + q.length + 60);
  return { snippet: (start > 0 ? "…" : "") + collapsed.slice(start, end) + (end < collapsed.length ? "…" : ""),
    matchStart: at - start + (start > 0 ? 1 : 0), matchEnd: at - start + (start > 0 ? 1 : 0) + q.length };
};
const hit = (session, role, text, count, countCapped) => {
  const snip = snippet(text);
  if (!snip) return null;
  return { sessionId: session.sessionId, agent: session.agent, title: session.title, cwd: session.cwd,
    updatedAt: session.updatedAt, archived: session.archived, role, ...snip, count, countCapped };
};

const post = (message) => parentPort.postMessage(message);
const expired = () => Date.now() > deadline;

// Devin: one session_id-filtered LIKE prefilter (the statement shape the rest
// of the codebase relies on), then strict JSON verification.
let stmt = null;
if (existsSync(devinDbPath)) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(devinDbPath, { readOnly: true });
  stmt = db.prepare("SELECT row_id, chat_message FROM message_nodes WHERE session_id = ? AND chat_message LIKE ? ESCAPE '\\' ORDER BY row_id DESC LIMIT 200");
}
const pattern = `%${likeEscape(JSON.stringify(q).slice(1, -1))}%`;
function scanDevin(session) {
  if (!stmt) return null;
  let rows;
  try { rows = stmt.all(session.sessionId, pattern); } catch { return null; }
  const seen = new Set();
  let verified = null, count = 0;
  for (const r of rows) {
    let m;
    try { m = JSON.parse(r.chat_message); } catch { continue; }
    if (!["user", "assistant"].includes(m.role)) continue;
    const text = textOf(m.content);
    if (!text.toLowerCase().includes(qLower)) continue;
    const key = m.message_id || text;
    if (seen.has(key)) continue;
    seen.add(key); count++;
    if (!verified) verified = { role: m.role, text };
  }
  return verified && hit(session, verified.role, verified.text, count, rows.length >= 200);
}

// Pi: stream each file; the cheap line prefilter rejects almost everything
// before JSON.parse. Scans ALL branches in the file (including abandoned
// ones) — the hit is session-level only and never grafts back.
const piFiles = new Map();
if (existsSync(piSessionsDir)) {
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) piFiles.set(e.name.slice(e.name.lastIndexOf("_") + 1, -6), p);
    }
  };
  walk(piSessionsDir);
}
const needle = JSON.stringify(q).slice(1, -1).toLowerCase();
async function scanPi(session) {
  const file = piFiles.get(session.sessionId);
  if (!file || !existsSync(file)) return null;
  const seen = new Set();
  let last = null, count = 0;
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (expired() || count >= 200) break;
    if (!line.toLowerCase().includes(needle)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) continue;
    const text = textOf(entry.message.content);
    if (!text.toLowerCase().includes(qLower)) continue;
    const key = entry.id || text;
    if (seen.has(key)) continue;
    seen.add(key); count++;
    last = { role: entry.message.role, text };
  }
  rl.close();
  return last && hit(session, last.role, last.text, count, count >= 200);
}

let emitted = 0, scannedAll = true;
for (const session of sessions) {
  if (expired() || emitted >= limit) { scannedAll = false; break; }
  const found = session.agent === "pi" ? await scanPi(session) : scanDevin(session);
  if (found) { emitted++; post({ type: "hit", hit: found }); }
}
post({ type: "done", truncated: !scannedAll });
