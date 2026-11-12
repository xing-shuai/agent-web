// Integration test for the in-process pi SDK transport. Creates real SDK
// AgentSessions (reads ~/.pi/agent settings + extensions) but never sends
// a prompt, so no model/network access is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { SessionHub, pushWorkspace } from "../src/sessions.js";
import { PiSdkClient } from "../src/pi-sdk/pi-sdk-client.js";
import { PiAcpAgent, piHistoryEvents } from "../src/pi-sdk/pi-acp-agent.js";
import { foldEvents } from "../../web/src/sessionReducer.js";
import { SessionManager, AgentSession } from "@earendil-works/pi-coding-agent";
import { PiSdkProcess } from "../src/pi-sdk/pi-sdk-process.js";
import { TurnTelemetryTracker } from "../../web/src/turnTelemetry.js";

test("prompt receipts acknowledge, deduplicate, drain queues and retain failures", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-delivery-"));
  const acp = new EventEmitter(), calls = [], pending = [];
  acp.request = async (method, args) => {
    if (method === "session/new") return { sessionId: "delivery-session" };
    if (method === "session/prompt") {
      calls.push(args);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    }
    return {};
  };
  const hub = new SessionHub(acp, path.join(dir, "state.json"), { devinExt: false });
  t.after(() => { clearInterval(hub._stateTimer); clearInterval(hub._mirrorTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  const { sessionId } = await hub.createSession(dir);
  const messages = [], socket = { readyState: 1, send: (raw) => messages.push(JSON.parse(raw)) };
  hub.subscribe(socket, sessionId, dir);
  const blocks = [{ type: "text", text: "first" }];
  const first = hub.submitPrompt(sessionId, dir, blocks, "request-1");
  const duplicate = hub.submitPrompt(sessionId, dir, blocks, "request-1");
  assert.equal(first, duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(hub.promptStatus(sessionId, "request-1").status, "accepted");
  await assert.rejects(hub.submitPrompt(sessionId, dir, [{ type: "text", text: "changed" }], "request-1"), /不匹配/);
  const queuedBlocks = [{ type: "text", text: "queued" }];
  const queued = await hub.submitPrompt(sessionId, dir, queuedBlocks, "request-2");
  assert.ok(queued.queued);
  assert.equal(hub.queueView(sessionId)[0].requestId, "request-2");
  await hub.submitPrompt(sessionId, dir, queuedBlocks, "request-2");
  assert.equal(hub.queueView(sessionId).length, 1, "reconnecting does not queue a duplicate");
  pending[0].resolve({ stopReason: "end_turn" }); await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(hub.promptStatus(sessionId, "request-1").status, "completed");
  assert.equal(hub.promptStatus(sessionId, "request-2").status, "accepted");
  pending[1].resolve({ stopReason: "end_turn" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hub.promptStatus(sessionId, "request-2").status, "completed");
  const failed = hub.submitPrompt(sessionId, dir, blocks, "request-3");
  await new Promise((resolve) => setImmediate(resolve));
  const rejected = assert.rejects(failed, /fixture failure/);
  pending[2].reject(new Error("fixture failure")); await rejected;
  assert.equal(hub.promptStatus(sessionId, "request-3").status, "failed");
  await assert.rejects(hub.submitPrompt(sessionId, dir, blocks, "request-3"), /fixture failure/);
  assert.equal(calls.length, 3, "a failed receipt is not silently re-executed");
  const fourth = hub.submitPrompt(sessionId, dir, blocks, "request-4");
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await hub.submitPrompt(sessionId, dir, queuedBlocks, "request-5");
  assert.ok(hub.removeQueued(sessionId, cancelled.queueId));
  assert.equal(hub.promptStatus(sessionId, "request-5").status, "cancelled");
  pending[3].resolve({ stopReason: "end_turn" }); await fourth;
  assert.equal(calls.length, 4, "withdrawing a queued receipt never executes it");
  assert.equal(hub.promptStatus("another-session", "request-1").status, "unknown");
  assert.ok(messages.some((m) => m.type === "prompt_delivery" && m.status === "queued"));
});

test("Pi reload replays full recorded branch across compaction without expanding model context", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-pi-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir);
  let timestamp = Date.now();
  const user = (text) => manager.appendMessage({ role: "user", content: text, timestamp: timestamp++ });
  const assistant = (text) => manager.appendMessage({ role: "assistant", content: [{ type: "text", text }],
    api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } }, stopReason: "stop", timestamp: timestamp++ });
  user("original early question"); const common = assistant("original early answer");
  user("abandoned branch question"); assistant("abandoned branch answer");
  manager.branch(common);
  const recent = user("recent question"); assistant("recent answer");
  manager.appendCompaction("first context summary", recent, 20000);
  const latest = user("latest question"); assistant("latest answer");
  manager.appendCompaction("second context summary", latest, 25000);
  manager.appendContextEdit(latest, null);
  assistant("after compaction answer");
  const file = manager.getSessionFile(), saved = fs.readFileSync(file, "utf8");
  const reopened = SessionManager.open(file);
  const context = reopened.buildSessionContext().messages;
  assert.ok(context.some((m) => m.role === "compactionSummary"), "model still receives summaries");
  assert.ok(!JSON.stringify(context).includes("original early question"));
  assert.ok(!JSON.stringify(context).includes("latest question"), "context-only edits still apply to the model");
  const proc = new PiSdkProcess({});
  Object.assign(proc, {
    session: { sessionManager: reopened, messages: context },
    getState: async () => ({ thinkingLevel: "off" }),
    getAvailableModels: async () => ({ models: [] }),
    getAvailableThinkingLevels: async () => ["off"],
    getCommands: async () => ({ commands: [] }),
  });
  const transcript = (await proc.getHistoryMessages()).messages;
  assert.equal(transcript.length, 7);
  assert.ok(!JSON.stringify(transcript).includes("abandoned branch"), "sibling branches must not leak into replay");
  const acp = new EventEmitter(), agent = Object.create(PiAcpAgent.prototype), broadcasts = [];
  Object.assign(agent, {
    sessions: { close() {} }, store: { upsert() {} },
    findStoredSession: async () => ({ sessionFile: file }),
    restoreSession: async () => ({ sessionId: "compacted-history", proc, publishContextUsage: async () => {} }),
    conn: { sessionUpdate: async (params) => acp.emit("sessionUpdate", params.sessionId, params.update) },
  });
  acp.request = async (method, params) => method === "session/load" ? agent.loadSession(params) : {};
  const hub = new SessionHub(acp, path.join(dir, "web-state.json"), { agent: "pi", devinExt: false });
  t.after(() => { clearInterval(hub._stateTimer); clearInterval(hub._mirrorTimer); });
  hub.subscribe({ readyState: 1, send: (raw) => broadcasts.push(JSON.parse(raw)) }, "compacted-history", dir);
  await hub.ensureAttached("compacted-history", dir);
  const history = broadcasts.find((message) => message.type === "history");
  assert.ok(history?.attached, "cold attachment sends a consolidated history to the browser");
  const items = foldEvents(history.events).items;
  assert.deepEqual(items.filter((item) => item.kind !== "compaction").map((item) => item.text), ["original early question", "original early answer", "recent question", "recent answer", "latest question", "latest answer", "after compaction answer"]);
  const boundaries = items.filter((item) => item.kind === "compaction");
  assert.equal(boundaries.length, 2);
  assert.equal(boundaries[0].summary, "first context summary");
  assert.equal(boundaries[1].tokensBefore, 25000);
  assert.ok(Number.isFinite(boundaries[1].at));
  assert.equal(boundaries[1].estimatedTokensAfter, undefined, "historical token estimates are not invented");
  assert.deepEqual((await proc.getMessages()).messages, context, "history replay never expands model context");
  assert.equal(fs.readFileSync(file, "utf8"), saved, "history loading never rewrites persisted entries");
});

test("Pi delivery cache coalesces token deltas and cumulative tools rather than evicting history at 8000 updates", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-")), acp = new EventEmitter();
  const hub = new SessionHub(acp, path.join(dir, "state.json"), { agent: "pi", devinExt: false });
  t.after(() => { clearInterval(hub._stateTimer); clearInterval(hub._mirrorTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  const s = hub.subscribe({ readyState: 1, send() {} }, "cache", dir); s.attached = true;
  const emit = (update) => acp.emit("sessionUpdate", s.id, update);
  emit({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "must remain visible" } });
  for (let i = 0; i < 16000; i++) emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "x" } });
  for (const text of ["\uD83D", "\uDE42"]) emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
  emit({ sessionUpdate: "tool_call", toolCallId: "shell", title: "bash", rawInput: { command: "printf ab" }, status: "in_progress" });
  emit({ sessionUpdate: "tool_call_update", toolCallId: "shell", _meta: { terminal_output: { data: "a" } } });
  emit({ sessionUpdate: "tool_call_update", toolCallId: "shell", _meta: { terminal_output: { data: "b" }, terminal_exit: { exit_code: 0 } }, status: "completed" });
  const items = foldEvents(s.events).items;
  assert.equal(items[0].text, "must remain visible"); assert.equal(items[1].text, "x".repeat(16000) + "🙂");
  assert.equal(items[2].content[0].content.text, "ab"); assert.equal(items[2].exitCode, 0);
  assert.equal(s.events.length, 3); assert.ok(!s.historyTruncated);
  assert.equal(s.eventBytes, s.events.reduce((total, event) => total + JSON.stringify(event.update).length, 0));
  const revision = s.eventRevision;
  emit({ sessionUpdate: "tool_call_update", toolCallId: "shell", rawOutput: { final: true } });
  assert.equal(s.events.length, 3); assert.ok(s.eventRevision > revision, "coalesced snapshots still invalidate browser history fingerprints");
});

test("Pi rebuilds an evicted transcript from the raw active branch plus the live tail without reloading or restarting", { timeout: 30000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-evicted-history-")), manager = SessionManager.create(dir, dir);
  const acp = new EventEmitter(), hub = new SessionHub(acp, path.join(dir, "web.json"), { agent: "pi", devinExt: false });
  t.after(() => { clearInterval(hub._stateTimer); clearInterval(hub._mirrorTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  const s = hub.subscribe({ readyState: 1, send() {} }, "history-live", dir); s.attached = true; s.prompting = 1;
  const sdk = Object.create(PiSdkClient.prototype);
  sdk.agent = { sessions: { maybeGet: () => ({ cwd: dir, proc: { session: { sessionManager: manager } } }) } };
  acp.recordedHistorySnapshot = sdk.recordedHistorySnapshot.bind(sdk);
  acp.request = () => { throw new Error("must never session/load or restart an active turn"); };
  let stamp = Date.now();
  const messages = [];
  const append = (message) => {
    manager.appendMessage({ ...message, timestamp: stamp++ });
    const entry = manager.getEntry(manager.getLeafId()); messages.push(entry.message);
    for (const { update } of piHistoryEvents({ entries: [entry], messages }, dir)) acp.emit("sessionUpdate", s.id, update);
  };
  append({ role: "user", content: "the earliest retained question" });
  append({ role: "assistant", content: [{ type: "text", text: "the earliest recorded answer" }] });
  // More finalized blocks than either UI render paging or the delivery cache.
  for (let i = 0; i < 4100; i++) append({ role: "assistant", content: [{ type: "text", text: `recorded ${i}\n` }] });
  append({ role: "user", content: [{ type: "text", text: "current question" }, { type: "image", data: "YQ==", mimeType: "image/png" }] });
  const userEvent = s.events.findLast((e) => e.update.sessionUpdate === "user_message_chunk" && e.update.content.type === "text");
  userEvent.update._meta = { "devin-web/requestId": "live-receipt" };
  append({ role: "assistant", content: [{ type: "toolCall", id: "parallel-a", name: "read", arguments: { path: "a" } }, { type: "toolCall", id: "parallel-b", name: "bash", arguments: { command: "long work" } }] });
  for (const id of ["parallel-a", "parallel-b"]) acp.emit("sessionUpdate", s.id, { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", content: [{ type: "content", content: { type: "text", text: `partial ${id}` } }] });
  append({ role: "toolResult", toolCallId: "parallel-a", toolName: "read", content: [{ type: "text", text: "completed A" }], isError: false });
  acp.emit("sessionUpdate", s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "uncommitted live answer" } });
  assert.ok(s.historyTruncated); assert.ok(s.events.length <= 8000);
  assert.ok(!foldEvents(s.events).items.some((item) => item.text === "the earliest retained question"));
  const saved = fs.readFileSync(manager.getSessionFile(), "utf8"), before = s.events.length;
  const restored = foldEvents(hub.historyEvents(s.id)).items;
  assert.equal(restored[0].text, "the earliest retained question");
  assert.ok(restored.some((item) => item.text?.includes("the earliest recorded answer")));
  assert.equal(restored.at(-1).text, "uncommitted live answer", "in-progress text is retained once even though it is not on disk");
  const current = restored.find((item) => item.kind === "user" && item.text === "current question");
  assert.equal(current.deliveryId, "live-receipt"); assert.equal(current.images.length, 1);
  const pending = restored.find((item) => item.toolCallId === "parallel-b");
  assert.equal(pending.status, "in_progress"); assert.equal(pending.content[0].content.text, "partial parallel-b");
  assert.equal(restored.find((item) => item.toolCallId === "parallel-a").status, "completed");
  assert.equal(s.events.length, before, "full recovery does not turn the bounded cache into an unbounded transcript");
  assert.equal(s.prompting, 1); assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8"), saved);
  const common = manager.getBranch()[1].id;
  manager.branch(common);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "different active branch" }], timestamp: stamp++ });
  const changed = foldEvents(hub.historyEvents(s.id)).items;
  assert.ok(changed.some((item) => item.text?.includes("different active branch")));
  assert.ok(!JSON.stringify(changed).includes("current question"), "stale fences never bring an abandoned branch back");
});

test("cold pi history preserves task arguments and completed Todo state", async () => {
  const result = (toolCallId, toolName, text, isError = false) => ({ role: "toolResult", toolCallId, toolName, isError, content: [{ type: "text", text }] });
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "create", name: "TaskCreate", arguments: { subject: "Restore Todo" } }] },
    result("create", "TaskCreate", "Task #1 created successfully: Restore Todo"),
    { role: "assistant", content: [{ type: "toolCall", id: "update", name: "TaskUpdate", arguments: { taskId: "1", status: "completed" } }] },
    result("update", "TaskUpdate", "Updated task #1 status"),
    { role: "assistant", content: [{ type: "toolCall", id: "failed", name: "TaskUpdate", arguments: { taskId: "1", status: "pending" } }] },
    result("failed", "TaskUpdate", "Error", true),
    { role: "assistant", content: [{ type: "thinking", thinking: "recorded thought" }, { type: "thinking", thinking: "redacted secret", redacted: true }, { type: "toolCall", id: "bash-history", name: "bash", arguments: { command: "printf actual; exit 7" } }] },
    result("bash-history", "bash", "actual\n\nCommand exited with code 7", true),
  ];
  const events = [];
  const proc = {
    getState: async () => ({ thinkingLevel: "off" }),
    getAvailableModels: async () => ({ models: [] }),
    getAvailableThinkingLevels: async () => ["off"],
    getHistoryMessages: async () => ({ messages }),
    getCommands: async () => ({ commands: [] }),
  };
  const agent = Object.create(PiAcpAgent.prototype);
  Object.assign(agent, {
    sessions: { close() {} }, store: { upsert() {} },
    findStoredSession: async () => ({ sessionFile: "/unused.jsonl" }),
    restoreSession: async () => ({ sessionId: "history-test", proc, publishContextUsage: async () => {} }),
    conn: { sessionUpdate: async ({ update }) => events.push({ update }) },
  });
  await agent.loadSession({ sessionId: "history-test", cwd: process.cwd(), mcpServers: [] });
  assert.equal(events.find((e) => e.update.toolCallId === "update").update.rawInput.status, "completed");
  assert.equal(events.findLast((e) => e.update.toolCallId === "failed").update.status, "failed");
  const history = foldEvents(events);
  assert.equal(history.items.find((it) => it.kind === "thought").text, "recorded thought");
  const bash = history.items.find((it) => it.toolCallId === "bash-history");
  assert.equal(bash.rawInput.command, "printf actual; exit 7");
  assert.equal(bash.title, "printf actual; exit 7");
  assert.equal(bash.status, "failed");
  assert.equal(bash.content[0].content.text, "actual\n\nCommand exited with code 7");
  assert.equal(bash.exitCode, 7, "persisted shell footer preserves the real nonzero exit code");
  assert.ok(history.items.findIndex((it) => it.kind === "thought") < history.items.indexOf(bash));
  assert.ok(!JSON.stringify(history.items).includes("redacted secret"));
  assert.deepEqual(foldEvents(events).todos.map(({ id, subject, status }) => ({ id, subject, status })), [
    { id: "1", subject: "Restore Todo", status: "completed" },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 10)); // deferred command publication
});

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

test("SDK JSON bridge retains generated tool arguments and renders real thought, output and compaction events", async () => {
  const PiSession = [...client.agent.sessions.sessions.values()][0].constructor;
  let forward;
  const updates = [], jsonEvents = [];
  const fakeSession = { bindExtensions: async () => {}, subscribe: (fn) => { forward = fn; return () => {}; } };
  const proc = new PiSdkProcess({ session: fakeSession });
  proc.onEvent((event) => jsonEvents.push(event));
  const bridge = new PiSession({ sessionId: "stream-correctness", cwd, proc,
    conn: { sessionUpdate: async ({ update }) => updates.push(update) } });
  await proc.rebindSession();
  const toolCall = { type: "toolCall", id: "bash-live", name: "bash", arguments: { command: "printf actual; exit 7" } };
  const delta = (assistantMessageEvent) => forward({ type: "message_update", message: { role: "assistant", content: [toolCall] }, assistantMessageEvent });
  delta({ type: "thinking_delta", delta: "actual live thought", contentIndex: 0 });
  delta({ type: "toolcall_start", contentIndex: 0, partial: { content: [toolCall] } });
  toolCall.arguments.command = "printf changed; exit 7";
  assert.equal(jsonEvents.find((event) => event.assistantMessageEvent?.toolCall).assistantMessageEvent.toolCall.arguments.command, "printf actual; exit 7", "queued tool blocks are immutable snapshots");
  delta({ type: "toolcall_delta", delta: "7}", contentIndex: 0, partial: { content: [toolCall] } });
  forward({ type: "tool_execution_start", toolCallId: "bash-live", toolName: "bash", args: toolCall.arguments });
  forward({ type: "tool_execution_update", toolCallId: "bash-live", partialResult: { content: [{ type: "text", text: "part" }] } });
  forward({ type: "tool_execution_update", toolCallId: "bash-live", partialResult: { content: [{ type: "text", text: "part complete" }] } });
  forward({ type: "tool_execution_end", toolCallId: "bash-live", isError: true, result: { content: [{ type: "text", text: "part complete" }], structuredContent: { exit_code: 7 } } });
  forward({ type: "compaction_start", reason: "threshold" });
  forward({ type: "compaction_end", reason: "threshold", result: { summary: "real summary", tokensBefore: 42000, estimatedTokensAfter: 8000, firstKeptEntryId: "kept" }, aborted: false });
  await bridge.flushEmits();
  const items = foldEvents(updates.map((update) => ({ update }))).items;
  assert.equal(items.find((item) => item.kind === "thought").text, "actual live thought");
  const bash = items.find((item) => item.kind === "tool");
  assert.equal(bash.rawInput.command, "printf changed; exit 7");
  assert.equal(bash.toolName, "bash");
  assert.equal(bash.content[0].content.text, "part complete", "cumulative output never duplicates fragments");
  assert.equal(bash.exitCode, 7);
  assert.equal(bash.status, "failed");
  const nodes = items.filter((item) => item.kind === "compaction");
  assert.equal(nodes.length, 1, "start and end update one boundary");
  assert.equal(nodes[0].summary, "real summary");
  assert.equal(nodes[0].estimatedTokensAfter, 8000);
  assert.equal(nodes[0].status, "completed");
  forward({ type: "compaction_start", reason: "manual" });
  forward({ type: "compaction_end", reason: "manual", aborted: true });
  await bridge.flushEmits();
  assert.equal(foldEvents(updates.map((update) => ({ update }))).items.at(-1).status, "cancelled", "cancellation is not reported as successful compaction");
});

test("SDK context samples use the compacted projection and identify provider versus estimated tokens", async () => {
  const manager = SessionManager.inMemory();
  let timestamp = Date.now();
  const user = manager.appendMessage({ role: "user", content: "retained question", timestamp: timestamp++ });
  const assistant = (tokens) => manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer" }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: timestamp++,
    usage: { input: tokens - 10, output: 10, totalTokens: tokens, cacheRead: 0, cacheWrite: 0 } });
  assistant(284050);
  const proc = new PiSdkProcess({});
  proc.session = { sessionManager: manager, _limitsModel: () => ({ contextWindow: 360000 }), getContextUsage: AgentSession.prototype.getContextUsage };
  assert.equal((await proc.getContextUsage()).tokens, 284050);
  manager.appendCompaction("small summary", user, 284050);
  assert.equal(proc.session.getContextUsage().tokens, null, "the unmodified SDK has no post-compaction provider sample yet");
  let sample = await proc.getContextUsage();
  assert.equal(sample.estimated, true); assert.equal(sample.source, "compaction");
  assert.ok(sample.tokens > 0 && sample.tokens < 1000, "the pre-compaction assistant usage is not trusted");
  assistant(33309);
  sample = await proc.getContextUsage();
  assert.equal(sample.tokens, 33309); assert.equal(sample.estimated, false); assert.equal(sample.source, "provider");
  manager.appendMessage({ role: "toolResult", toolCallId: "x", toolName: "read", content: [{ type: "text", text: "new tool output" }], timestamp: timestamp++ });
  sample = await proc.getContextUsage();
  assert.ok(sample.tokens > 33309); assert.equal(sample.estimated, true); assert.equal(sample.source, "mixed");
  manager.appendContextEdit(user, null);
  sample = await proc.getContextUsage();
  assert.ok(sample.tokens < 1000, "context edits invalidate older usage and do not recover omitted transcript text");
  const before = JSON.stringify(manager.getEntries());
  await proc.getContextUsage();
  assert.equal(JSON.stringify(manager.getEntries()), before, "sampling never rewrites session entries");
});

test("pi context usage refreshes after compaction and every response, rejecting delayed stale queries", async () => {
  const PiSession = [...client.agent.sessions.sessions.values()][0].constructor;
  let forward, context = { tokens: 284050, contextWindow: 360000, estimated: false, source: "provider" };
  const updates = [];
  const proc = { onEvent: (fn) => { forward = fn; }, getContextUsage: async () => context,
    getSessionStats: () => { throw new Error("live context must not scan lifetime billing totals"); } };
  const bridge = new PiSession({ sessionId: "context-refresh", cwd, proc, conn: { sessionUpdate: async ({ update }) => updates.push(update) } });
  const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); await bridge.flushEmits(); };
  const samples = () => updates.filter((update) => update.sessionUpdate === "usage_update");
  await bridge.publishContextUsage();
  forward({ type: "compaction_start", reason: "threshold" });
  forward({ type: "compaction_end", reason: "threshold", result: { tokensBefore: 284050, estimatedTokensAfter: 33309 } });
  context = { ...context, tokens: 33309, estimated: true, source: "compaction" };
  await flush();
  assert.equal(samples().at(-1).used, 33309);
  assert.equal(samples().at(-1)._meta.piAcp.contextUsage.estimated, true);
  forward({ type: "message_end", message: { role: "assistant", usage: { input: 40000, output: 2000 } } });
  context = { ...context, tokens: 42000, estimated: false, source: "provider" };
  await flush();
  assert.equal(samples().at(-1).used, 42000, "sampling waits for persistence and does not wait for agent_settled");
  assert.equal(samples().at(-1)._meta.piAcp.contextUsage.intermediate, true);
  forward({ type: "turn_end" });
  context = { ...context, tokens: 43000, estimated: true, source: "mixed" };
  await flush();
  assert.equal(samples().at(-1).used, 43000, "new tool results are estimated after the tool batch");
  let release;
  proc.getContextUsage = () => new Promise((resolve) => { release = resolve; });
  const delayed = bridge.publishContextUsage();
  await Promise.resolve();
  proc.getContextUsage = async () => ({ tokens: 9000, contextWindow: 360000, estimated: true, source: "compaction" });
  await bridge.publishContextUsage();
  release({ tokens: 300000, contextWindow: 360000 }); await delayed;
  assert.equal(samples().at(-1).used, 9000, "a slow older query cannot overwrite the latest sample");
  const count = samples().length;
  forward({ type: "compaction_end", aborted: true }); await flush();
  assert.equal(samples().length, count, "cancelled compaction does not reset usage");
});

test("pi bridge publishes open-tui telemetry from JSON events without partial messages", async () => {
  const PiSession = [...client.agent.sessions.sessions.values()][0].constructor;
  let forward, ms = 0;
  const updates = [];
  const bridge = new PiSession({ sessionId: "telemetry-test", cwd, proc: { onEvent: (fn) => { forward = fn; } },
    conn: { sessionUpdate: async ({ update }) => updates.push(update) } });
  bridge.telemetry = new TurnTelemetryTracker(() => ms);
  forward({ type: "agent_start" }); forward({ type: "turn_start" });
  forward({ type: "message_start", message: { role: "assistant" } });
  ms = 100; forward({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "abcd" } });
  ms = 1100; forward({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "x".repeat(40) } });
  ms = 2000; forward({ type: "message_end", message: { role: "assistant", usage: { input: 15, output: 40 } } });
  ms = 5000; forward({ type: "turn_end" });
  ms = 6000; forward({ type: "agent_settled" });
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.flushEmits();
  const telemetry = updates.map((u) => u._meta?.piAcp?.telemetry).filter(Boolean);
  assert.ok(telemetry.some((t) => t.live?.stale && t.live.tps === 5.3));
  const final = telemetry.find((t) => t.final)?.final;
  assert.equal(final.tps, 20);
  assert.equal(final.outputTokens, 40);
  assert.equal(final.generationMs, 2000);
  assert.equal(final.totalMs, 6000);
  assert.equal(foldEvents(updates.map((update) => ({ update }))).lastTurn.tps, 20);
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

test("deletion receipts wait for actual RPC, deduplicate, preserve failures and block new attachment", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-delete-")), acp = new EventEmitter();
  const calls = []; let resolveDelete, rejectDelete;
  acp.request = (method, args, timeout) => {
    if (method === "session/delete") { calls.push({ args, timeout }); return new Promise((resolve, reject) => { resolveDelete = resolve; rejectDelete = reject; }); }
    return Promise.resolve({ sessions: [] });
  };
  const hub = new SessionHub(acp, path.join(dir, "state.json"), { devinExt: false });
  t.after(() => { clearInterval(hub._stateTimer); clearInterval(hub._mirrorTimer); clearTimeout(hub._refreshT); clearTimeout(hub._saveTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  hub.state.sessions.target = { title: "retained until success" };
  hub.sessions.set("target", { attached: true, queue: [], subscribers: new Set() });
  const first = hub.deleteSession("target");
  assert.equal(hub.deletionStatus("target").status, "deleting");
  assert.equal(hub.deleteSession("target"), first);
  await assert.rejects(hub.ensureAttached("target", dir), /正在删除/);
  assert.ok(hub.state.sessions.target);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls.length, 1); assert.equal(calls[0].timeout, 0);
  const rejected = assert.rejects(first, /permission denied/); rejectDelete(new Error("permission denied")); await rejected;
  assert.equal(hub.deletionStatus("target").status, "failed");
  assert.ok(hub.state.sessions.target); assert.equal(hub.sessions.get("target").deleting, false);
  const retry = hub.deleteSession("target"); await new Promise((resolve) => setImmediate(resolve));
  resolveDelete({}); await retry;
  assert.equal(hub.deletionStatus("target").status, "deleted"); assert.ok(!hub.state.sessions.target);
  await hub.deleteSession("target"); assert.equal(calls.length, 2, "confirmed deletion never repeats the agent command");
  assert.equal(hub.deletionStatus("unseen").status, "unknown", "missing receipts are not proof of deletion");
  hub.deletions.get("target").at -= 86400001;
  assert.equal(hub.deletionStatus("target").status, "unknown", "completed receipts expire even without new deletes");
  const cold = hub.deleteSession("cold");
  await assert.rejects(hub.ensureAttached("cold", dir), /正在删除/, "an unloaded target cannot be restored mid-delete");
  await new Promise((resolve) => setImmediate(resolve)); resolveDelete({}); await cold;

});

test("Pi deletion uses known file, waits for load/cancel/dispose and never swallows unlink failure", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delete-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "target.jsonl"), other = path.join(dir, "other.jsonl"); fs.writeFileSync(target, "target"); fs.writeFileSync(other, "other");
  const order = []; let finishLoad;
  const load = new Promise((resolve) => { finishLoad = resolve; });
  const live = { cancel: async () => { order.push("cancel"); assert.ok(fs.existsSync(target)); },
    proc: { dispose: async () => { order.push("dispose"); assert.ok(fs.existsSync(target)); } } };
  const agent = Object.create(PiAcpAgent.prototype);
  agent.restoringSessions = new Map([["target", load]]);
  agent.sessions = { sessions: new Map([["target", live], ["other", {}]]), maybeGet: (id) => agent.sessions.sessions.get(id) };
  agent.store = { get: (id) => ({ sessionFile: id === "target" ? target : other }), delete: (id) => order.push(`store:${id}`) };
  const work = agent.deleteSession({ sessionId: "target" });
  await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(order, []);
  finishLoad(); await work;
  assert.deepEqual(order, ["cancel", "dispose", "store:target"]); assert.ok(!fs.existsSync(target)); assert.equal(fs.readFileSync(other, "utf8"), "other");
  assert.ok(agent.sessions.sessions.has("other"));
  fs.mkdirSync(target); order.length = 0;
  await assert.rejects(agent.deleteSession({ sessionId: "target" }), /无法删除 Pi 会话文件/);
  assert.deepEqual(order, [], "failed unlink retains the mapping and reports failure");
  fs.rmdirSync(target); await agent.deleteSession({ sessionId: "target" }); assert.deepEqual(order, ["store:target"], "ENOENT remains idempotent");
});

test("cold Pi deletion reads only headers and never treats discovery failures as deleted", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cold-delete-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const sessions = path.join(dir, "sessions"), workspace = path.join(sessions, "project"); fs.mkdirSync(workspace, { recursive: true });
  const file = path.join(workspace, "timestamp_cold.jsonl"), other = path.join(workspace, "other.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "session", id: "cold", cwd: dir }) + "\n" + "malformed unrelated transcript tail".repeat(10000));
  fs.writeFileSync(other, JSON.stringify({ type: "session", id: "other", cwd: dir }) + "\n");
  const agent = Object.create(PiAcpAgent.prototype), removed = [];
  agent.store = { get: () => null, delete: (id) => removed.push(id) };
  agent.sessions = { maybeGet: () => null };
  await agent.deleteSession({ sessionId: "cold" }); assert.ok(!fs.existsSync(file)); assert.ok(fs.existsSync(other));
  assert.deepEqual(removed, ["cold"]);
  fs.writeFileSync(file, "broken header\n");
  await assert.rejects(agent.deleteSession({ sessionId: "cold" }), /文件头损坏/); assert.ok(fs.existsSync(file)); assert.deepEqual(removed, ["cold"]);
  fs.rmSync(sessions, { recursive: true }); fs.writeFileSync(sessions, "not a directory");
  await assert.rejects(agent.deleteSession({ sessionId: "cold" }), /ENOTDIR/); assert.deepEqual(removed, ["cold"]);
});

test("workspaces are MRU-ordered, capped, and only persisted on change", () => {
  assert.deepEqual(pushWorkspace(["/a", "/b"], "/b"), ["/b", "/a"], "a later workspace moves to the front");
  assert.equal(pushWorkspace(["/a", "/b"], "/a"), null, "already-first order persists nothing");
  assert.deepEqual(pushWorkspace(["/a"], "/c"), ["/c", "/a"], "a new workspace lands first");
  assert.equal(pushWorkspace(Array.from({ length: 50 }, (_, i) => `/w${i}`), "/new").length, 50, "the list is capped");
  assert.deepEqual(pushWorkspace(Array.from({ length: 50 }, (_, i) => `/w${i}`), "/new").slice(0, 2), ["/new", "/w0"]);
});

// Execute the SDK's actual navigation algorithm with an offline extension
// runner. Tests never call a model, restore a session, or touch real workspaces.
function treeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tree-")), manager = SessionManager.create(dir, dir);
  let clock = Date.now();
  const append = (role, content) => manager.appendMessage({ role, content, timestamp: clock++ });
  const first = append("user", "first question"), common = append("assistant", [{ type: "text", text: "common answer" }]);
  const edit = append("user", [{ type: "text", text: "edit this question" }, { type: "image", data: "c2VjcmV0LWltYWdl", mimeType: "image/png" }]);
  const original = append("assistant", [{ type: "text", text: "original answer" }, { type: "thinking", thinking: "recorded thought", thinkingSignature: "private-provider-signature" }, { type: "thinking", thinking: "redacted secret", redacted: true }]);
  manager.branch(common);
  append("user", "alternate question");
  const alternate = append("assistant", [{ type: "text", text: "alternate answer" }]);
  const acp = new PiSdkClient(), broadcasts = [], hooks = [];
  const native = { sessionManager: manager, isStreaming: false,
    get isCompacting() { return !!this._branchSummaryAbortController; },
    model: { id: "offline" }, pendingMessageCount: 0,
    _extensionRunner: { hasHandlers: () => true, emit: async (event) => { hooks.push(event); return await native.hook?.(event); } },
    _refreshFinalizedContext: () => { native.context = manager.buildSessionContext().messages; },
    _restoreToolsFromTranscript() {}, _resolveIdleWaitIfIdle() {},
    navigateTree: AgentSession.prototype.navigateTree,
  };
  native._refreshFinalizedContext();
  const loaded = { cwd: dir, proc: { session: native }, flushEmits: async () => {}, publishContextUsage: async () => {
    acp.emit("sessionUpdate", "target", { sessionUpdate: "usage_update", used: 100, size: 10000, _meta: { piAcp: { contextUsage: { estimated: true, source: "estimate" } } } });
  } };
  acp.agent = { sessions: { maybeGet: (id) => id === "target" ? loaded : null } };
  acp.request = async (method, args) => { assert.equal(args.sessionId, "other", `unexpected ${method} on target`); return {}; };
  acp.notify = () => { throw new Error("tree operations must not cancel"); };
  const hub = new SessionHub(acp, path.join(dir, "web.json"), { agent: "pi", devinExt: false });
  const s = hub.subscribe({ readyState: 1, send: (raw) => broadcasts.push(JSON.parse(raw)) }, "target", dir); s.attached = true;
  t.after(() => { clearInterval(hub._stateTimer); clearInterval(hub._mirrorTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  return { manager, acp, native, loaded, hub, s, broadcasts, hooks, first, common, edit, original, alternate };
}

test("Pi tree reads all branches without side effects, binary data or redacted/provider secrets", (t) => {
  const f = treeFixture(t), { manager, acp, hub, loaded, original } = f;
  const before = fs.readFileSync(manager.getSessionFile(), "utf8"), leaf = manager.getLeafId(), context = JSON.stringify(f.native.context);
  const tree = hub.sessionTree("target");
  assert.equal(tree.nodes.length, 6); assert.equal(tree.leafId, f.alternate);
  assert.match(tree.version, /^[a-f0-9]{64}$/); assert.ok(tree.nodes.some((node) => node.id === original));
  const preview = hub.sessionTree("target", original);
  assert.equal(preview.thinking, "recorded thought"); assert.equal(preview.text, "original answer");
  assert.equal(hub.sessionTree("target", f.edit).images, 1);
  assert.ok(!JSON.stringify({ tree, preview }).match(/c2VjcmV0LWltYWdl|private-provider-signature|redacted secret/));
  loaded.pendingTurn = {}; assert.equal(hub.sessionTree("target").busy, true); loaded.pendingTurn = null;
  assert.throws(() => acp.getSessionTree("cold"), { code: "TREE_NOT_LOADED" });
  assert.throws(() => acp.getSessionTreeNode("target", "missing"), { code: "TREE_NODE_MISSING" });
  assert.equal(manager.getLeafId(), leaf); assert.equal(JSON.stringify(f.native.context), context);
  assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8"), before);
});

test("Pi tree navigation keeps siblings, persists the cursor and replaces UI history from the raw active branch", async (t) => {
  const { manager, hub, native, broadcasts, edit, first, alternate } = treeFixture(t);
  const before = fs.readFileSync(manager.getSessionFile(), "utf8"), version = hub.sessionTree("target").version;
  const result = await hub.navigateTree("target", { targetId: edit, version });
  assert.equal(result.editorText, "edit this question"); assert.equal(result.images, 1); assert.equal(result.historyGen, 1);
  assert.deepEqual(native.context.map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual(foldEvents(hub.historyEvents("target")).items.map((item) => item.text), ["first question", "common answer"]);
  assert.equal(broadcasts.filter((message) => message.type === "history").length, 1);
  assert.equal(broadcasts.find((message) => message.type === "history").gen, 1);
  const saved = fs.readFileSync(manager.getSessionFile(), "utf8");
  assert.ok(saved.startsWith(before), "old JSONL entries are never rewritten or removed");
  assert.equal(SessionManager.open(manager.getSessionFile()).getLeafId(), result.leafId, "cursor survives SDK unload/reopen");
  assert.equal(manager.getEntry(result.leafId).customType, "devin-web.tree-cursor");
  await assert.rejects(hub.navigateTree("target", { targetId: alternate, version }), { code: "TREE_STALE" });
  assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8"), saved, "a stale replay cannot mutate a branch");
  await hub.navigateTree("target", { targetId: alternate, version: hub.sessionTree("target").version });
  assert.deepEqual(foldEvents(hub.historyEvents("target")).items.map((item) => item.text), ["first question", "common answer", "alternate question", "alternate answer"]);
  await hub.navigateTree("target", { targetId: first, version: hub.sessionTree("target").version });
  assert.equal(native.context.length, 0, "first-user selection returns to before the first message");
  assert.deepEqual(foldEvents(hub.historyEvents("target")).items, []);
  const reopened = SessionManager.open(manager.getSessionFile());
  assert.equal(reopened.getBranch().length, 1); assert.equal(reopened.getLeafEntry().parentId, null);
  assert.ok(hub.sessionTree("target").nodes.some((node) => node.id === edit), "abandoned branches remain browsable");
});

test("Pi tree navigation serializes target mutations, allows other sessions, and honors native cancellation and optional summary", async (t) => {
  const { hub, native, manager, s, edit, original, hooks } = treeFixture(t);
  for (const [flag, value] of [["isStreaming", true], ["pendingMessageCount", 1]]) {
    native[flag] = value;
    assert.equal(hub.sessionTree("target").busy, true);
    await assert.rejects(hub.navigateTree("target", { targetId: edit, version: hub.sessionTree("target").version }), { code: "TREE_BUSY" });
    native[flag] = flag === "isStreaming" ? false : 0;
  }
  let release;
  native.hook = async (event) => event.type === "session_before_tree" ? new Promise((resolve) => { release = resolve; }) : undefined;
  const options = { targetId: edit, version: hub.sessionTree("target").version }, work = hub.navigateTree("target", options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(s.treeNavigating); assert.equal(hub.sessionTree("target").busy, true);
  await assert.rejects(hub.navigateTree("target", options), { code: "TREE_BUSY" });
  await assert.rejects(hub.prompt("target", "/tmp", [{ type: "text", text: "must not send" }]), { code: "TREE_BUSY" });
  await assert.rejects(hub.cancel("target"), { code: "TREE_BUSY" });
  await assert.rejects(hub.closeSession("target"), { code: "TREE_BUSY" });
  assert.throws(() => hub.deleteSession("target"), { code: "TREE_BUSY" });
  await assert.rejects(hub.setConfigOption("target", "model", "new"), { code: "TREE_BUSY" });
  await hub.setConfigOption("other", "model", "new");
  const leaf = manager.getLeafId(), count = manager.getEntries().length;
  release({ cancel: true }); assert.equal((await work).cancelled, true);
  assert.equal(manager.getLeafId(), leaf); assert.equal(manager.getEntries().length, count); assert.equal(s.gen, 0);
  assert.ok(!s.treeNavigating); assert.equal(hooks[0].preparation.userWantsSummary, false);
  native.hook = async (event) => event.type === "session_before_tree" ? { summary: { summary: "offline supplied branch summary", details: {} } } : undefined;
  await hub.navigateTree("target", { targetId: original, version: hub.sessionTree("target").version, summarize: true });
  assert.equal(hooks.findLast((event) => event.type === "session_before_tree").preparation.userWantsSummary, true);
  const history = foldEvents(hub.historyEvents("target"));
  assert.equal(history.items.find((item) => item.kind === "branchSummary").summary, "offline supplied branch summary");
  assert.ok(native.context.some((message) => message.role === "branchSummary"));
});

test("Pi tree recovers authoritative history even when an extension fails after switching", async (t) => {
  const { hub, native, edit, s } = treeFixture(t);
  native.hook = async (event) => { if (event.type === "session_tree") throw new Error("extension failed after switching"); };
  await assert.rejects(hub.navigateTree("target", { targetId: edit, version: hub.sessionTree("target").version }), /extension failed/);
  assert.ok(!s.treeNavigating); assert.equal(s.gen, 1);
  assert.deepEqual(foldEvents(hub.historyEvents("target")).items.map((item) => item.text), ["first question", "common answer"]);
});

test("Pi tree history fences recover an evicted branch including a summary after its last message", async (t) => {
  const { hub, manager, s } = treeFixture(t);
  let stamp = Date.now();
  for (let i = 0; i < 4100; i++) {
    manager.appendMessage({ role: "user", content: `tree question ${i}`, timestamp: stamp++ });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `tree answer ${i}` }], timestamp: stamp++ });
  }
  const summary = manager.branchWithSummary(manager.getLeafId(), "summary after the final message");
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "must disappear from active history" }], timestamp: stamp++ });
  await hub.navigateTree("target", { targetId: summary, version: hub.sessionTree("target").version });
  assert.ok(s.historyTruncated); assert.ok(s.events.length <= 8000);
  const items = foldEvents(hub.historyEvents("target")).items;
  assert.ok(items.some((item) => item.text === "tree question 0"));
  assert.equal(items.at(-1).kind, "branchSummary");
  assert.equal(items.at(-1).summary, "summary after the final message");
  assert.ok(!JSON.stringify(items).includes("must disappear from active history"));
});

test("Pi tree refuses navigation when a prior config change or release is still in flight", async (t) => {
  const { hub, acp, s, edit } = treeFixture(t);
  let release;
  acp.request = async () => await new Promise((resolve) => { release = resolve; });
  const config = hub.setConfigOption("target", "model", "new-model");
  assert.equal(hub.sessionTree("target").busy, true);
  await assert.rejects(hub.navigateTree("target", { targetId: edit, version: hub.sessionTree("target").version }), { code: "TREE_BUSY" });
  release({}); await config; assert.equal(s.configuring, 0);
  const close = hub.closeSession("target");
  assert.equal(hub.sessionTree("target").busy, true);
  await assert.rejects(hub.navigateTree("target", { targetId: edit, version: hub.sessionTree("target").version }), { code: "TREE_BUSY" });
  release({}); await close; assert.equal(s.closing, false);
});

// Real upstream engine + the same SDK/ACP/Hub bridge as production. All model
// responses and credentials are local fixtures, never provider/network calls.
async function processFixture(t) {
  const { createAgentSessionServices, createAgentSessionFromServices, AgentSessionRuntime, SettingsManager, ModelRuntime, initTheme } = await import("@earendil-works/pi-coding-agent");
  const { createProcessResources, processSettingsForWeb } = await import("../src/pi-sdk/processes.js");
  const { createAssistantMessageEventStream } = await import(new URL("../../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-processes-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  initTheme("dark", false);
  const client = new PiSdkClient(); await client.ensureStarted();
  const hub = new SessionHub(client, path.join(root, "web.json"), { agent: "pi", devinExt: false });
  const hosts = [], children = [];
  const until = async (check) => { const deadline = Date.now() + 8000; while (!check()) { if (Date.now() > deadline) throw new Error("process fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } };
  t.after(async () => {
    clearInterval(hub._stateTimer); clearInterval(hub._mirrorTimer); clearTimeout(hub._saveTimer); clearTimeout(hub._refreshT);
    await client.kill();
    await until(() => children.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } }));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const host = async (name, sharedCwd, { globalPlugin = false } = {}) => {
    const cwd = sharedCwd || path.join(root, name); fs.mkdirSync(cwd, { recursive: true });
    if (globalPlugin) {
      const install = path.join(root, "npm/node_modules/@aliou"); fs.mkdirSync(install, { recursive: true });
      fs.symlinkSync(path.resolve(import.meta.dirname, "../../node_modules/@aliou/pi-processes"), path.join(install, "pi-processes"));
    }
    const { processes, resourceLoaderOptions } = createProcessResources();
    processes.events.on("processes:started", (info) => children.push(info.pid));
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, `${name}-auth.json`), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5"); assert.ok(model);
    await modelRuntime.setRuntimeApiKey("anthropic", "local-fixture-key");
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
      ...(globalPlugin ? { packages: ["npm:@aliou/pi-processes@0.13.6"] } : {}) });
    const services = await createAgentSessionServices({ cwd, agentDir: root, modelRuntime,
      settingsManager: processSettingsForWeb(settings),
      resourceLoaderOptions: { ...resourceLoaderOptions, noExtensions: !globalPlugin, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true } });
    services.processes = processes;
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(cwd, path.join(root, "sessions")), model, thinkingLevel: "off" });
    const runtime = new AgentSessionRuntime(session, services, async () => { throw new Error("unexpected replacement"); });
    const proc = new PiSdkProcess(runtime), requests = [];
    const h = { name, cwd, session, proc, processes, requests, settings, services, events: [], nextTool: null, delay: 0 }; hosts.push(h);
    let timestamp = Date.now();
    session.agent.streamFunction = (_model, context, options) => {
      requests.push(structuredClone(context));
      const next = h.nextTool; h.nextTool = null;
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: ++timestamp,
        stopReason: next ? "toolUse" : "stop", content: next ? [{ type: "toolCall", id: `${name}-${requests.length}`, name: "process", arguments: next }] : [{ type: "text", text: `local answer ${name}` }],
        usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } };
      let timer, ended = false;
      const finish = (aborted = false) => {
        if (ended) return; ended = true; clearTimeout(timer); options?.signal?.removeEventListener("abort", abort);
        if (aborted) { const error = { ...message, content: [], stopReason: "aborted" }; stream.push({ type: "error", reason: "aborted", error }); stream.end(error); }
        else { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); }
      };
      const abort = () => finish(true);
      if (options?.signal?.aborted) finish(true);
      else { options?.signal?.addEventListener("abort", abort, { once: true }); if (h.delay) timer = setTimeout(() => finish(), h.delay); else finish(); }
      return stream;
    };
    session.agent.getApiKey = () => "local-fixture-key";
    await proc.rebindSession();
    client.agent.sessions.getOrCreate(session.sessionId, { cwd, proc, conn: client.agent.conn, mcpServers: [] });
    h.id = session.sessionId;
    const s = hub.subscribe({ readyState: 1, send: (raw) => h.events.push(JSON.parse(raw)) }, h.id, cwd); s.attached = true;
    h.launch = async (taskName, command, notify) => {
      h.nextTool = { action: "start", name: taskName, command, ...(notify ? { notify } : {}) };
      await hub.prompt(h.id, cwd, [{ type: "text", text: `local fixture launch ${taskName}` }]);
      const result = session.messages.filter((m) => m.role === "toolResult" && m.toolName === "process").at(-1);
      assert.ok(result && !result.isError, JSON.stringify(result));
      return result.details.process;
    };
    return h;
  };
  return { root, client, hub, host, until, hosts };
}

test("managed Pi jobs resume only their owner, retain sessions, fence branches and stop independently of generation", { timeout: 30000 }, async (t) => {
  const { client, hub, host, until } = await processFixture(t), a = await host("A"), b = await host("B", a.cwd);
  const [pa, pb] = await Promise.all([a.launch("only-A", 'read token; printf "A_DONE\\n"'), b.launch("only-B", 'read token; printf "B_DONE\\n"')]);
  assert.equal(hub.processes(a.id).activeCount, 1); assert.equal(a.processes.busy, true);
  assert.equal(hub.processes(a.id).pending, false, "start reservations must leave at the tool result boundary");
  assert.ok(!hub.processes(a.id).processes.some((p) => p.id === pb.id));
  assert.throws(() => hub.processes(b.id, pa.id), { code: "PROCESS_MISSING" });
  await assert.rejects(hub.stopProcess(b.id, pa.id), { code: "PROCESS_MISSING" });
  await assert.rejects(hub.closeSession(a.id), { code: "PROCESS_BUSY" });
  await assert.rejects(client.request("session/load", { sessionId: a.id, cwd: a.cwd }), { code: "PROCESS_BUSY" });
  await assert.rejects(a.session.extensionRunner.createCommandContext().reload(), { code: "PROCESS_BUSY" });
  const first = a.session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
  await assert.rejects(hub.navigateTree(a.id, { targetId: first.id, version: hub.sessionTree(a.id).version }), { code: "TREE_BUSY" });
  assert.equal((await a.session.navigateTree(first.id, { summarize: false })).cancelled, true, "native extension navigation is guarded too");
  for (const [toolName, input] of [["bash", { command: "nohup sleep 30 &" }], ["process", { action: "start", command: "sleep 30 &" }]]) {
    const result = await a.session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "unmanaged", toolName, input });
    assert.equal(result.block, true);
  }
  // Actually interrupt a running model response, not just an idle session.
  a.delay = 1000;
  const interrupted = hub.prompt(a.id, a.cwd, [{ type: "text", text: "response to cancel" }]);
  await until(() => client.sessionActivity(a.id).running);
  await hub.cancel(a.id); await interrupted; a.delay = 0;
  assert.equal(hub.processes(a.id).activeCount, 1, "Stop generation leaves the managed child alive");
  for (const h of [a, b]) {
    const id = h === a ? pa.id : pb.id;
    await h.session.extensionRunner.getToolDefinition("process").execute("finish-fixture", { action: "write", id, input: "done\n" }, undefined, undefined, h.session.extensionRunner.createToolContext("finish-fixture", undefined));
  }
  await until(() => a.requests.length >= 4 && b.requests.length >= 3 && !client.sessionActivity(a.id).running && !client.sessionActivity(b.id).running);
  assert.ok(a.events.some((m) => m.type === "session_state" && m.state === "working"));
  assert.equal(hub.stateOf(a.id), "held");
  assert.ok(!JSON.stringify(a.requests).includes("only-B")); assert.ok(!JSON.stringify(b.requests).includes("only-A"));
  assert.match(hub.processes(a.id, pa.id).text, /A_DONE/);
  const notices = foldEvents(hub.historyEvents(a.id)).items.filter((item) => item.kind === "processNotification");
  assert.equal(notices.filter((n) => n.processId === pa.id).length, 1);
  const cold = piHistoryEvents(await a.proc.getHistoryMessages(), a.cwd);
  assert.equal(foldEvents(cold).items.filter((item) => item.kind === "processNotification" && item.processId === pa.id).length, 1, "completion survives raw-branch replay");
  assert.equal((await hub.navigateTree(a.id, { targetId: first.id, version: hub.sessionTree(a.id).version })).cancelled, false);

  const [longA, longB] = await Promise.all([a.launch("long-A", "sleep 20", { onSuccess: "ignore" }), b.launch("long-B", "sleep 20", { onSuccess: "ignore" })]);
  await client.agent.deleteSession({ sessionId: a.id });
  assert.equal(hub.processes(b.id).activeCount, 1, "deleting A must not kill B");
  const beforeStop = b.requests.length;
  await hub.stopProcess(b.id, longB.id);
  await until(() => !b.processes.busy);
  assert.equal(b.requests.length, beforeStop, "intentional task stop is context-only, not a model wake");
  assert.equal(hub.processes(b.id).activeCount, 0);
  assert.throws(() => hub.processes(b.id, longA.id), { code: "PROCESS_MISSING" });
  assert.ok(!JSON.stringify(hub.processes(b.id)).includes("stdoutFile"), "browser snapshots do not expose plugin log-file paths");
});

test("Pi admission/idle eviction protects managed jobs and autonomous runs without unbounded attachments", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-process-cap-")), acp = new EventEmitter(), calls = [], activity = new Map();
  const cap = Number(process.env.MAX_ATTACHED_SESSIONS || 10);
  acp.ready = true;
  acp.sessionActivity = (id) => activity.get(id) || { running: false, background: false };
  acp.request = async (method, args) => { calls.push({ method, args }); return method === "session/new" ? { sessionId: "replacement" } : { sessions: [] }; };
  const hub = new SessionHub(acp, path.join(root, "state.json"), { agent: "pi", devinExt: false });
  t.after(() => { clearInterval(hub._stateTimer); clearInterval(hub._mirrorTimer); clearTimeout(hub._saveTimer); fs.rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < cap; i++) {
    const id = `protected-${i}`, s = hub.subscribe({ readyState: 1, send() {} }, id, root);
    s.attached = true; s.lastActiveAt = 1;
    activity.set(id, { running: i === 0, background: i !== 0 });
  }
  assert.equal(hub.stateOf("protected-0"), "working", "autonomous runs count without prompting receipts");
  await assert.rejects(hub.createSession(root), { code: "SESSION_CAPACITY" });
  await assert.rejects(hub.ensureAttached("cold", root), { code: "SESSION_CAPACITY" });
  assert.equal(calls.filter((c) => c.method === "session/new" || c.method === "session/load").length, 0);
  hub._stateTimer._onTimeout();
  while (hub._statePolling) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((c) => c.method === "session/close").length, 0, "quiet background work and autonomous responses survive idle sweeps");
  const idle = `protected-${cap - 1}`; activity.set(idle, { running: false, background: false });
  await hub.createSession(root);
  assert.deepEqual(calls.filter((c) => c.method === "session/close").map((c) => c.args.sessionId), [idle]);
  assert.equal([...hub.sessions.values()].filter((s) => s.attached).length, cap);
});

test("Pi simultaneous attachment admissions reserve capacity before creating SDK sessions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-process-slots-")), acp = new EventEmitter(), pending = [];
  const cap = Number(process.env.MAX_ATTACHED_SESSIONS || 10);
  acp.request = (method) => { assert.equal(method, "session/new"); return new Promise((resolve) => pending.push(resolve)); };
  const hub = new SessionHub(acp, path.join(root, "state.json"), { agent: "pi", devinExt: false });
  t.after(() => { clearInterval(hub._stateTimer); clearInterval(hub._mirrorTimer); clearTimeout(hub._saveTimer); fs.rmSync(root, { recursive: true, force: true }); });
  const all = Promise.allSettled(Array.from({ length: cap + 2 }, () => hub.createSession(root)));
  for (let i = 0; i < cap + 3; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, cap);
  pending.forEach((resolve, i) => resolve({ sessionId: `created-${i}` }));
  const results = await all;
  assert.equal(results.filter((r) => r.status === "fulfilled").length, cap);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "SESSION_CAPACITY"));
  assert.equal(hub._slotReservations.size, 0);
});

test("Pi process quota covers parallel starts and user prompts queue behind autonomous failure continuations", { timeout: 30000 }, async (t) => {
  const { client, hub, host, until } = await processFixture(t), h = await host("quota");
  h.processes.limit = 2;
  const tool = h.session.extensionRunner.getToolDefinition("process");
  const call = (name) => tool.execute(name, { action: "start", name, command: "sleep 20", notify: { onSuccess: "ignore" } }, undefined, undefined, h.session.extensionRunner.createToolContext(name, undefined));
  const results = await Promise.allSettled([call("one"), call("two"), call("over-limit")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "PROCESS_CAPACITY");
  assert.equal(h.processes.launches.size, 0);
  const [one, two] = hub.processes(h.id).processes;
  assert.equal(hub.processes(h.id).activeCount, 2);
  await hub.stopProcess(h.id, one.id);
  await until(() => !h.processes.summary().pending);
  const failure = await h.launch("failure-wake", 'read token; printf "LOCAL_FAILURE\\n"; exit 7');
  const before = h.requests.length; h.delay = 250;
  await tool.execute("finish-failure", { action: "write", id: failure.id, input: "done\n" }, undefined, undefined, h.session.extensionRunner.createToolContext("finish-failure", undefined));
  await until(() => h.requests.length === before + 1);
  assert.equal(hub.stateOf(h.id), "working");
  const queued = await hub.submitPrompt(h.id, h.cwd, [{ type: "text", text: "queued after autonomous work" }], "autonomous-queued");
  assert.equal(queued.queued, true);
  assert.equal(hub.promptStatus(h.id, "autonomous-queued").status, "queued");
  await until(() => hub.promptStatus(h.id, "autonomous-queued").status === "completed" && !client.sessionActivity(h.id).running);
  assert.ok(JSON.stringify(h.requests.at(-1)).includes("queued after autonomous work"));
  const notice = foldEvents(hub.historyEvents(h.id)).items.find((item) => item.kind === "processNotification" && item.processId === failure.id);
  assert.equal(notice.exitCode, 7);
  await hub.stopProcess(h.id, two.id);
  await until(() => !h.processes.busy);
  const removeDuplicate = h.processes.events.on("processes:request:list", ({ reply }) => reply([]));
  try { await assert.rejects(call("duplicate-engine"), { code: "PROCESSES_CONFLICT" }); }
  finally { removeDuplicate(); }
  assert.equal(hub.processes(h.id).activeCount, 0, "conflicting engines must not launch untracked jobs");
});

test("Web keeps one pinned process engine alongside a global Pi installation, including reload", { timeout: 30000 }, async (t) => {
  const { host, until } = await processFixture(t), h = await host("global-install", undefined, { globalPlugin: true });
  const source = "npm:@aliou/pi-processes@0.13.6";
  for (const entry of [source, { source, extensions: ["extensions/processes/index.ts"], skills: [] }]) {
    h.settings.setPackages([entry]);
    await h.session.extensionRunner.createCommandContext().reload();
    await h.proc.rebindSession();
    assert.deepEqual(h.settings.getGlobalSettings().packages, [entry], "Web filtering must not rewrite global settings");
    assert.equal(h.services.resourceLoader.getExtensions().extensions.filter((ext) => ext.tools.has("process")).length, 1);
    assert.equal(h.processes.request("list").length, 0, "exactly one engine responds after reload");
    const task = await h.launch("global-compatible", 'read token; printf "GLOBAL_DONE\\n"');
    const before = h.requests.length, tool = h.session.extensionRunner.getToolDefinition("process");
    await tool.execute("finish-global", { action: "write", id: task.id, input: "done\n" }, undefined, undefined, h.session.extensionRunner.createToolContext("finish-global", undefined));
    await until(() => h.requests.length === before + 1 && !h.processes.busy && h.session.isIdle);
    assert.equal(h.processes.snapshot().activeCount, 0);
  }
});

test("Pi settling a prior run cannot clear a newly started autonomous run", async () => {
  const client = new PiSdkClient(); await client.ensureStarted();
  let finishStats;
  const updates = [], proc = { onEvent() {}, session: { isIdle: true } };
  const bridge = client.agent.sessions.getOrCreate("run-race", { cwd: os.tmpdir(), proc, conn: { sessionUpdate: async ({ update }) => updates.push(update) } });
  bridge.publishContextUsage = () => new Promise((resolve) => { finishStats = resolve; });
  bridge.handlePiEvent({ type: "agent_start" });
  const settling = bridge.settleTurn();
  bridge.handlePiEvent({ type: "agent_start" });
  finishStats(); await settling; await bridge.flushEmits();
  assert.equal(bridge.runActive, true);
  assert.ok(!updates.some((update) => update._meta?.piAcp?.running === false));
  bridge.publishContextUsage = async () => {};
  await bridge.settleTurn(); await bridge.flushEmits();
  assert.equal(bridge.runActive, false);
  assert.equal(updates.at(-1)._meta.piAcp.running, false);
});

test("history wire preserves full text, lazily serves scoped images and validates unchanged snapshots", async (t) => {
  const { HISTORY_ENCODING, unpackHistory } = await import("../src/history-wire.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-wire-test-"));
  const acp = new EventEmitter(); acp.request = () => assert.fail("transport must never load, prompt or change model context");
  const hub = new SessionHub(acp, path.join(dir, "state.json"), { devinExt: false });
  t.after(() => { clearInterval(hub._stateTimer); clearInterval(hub._mirrorTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  const long = " full 中文🚀\r\n".repeat(3000), png = Buffer.alloc(28);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(1000, 16); png.writeUInt32BE(500, 20);
  const data = png.toString("base64");
  const events = [
    { t: 1, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: long } } },
    { t: 2, update: { sessionUpdate: "user_message_chunk", content: { type: "image", data, mimeType: "image/png" } } },
    { t: 3, update: { sessionUpdate: "tool_call", toolCallId: "same", title: "bash", rawInput: { command: long }, rawOutput: { content: [{ type: "text", text: long }] }, content: [{ type: "content", content: { type: "text", text: long } }] } },
    { t: 4, update: { sessionUpdate: "session_info_update", _meta: { piAcp: { compaction: { id: "c", status: "completed", summary: long } } } } },
    { t: 5, update: { sessionUpdate: "session_info_update", _meta: { piAcp: { branchSummary: { id: "b", summary: long } } } } },
  ];
  const saved = JSON.stringify(events), message = { type: "history", sessionId: "wire-session", gen: 5, revision: 1, events, state: "held", attached: true };
  const entry = hub.subscribe({ readyState: 1, send() {} }, message.sessionId, dir); entry.events = events;
  assert.equal(hub.historyFrame(message), JSON.stringify(message), "legacy clients retain the exact old protocol");
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 5, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const gif = Buffer.alloc(10); gif.write("GIF89a"); gif.writeUInt16LE(7, 6); gif.writeUInt16LE(5, 8);
  const webp = Buffer.alloc(30); webp.write("RIFF"); webp.write("WEBPVP8X", 8); webp.writeUIntLE(6, 24, 3); webp.writeUIntLE(4, 27, 3);
  for (const [mimeType, bytes] of [["image/jpeg", jpeg], ["image/gif", gif], ["image/webp", webp]]) {
    const [projected] = hub.wireHistoryEvents(message.sessionId, [{ update: { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType, data: bytes.toString("base64") } } }]);
    assert.equal(projected.update.content.width, 7); assert.equal(projected.update.content.height, 5);
  }
  for (const oriented of [Buffer.concat([jpeg.subarray(0, 2), Buffer.from([255, 225, 0, 10, 69, 120, 105, 102, 0, 0, 0, 0]), jpeg.subarray(2)]), Buffer.concat([jpeg, Buffer.from([255, 225, 0, 10, 69, 120, 105, 102, 0, 0, 0, 0])])]) {
    const event = { update: { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/jpeg", data: oriented.toString("base64") } } };
    assert.equal(hub.wireHistoryEvents(message.sessionId, [event])[0], event, "EXIF orientation keeps native sizing rather than introducing a rotated-thumbnail layout shift");
  }
  const unknown = { update: { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "unknown header" } } };
  assert.equal(hub.wireHistoryEvents(message.sessionId, [unknown])[0], unknown, "unrecognized geometry retains exact inline image compatibility");
  const wire = hub.historyFrame(message, { encoding: HISTORY_ENCODING });
  const full = unpackHistory(JSON.parse(wire));
  assert.ok(wire.length < saved.length / 2);
  assert.equal(full.events[0].update.content.text, long);
  assert.deepEqual(full.events[2], events[2], "all raw tool fields, terminal snapshots and arguments survive");
  assert.deepEqual(full.events.slice(3), events.slice(3), "compaction and branch summaries retain their positions and complete content");
  const image = full.events[1].update.content, mid = image.url.split("/").at(-2);
  assert.equal(image.data, undefined); assert.equal(image.width, 1000); assert.equal(image.height, 500);
  assert.equal(hub.sessionImage(message.sessionId, mid, 0).data, data);
  assert.equal(hub.sessionImage("different-session", mid, 0), null, "assets never cross a session boundary");
  hub.historyImageCache.clear(); hub.historyImageBytes = 0;
  assert.equal(hub.sessionImage(message.sessionId, mid, 0).data, data, "evicted images recover from existing history without session/load");
  const unchanged = JSON.parse(hub.historyFrame({ ...message, state: "working", queue: [{ id: "queued" }] }, { encoding: HISTORY_ENCODING, knownToken: full.historyToken }));
  assert.equal(unchanged.unchanged, true); assert.equal(unchanged.events, undefined); assert.equal(unchanged.state, "working"); assert.equal(unchanged.queue.length, 1);
  assert.notEqual(JSON.parse(hub.historyFrame({ ...message, gen: 6 }, { encoding: HISTORY_ENCODING, knownToken: full.historyToken })).unchanged, true, "tree generations always require a fresh snapshot");
  const changed = [...events, { t: 6, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new live tail" } } }];
  assert.notEqual(JSON.parse(hub.historyFrame({ ...message, events: changed }, { encoding: HISTORY_ENCODING, knownToken: full.historyToken })).unchanged, true);
  assert.equal(JSON.stringify(events), saved, "wire projection never rewrites authoritative history or model messages");

  const { createServer } = await import("node:http"), { once } = await import("node:events"), { WebSocket, WebSocketServer } = await import("ws");
  const { HISTORY_COMPRESSION } = await import("../src/history-wire.js");
  const server = createServer(), wss = new WebSocketServer({ server, perMessageDeflate: HISTORY_COMPRESSION });
  t.after(async () => { for (const socket of wss.clients) socket.terminate(); wss.close(); await new Promise((resolve) => server.close(resolve)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const connection = once(wss, "connection"), browser = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  t.after(() => browser.terminate()); await once(browser, "open"); const [peer] = await connection;
  assert.match(browser.extensions, /permessage-deflate/);
  const received = once(browser, "message"), beforeBytes = peer._socket.bytesWritten;
  await new Promise((resolve, reject) => peer.send(wire, (error) => error ? reject(error) : resolve()));
  const [delivered] = await received;
  assert.equal(delivered.toString(), wire, "native WebSocket decompression retains the exact encoded UTF-8 snapshot");
  assert.ok(peer._socket.bytesWritten - beforeBytes < Buffer.byteLength(wire) / 3, "large history uses negotiated compression, not only smaller JS objects");
});

test("history v2 resumes exact prefixes, defers only binary tool images and recovers evicted assets", async (t) => {
  const { HISTORY_ENCODING_V2, HISTORY_ENCODING, unpackHistory, historyImageAsset } = await import("../src/history-wire.js");
  const { hydrateHistoryImages } = await import("../../web/src/historyImages.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v2-")), acp = new EventEmitter();
  acp.request = () => assert.fail("history transport must not load/cancel an agent");
  const hub = new SessionHub(acp, path.join(dir, "state.json"), { devinExt: false });
  t.after(() => { clearInterval(hub._stateTimer); clearInterval(hub._mirrorTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  const png = Buffer.alloc(4096, 42); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(700,16); png.writeUInt32BE(350,20);
  const data = png.toString("base64").replace(/.{80}/g, "$&\r\n"), image = { type: "image", mimeType: "image/png", data };
  const events = [{ t: 1, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "完整用户文字🚀" } } },
    { t: 2, update: { sessionUpdate: "tool_call", toolCallId: "image", title: "read", rawOutput: { content: [image], structuredContent: { ...image }, text: "完整工具文字\r\n" }, content: [{ type: "content", content: { ...image } }] } }];
  const saved = JSON.stringify(events), message = { type: "history", sessionId: "v2", gen: 2, state: "held", events };
  const entry = hub.subscribe({ readyState: 1, send() {} }, "v2", dir); entry.events = events;
  const fullWire = hub.historyFrame(message, { encoding: HISTORY_ENCODING_V2 }), full = unpackHistory(JSON.parse(fullWire));
  const projectedImage = full.events[1].update.rawOutput.content[0], asset = historyImageAsset(projectedImage);
  assert.ok(asset); assert.equal(projectedImage.data, null); assert.ok(!fullWire.includes(data));
  let requests = 0;
  const api = { get: async (url) => { requests++; assert.match(url, /^\/api\/sessions\/v2\/img\/pi-[a-f0-9]+\/0\?encoding=base64$/); const mid = url.split("/").at(-2); return hub.sessionImage("v2", mid, 0); } };
  assert.equal(requests, 0);
  const hydrated = await hydrateHistoryImages(full.events, api);
  assert.equal(requests, 1, "duplicate references share one explicit raw fetch"); assert.equal(JSON.stringify(hydrated), saved);
  assert.equal(projectedImage.data, null, "hydration never mutates cached folded state");
  hub.historyImageCache.clear(); hub.historyImageBytes = 0;
  assert.equal(hub.sessionImage("v2", asset.url.split("/").at(-2), 0).data, data, "recovery preserves even original base64 whitespace");
  assert.equal(hub.sessionImage("other", asset.url.split("/").at(-2), 0), null);
  const tail = { t: 3, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "新增完整内容" } } };
  const next = { ...message, events: [...events, tail], state: "working", usage: { used: 77, size: 100 } };
  const delta = unpackHistory(JSON.parse(hub.historyFrame(next, { encoding: HISTORY_ENCODING_V2, baseToken: full.historyToken })));
  assert.equal(delta.delta, true); assert.equal(delta.historyBaseLength, 2); assert.equal(delta.historyLength, 3); assert.deepEqual(delta.events, [tail]);
  assert.equal(delta.state, "working"); assert.equal(delta.usage.used, 77);
  for (const changed of [{ ...next, gen: 3 }, { ...next, sessionId: "other" }, { ...next, events: [{ ...events[0], t: 99 }, ...events.slice(1), tail] }, { ...next, events: events.slice(0,1) }])
    assert.equal(JSON.parse(hub.historyFrame(changed, { encoding: HISTORY_ENCODING_V2, baseToken: full.historyToken })).delta, undefined, "changed branch/source/prefix falls back to full");
  hub.historyCheckpoints.clear(); hub.historyCheckpointBytes = 0;
  assert.equal(JSON.parse(hub.historyFrame(next, { encoding: HISTORY_ENCODING_V2, baseToken: full.historyToken })).delta, undefined);
  assert.equal(JSON.stringify(events), saved);
  assert.deepEqual(unpackHistory(JSON.parse(hub.historyFrame(message, { encoding: HISTORY_ENCODING }))).events, events, "v1 clients keep inline tool raw fields");
  const broken = JSON.parse(fullWire); broken.historyAssets[0].url = "/api/sessions/other/img/pi-" + "a".repeat(64) + "/0";
  assert.throws(() => unpackHistory(broken), /asset/);
  await assert.rejects(hydrateHistoryImages(full.events, { get: async () => { throw new Error("offline"); } }), /offline/, "raw/export failures never emit partial placeholder JSON");
  const abort = new AbortController(); abort.abort();
  await assert.rejects(hydrateHistoryImages(full.events, { get: () => assert.fail("aborted reads never start") }, { signal: abort.signal }), { name: "AbortError" });
  const multi = JSON.parse(fullWire); multi.historyAssets[1].url = "/api/sessions/v2/img/pi-" + "a".repeat(64) + "/0";
  const multiFull = unpackHistory(multi); let starts = 0, cancellations = 0;
  await assert.rejects(hydrateHistoryImages(multiFull.events, { get: (_url, { signal }) => {
    if (++starts === 1) return Promise.reject(new Error("read failed"));
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancellations++; reject(new DOMException("Aborted", "AbortError")); }, { once: true }));
  } }), /read failed/);
  assert.equal(cancellations, 1, "one failed raw resource cancels the other outstanding reads");

});
