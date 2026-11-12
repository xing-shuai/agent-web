// Quick-chat scratch directories: fresh per-chat working dirs under a
// private root. All helpers take an explicit root so tests can inject a
// temp dir; production callers use scratchRoot() (DEVIN_WEB_SCRATCH_DIR or
// ~/.local/share/devin-web/scratch).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function scratchRoot() {
  return process.env.DEVIN_WEB_SCRATCH_DIR || path.join(os.homedir(), ".local/share/devin-web/scratch");
}

const stamp = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Create <root>/<YYYYMMDD-HHmmss>-<6hex> (0700); never reuses an existing dir. */
export function createScratchDir(root = scratchRoot()) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 8; attempt++) {
    const dir = path.join(root, `${stamp()}-${crypto.randomBytes(3).toString("hex")}`);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      return dir;
    } catch (e) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
  }
  throw new Error("could not create a unique scratch directory");
}

const realpath = (p) => {
  try { return fs.realpathSync(p); } catch { return null; }
};

/** True only when dir is a DIRECT child of root. Existing paths are compared
 *  by realpath (symlink escapes rejected); a missing dir falls back to the
 *  lexically resolved path — still direct-child only, so ../ traversal and
 *  nested descendants are rejected. */
export function isScratchDir(root, dir) {
  if (!root || !dir) return false;
  const rr = realpath(root) || path.resolve(root);
  const rd = realpath(dir) || path.resolve(dir);
  return rd !== rr && path.dirname(rd) === rr;
}

/** Syscall-free variant for per-row list enrichment: lexical direct child. */
export function isScratchDirLexical(root, dir) {
  if (!root || !dir) return false;
  const rr = path.resolve(root), rd = path.resolve(dir);
  return rd !== rr && path.dirname(rd) === rr;
}

const MAX_ENTRIES = 10000;

/** Recursive lstat walk — never follows symlinks. Stops at 10,000 entries. */
export function scratchInfo(dir) {
  const out = { dir, exists: false, entries: 0, bytes: 0, truncated: false };
  let st;
  try { st = fs.lstatSync(dir); } catch { return out; }
  if (!st.isDirectory()) return out;
  out.exists = true;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let list;
    try { list = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of list) {
      const p = path.join(cur, ent.name);
      let s;
      try { s = fs.lstatSync(p); } catch { continue; }
      out.entries++;
      if (s.isDirectory()) stack.push(p);
      else out.bytes += s.size;
      if (out.entries >= MAX_ENTRIES) { out.truncated = true; return out; }
    }
  }
  return out;
}

export function removeScratchDir(root, dir) {
  if (!isScratchDir(root, dir)) {
    const e = new Error(`not a scratch directory: ${dir}`);
    e.status = 400;
    e.code = "NOT_SCRATCH";
    throw e;
  }
  // fs.rm never follows symlinks — links inside are removed as links.
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
