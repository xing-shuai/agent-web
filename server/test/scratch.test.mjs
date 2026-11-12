import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createScratchDir, isScratchDir, isScratchDirLexical, scratchInfo, removeScratchDir, scratchRoot } from "../src/scratch.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dw-scratch-"));

test("scratchRoot honors DEVIN_WEB_SCRATCH_DIR", () => {
  const prev = process.env.DEVIN_WEB_SCRATCH_DIR;
  process.env.DEVIN_WEB_SCRATCH_DIR = "/tmp/custom-root";
  assert.equal(scratchRoot(), "/tmp/custom-root");
  delete process.env.DEVIN_WEB_SCRATCH_DIR;
  assert.equal(scratchRoot(), path.join(os.homedir(), ".local/share/devin-web/scratch"));
  if (prev !== undefined) process.env.DEVIN_WEB_SCRATCH_DIR = prev;
});

test("createScratchDir makes a 0700 direct child and unique names", () => {
  const base = path.join(tmp(), "root");
  const a = createScratchDir(base);
  const b = createScratchDir(base);
  assert.notEqual(a, b, "names are unique");
  assert.equal(path.dirname(a), base);
  assert.match(path.basename(a), /^\d{8}-\d{6}-[0-9a-f]{6}$/);
  assert.equal(fs.statSync(a).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(base));
});

test("createScratchDir never reuses an existing directory", () => {
  const base = tmp();
  const existing = path.join(base, `${"20250101-120000"}-abcdef`);
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, "keep.txt"), "x");
  const made = createScratchDir(base);
  assert.notEqual(made, existing);
  assert.ok(fs.existsSync(path.join(existing, "keep.txt")), "existing dir left untouched");
  // stress uniqueness a little — every returned path is fresh
  const seen = new Set([made]);
  for (let i = 0; i < 20; i++) {
    const d = createScratchDir(base);
    assert.ok(!seen.has(d));
    seen.add(d);
  }
});

test("isScratchDir: direct child yes; root itself, nested, traversal, symlink escape no", () => {
  const base = tmp();
  const root = path.join(base, "root");
  fs.mkdirSync(root, { recursive: true });
  const child = path.join(root, "chat");
  fs.mkdirSync(child);
  assert.ok(isScratchDir(root, child));
  assert.ok(isScratchDirLexical(root, child));
  assert.ok(!isScratchDir(root, root), "root itself is not a scratch dir");
  fs.mkdirSync(path.join(child, "deep"));
  assert.ok(!isScratchDir(root, path.join(child, "deep")), "nested descendants rejected");
  assert.ok(!isScratchDir(root, path.join(root, "..", "escape")), "../ traversal rejected");
  assert.ok(!isScratchDir(root, path.join(base, "sibling")), "outside dir rejected");
  // symlink inside root pointing outside must resolve out and fail
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  const link = path.join(root, "link");
  fs.symlinkSync(outside, link, "dir");
  assert.ok(!isScratchDir(root, link), "symlink escaping root rejected");
  // missing dir: lexical compare still enforces direct-child
  assert.ok(isScratchDir(root, path.join(root, "not-there-yet")), "missing direct child ok");
  assert.ok(!isScratchDir(root, path.join(root, "a", "b")), "missing nested rejected");
});

test("scratchInfo counts entries and bytes, ignores symlink targets", () => {
  const base = tmp();
  const dir = path.join(base, "d");
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello"); // 5 bytes
  fs.writeFileSync(path.join(dir, "sub", "b.txt"), "world!!"); // 7 bytes
  fs.symlinkSync(path.join(dir, "a.txt"), path.join(dir, "sub", "link"));
  const info = scratchInfo(dir);
  assert.equal(info.exists, true);
  assert.equal(info.dir, dir);
  assert.equal(info.entries, 4, "a.txt + sub + sub/b.txt + sub/link");
  assert.equal(info.bytes, 12 + fs.lstatSync(path.join(dir, "sub", "link")).size, "files + link size, no double count");
  assert.equal(info.truncated, false);
  assert.deepEqual(scratchInfo(path.join(base, "missing")), { dir: path.join(base, "missing"), exists: false, entries: 0, bytes: 0, truncated: false });
});

test("scratchInfo truncates at 10,000 entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-scratch-big-"));
  for (let i = 0; i < 10050; i++) fs.writeFileSync(path.join(dir, `f${i}`), "x");
  const info = scratchInfo(dir);
  assert.equal(info.entries, 10000);
  assert.equal(info.truncated, true);
});

test("removeScratchDir refuses non-scratch dirs; inner symlinks removed as links", () => {
  const base = tmp();
  const root = path.join(base, "root");
  fs.mkdirSync(root);
  assert.throws(() => removeScratchDir(root, base), /not a scratch directory/);
  assert.ok(fs.existsSync(base), "refusal removed nothing");
  const victim = path.join(root, "victim");
  fs.mkdirSync(victim);
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "precious");
  fs.symlinkSync(outside, path.join(victim, "escape"), "dir");
  removeScratchDir(root, victim);
  assert.ok(!fs.existsSync(victim));
  assert.ok(fs.existsSync(path.join(outside, "keep.txt")), "symlink target never followed");
});
