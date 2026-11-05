// Integration test for the in-process pi SDK transport. Creates real SDK
// AgentSessions (reads ~/.pi/agent settings + extensions) but never sends
// a prompt, so no model/network access is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { PiSdkClient } from "../src/pi-sdk/pi-sdk-client.js";

const client = new PiSdkClient({ label: "test", initMeta: {} });
const cwd = os.homedir();

test.after(async () => {
  await client.kill();
});

test("session/new creates independent concurrent sessions", { timeout: 120_000 }, async (t) => {
  const a = await client.request("session/new", { cwd, mcpServers: [] });
  const b = await client.request("session/new", { cwd, mcpServers: [] });
  assert.ok(a.sessionId, "no sessionId for A");
  assert.ok(b.sessionId, "no sessionId for B");
  assert.notEqual(a.sessionId, b.sessionId);
  // Both live side-by-side — the whole point of the SDK migration.
  assert.equal(client.agent.sessions.sessions.size, 2);
});

test("session/list returns stored sessions", { timeout: 120_000 }, async () => {
  const res = await client.request("session/list", { cwd: "" });
  assert.ok(Array.isArray(res.sessions));
});

test("session/close disposes only that session", { timeout: 60_000 }, async () => {
  const size = client.agent.sessions.sessions.size;
  assert.ok(size >= 2);
  const [firstId] = client.agent.sessions.sessions.keys();
  await client.request("session/close", { sessionId: firstId });
  assert.equal(client.agent.sessions.sessions.size, size - 1);
  assert.ok(!client.agent.sessions.sessions.has(firstId));
});

test("prompt on an unknown sessionId is rejected", { timeout: 60_000 }, async () => {
  await assert.rejects(
    client.request("session/prompt", {
      sessionId: "00000000-0000-0000-0000-000000000000",
      prompt: [{ type: "text", text: "hi" }],
    }),
    (e) => /Unknown sessionId/.test(e.message) || /Unknown sessionId/.test(JSON.stringify(e.data ?? ""))
  );
});
