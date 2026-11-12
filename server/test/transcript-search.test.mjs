import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { searchTranscripts } from "../src/transcript-search.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-search-"));
const dbPath = path.join(dir, "sessions.db");
const piDir = path.join(dir, "sessions");
const { DatabaseSync } = await import("node:sqlite");
{
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, chat_message TEXT)");
  const ins = db.prepare("INSERT INTO message_nodes (session_id, chat_message) VALUES (?, ?)");
  const msg = (m) => JSON.stringify(m);
  ins.run("d1", msg({ message_id: "u1", role: "user", content: "deploy the Alpha service tonight" }));
  ins.run("d1", msg({ message_id: "u1", role: "user", content: "deploy the Alpha service tonight" })); // duplicate snapshot
  ins.run("d1", msg({ message_id: "a1", role: "assistant", content: [{ text: "deploying Alpha now" }] }));
  ins.run("d1", msg({ message_id: "t1", role: "tool", content: "Alpha tool output" }));
  ins.run("d2", msg({ message_id: "c1", role: "assistant", content: "部署 Alpha 服务" }));
  ins.run("d2", msg({ message_id: "q1", role: "user", content: 'enable the "quoted" flag' }));
  ins.run("d2", msg({ message_id: "p1", role: "assistant", content: "apply 50%_off coupon" }));
  ins.run("d2", msg({ message_id: "p2", role: "assistant", content: "apply 50x_off coupon" }));
  db.close();
}
fs.mkdirSync(path.join(piDir, "project"), { recursive: true });
fs.writeFileSync(path.join(piDir, "project", "2026-01-01_p1.jsonl"), [
  JSON.stringify({ type: "session", id: "p1", cwd: "/w" }),
  JSON.stringify({ type: "custom_message", customType: "x", content: "skip me" }),
  JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "alpha in pi text" } }),
  JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "pi Alpha reply" }] } }),
].join("\n"));
const sessions = [
  { sessionId: "p1", agent: "pi", title: "pi", cwd: "/w", updatedAt: "2026-02-01" },
  { sessionId: "d2", agent: "devin", title: "d2", cwd: "/w", updatedAt: "2026-01-02" },
  { sessionId: "d1", agent: "devin", title: "d1", cwd: "/w", updatedAt: "2026-01-01" },
];
const run = (q, extra = {}) => searchTranscripts({ q, sessions, devinDbPath: dbPath, piSessionsDir: piDir, ...extra });

test("ascii, CJK, JSON-escaped and LIKE-escaped matches verify correctly", async () => {
  const alpha = await run("alpha");
  assert.equal(alpha.results.length, 3);
  assert.deepEqual(alpha.results.map((r) => r.sessionId), ["p1", "d2", "d1"], "recency order");
  const d1 = alpha.results.find((r) => r.sessionId === "d1");
  assert.equal(d1.count, 2, "duplicate snapshots count once; tool rows excluded");
  assert.ok(d1.snippet.includes("…") === false || d1.snippet.length < 130);
  const cjk = await run("部署");
  assert.equal(cjk.results[0].sessionId, "d2");
  const quoted = await run('"quoted"');
  assert.equal(quoted.results.length, 1);
  const off = await run("50%_off");
  assert.equal(off.results.length, 1, "literal %/_ match only");
  assert.equal(off.results[0].count, 1);
});

test("budget expiry and limits truncate without throwing", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ sessionId: `p${i}`, agent: "pi", title: `p${i}`, cwd: "/w", updatedAt: `2026-03-${String(60 - i).padStart(2, "0")}` }));
  const r = await searchTranscripts({ q: "alpha", sessions: many, devinDbPath: dbPath, piSessionsDir: piDir, budgetMs: 1 });
  assert.equal(r.truncated, true);
  const limited = await run("alpha", { limit: 2 });
  assert.equal(limited.results.length, 2);
  assert.equal(limited.truncated, true);
});

test("missing stores degrade to empty results and abort settles", async () => {
  const r = await searchTranscripts({ q: "alpha", sessions, devinDbPath: path.join(dir, "none.db"), piSessionsDir: path.join(dir, "nope"), budgetMs: 4000 });
  assert.equal(r.results.length, 0);
  const controller = new AbortController();
  const work = run("alpha", { signal: controller.signal, budgetMs: 60000 });
  controller.abort();
  const out = await work;
  assert.ok(out.truncated || out.elapsedMs >= 0);
});
