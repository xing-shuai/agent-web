import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySession, applyUpdate, foldEvents, foldHistoryDelta, historySnapshot, activeBlockKeys, historyUsage } from "../../web/src/sessionReducer.js";
import { splitStreamingMarkdown } from "../../web/src/markdownBlocks.js";
import { initialLayout, layoutReducer, paneLeaves, restoreLayout, minimumLayout, layoutGeometry, sessionKey, parseSessionKey, neighborPane, hostHue } from "../../web/src/splitLayout.js";
import { getUi, setUi } from "../../web/src/ui.js";
import { formatHotkey, matchHotkey } from "../../web/src/hotkeys.js";
import { evictableKeys, stampSeen } from "../../web/src/sessionCache.js";
import { noticesReducer } from "../../web/src/notices.js";
import { TurnTelemetryTracker, estimateDeltaTokens, liveTpsAt } from "../../web/src/turnTelemetry.js";

test("recursive panes preserve identities, unique session ownership and originating async targets", () => {
  let state = initialLayout("/first");
  const first = state.focusedId;
  const act = (action) => state = layoutReducer(state, action);
  act({ type: "assign", sessionId: "alpha", cwd: "/first" });
  act({ type: "split", axis: "row" });
  const second = state.focusedId;
  assert.notEqual(first, second);
  assert.equal(paneLeaves(state.root)[0].id, first, "splitting never changes the original view key");
  assert.equal(paneLeaves(state.root)[1].sessionId, null);
  act({ type: "assign", sessionId: "beta", cwd: "/second" });
  act({ type: "split", axis: "column" });
  const third = state.focusedId;
  act({ type: "assign", sessionId: "alpha", cwd: "/first" });
  assert.equal(state.focusedId, first, "opening an existing conversation focuses its owner instead of duplicating its composer");
  assert.equal(paneLeaves(state.root).filter((pane) => pane.sessionId === "alpha").length, 1);
  act({ type: "assign", paneId: third, sessionId: "created", cwd: "/third", focus: false });
  assert.equal(state.focusedId, first, "an async completion does not steal focus");
  act({ type: "close", paneId: third });
  const afterClose = state;
  act({ type: "assign", paneId: third, sessionId: "late", cwd: "/third" });
  assert.equal(state, afterClose, "a response for a closed view cannot leak into its neighbor");
  assert.equal(state.root.axis, "row", "closing collapses just the empty ancestor");
  act({ type: "clear", ids: ["alpha"] });
  assert.equal(paneLeaves(state.root).length, 2, "deletion empties a pane without collapsing the layout");
  assert.equal(paneLeaves(state.root).find((pane) => pane.id === first).sessionId, null);
  act({ type: "close" });
  assert.equal(state.root.id, second);
  assert.equal(state.focusedId, second);
  assert.equal(layoutReducer(state, { type: "close" }), state, "the last pane stays usable");
});

test("split geometry respects minimum sizes and persisted layouts fail closed", () => {
  let state = initialLayout("/first");
  state = layoutReducer(state, { type: "split", axis: "row" });
  state = layoutReducer(state, { type: "split", axis: "column" });
  const minimum = minimumLayout(state.root);
  assert.deepEqual(minimum, { width: 566, height: 446 });
  state = layoutReducer(state, { type: "ratio", id: state.root.id, ratio: .99 });
  const geometry = layoutGeometry(state.root, minimum.width, minimum.height);
  assert.equal(geometry.panes.length, 3); assert.equal(geometry.dividers.length, 2);
  for (const { rect } of geometry.panes) { assert.ok(rect.width >= 280); assert.ok(rect.height >= 220); }
  assert.deepEqual(restoreLayout(JSON.stringify(state)), state);
  assert.equal(layoutReducer(state, { type: "ratio", id: state.root.id, ratio: NaN }), state);
  const duplicated = { root: { id: "split", axis: "row", ratio: .5, children: [
    { id: "a", sessionId: "same", cwd: "/first" }, { id: "b", sessionId: "same", cwd: "/first" },
  ] }, focusedId: "missing" };
  const restored = restoreLayout(JSON.stringify(duplicated));
  assert.equal(restored.focusedId, "a");
  assert.deepEqual(paneLeaves(restored.root).map((pane) => pane.sessionId), ["same", null]);
  for (const raw of ["broken", "null", JSON.stringify({ root: { id: "bad", children: [] } })]) {
    const reset = restoreLayout(raw, "/safe");
    assert.equal(reset.root.cwd, "/safe"); assert.equal(reset.root.sessionId, null);
  }
});

test("panes carry hosts and session identity is the (host, sessionId) pair", () => {
  let state = initialLayout("/first");
  assert.equal(state.root.host, "");
  state = layoutReducer(state, { type: "host", host: "h1", cwd: "/remote" });
  assert.equal(state.root.host, "h1");
  assert.equal(state.root.cwd, "/remote");
  const occupied = layoutReducer(layoutReducer(state, { type: "assign", sessionId: "seed" }), { type: "host", host: "h2" });
  assert.equal(occupied.root.host, "h1", "host switching only applies to empty panes");
  state = layoutReducer(state, { type: "host", host: "" });
  state = layoutReducer(state, { type: "assign", sessionId: "alpha", cwd: "/first" });
  state = layoutReducer(state, { type: "split", axis: "row" });
  const [first, second] = paneLeaves(state.root);
  assert.equal(second.host, "", "a split pane inherits its source host");
  state = layoutReducer(state, { type: "assign", paneId: second.id, sessionId: "alpha", host: "h1", cwd: "/remote" });
  assert.equal(state.focusedId, second.id, "alpha on another host never focuses the local pane");
  assert.equal(paneLeaves(state.root).filter((pane) => pane.sessionId === "alpha").length, 2, "the same id lives once per host");
  state = layoutReducer(state, { type: "assign", paneId: second.id, sessionId: "alpha", host: "" });
  assert.equal(state.focusedId, first.id, "assigning the same (host, session) pair focuses the existing pane");
  state = layoutReducer(state, { type: "clear", host: "h1", ids: ["alpha"] });
  assert.equal(paneLeaves(state.root).find((pane) => pane.id === first.id).sessionId, "alpha");
  assert.equal(paneLeaves(state.root).find((pane) => pane.id === second.id).sessionId, null, "clear only empties panes of the matching host");
  const roundTrip = restoreLayout(JSON.stringify(state));
  assert.deepEqual(paneLeaves(roundTrip.root).map((pane) => pane.host), paneLeaves(state.root).map((pane) => pane.host));
  const legacy = restoreLayout(JSON.stringify({ root: { id: "old", sessionId: "s", cwd: "/x" }, focusedId: "old" }), null, "h9");
  assert.equal(legacy.root.host, "h9", "leaves without a host take the document default");
  const duplicated = { root: { id: "split", axis: "row", ratio: .5, children: [
    { id: "a", host: "h1", sessionId: "same", cwd: "/x" }, { id: "b", host: "h2", sessionId: "same", cwd: "/y" },
  ] }, focusedId: "a" };
  assert.deepEqual(paneLeaves(restoreLayout(JSON.stringify(duplicated)).root).map((pane) => pane.sessionId), ["same", "same"],
    "the same session id survives on different hosts");
  const colliding = { root: { id: "split", axis: "row", ratio: .5, children: [
    { id: "a", host: "h1", sessionId: "same", cwd: "/x" }, { id: "b", host: "h1", sessionId: "same", cwd: "/y" },
  ] }, focusedId: "a" };
  assert.deepEqual(paneLeaves(restoreLayout(JSON.stringify(colliding)).root).map((pane) => pane.sessionId), ["same", null],
    "the same host still dedupes a repeated session");
  assert.notEqual(sessionKey("", "x"), sessionKey("h", "x"));
  assert.deepEqual(parseSessionKey(sessionKey("h1", "x")), { host: "h1", sessionId: "x" });
  assert.deepEqual(parseSessionKey(sessionKey("", "x")), { host: "", sessionId: "x" });
});

test("session cache only evicts idle, unreferenced, unblocked entries", () => {
  const now = 1000000, idleMs = 300000;
  const K = (sid) => sessionKey("", sid);
  const lastSeen = new Map([[K("recent"), now - 1000], [K("delivery"), now - idleMs], [K("perm"), now - idleMs], [K("idle"), now - idleMs]]);
  const cases = {
    keys: ["inpane", "recent", "delivery", "perm", "idle", "never"].map(K),
    paneKeys: [K("inpane")],
    lastSeen,
    now,
    deliveries: [{ host: "", sessionId: "delivery", phase: "sending" }, { host: "", sessionId: "idle", phase: "completed" }],
    sessions: { [K("perm")]: { pendingPermissions: [{ requestId: "r" }] } },
  };
  assert.deepEqual(evictableKeys({ ...cases, idleMs }).sort(), ["idle", "never"].map(K).sort(),
    "paned, fresh, in-flight and blocked entries all survive");
  assert.deepEqual(evictableKeys({ ...cases, keys: [K("idle")], idleMs: 999999999 }), [], "a long horizon keeps everything");
});

test("departure stamping restarts the idle clock and stubs never re-evict", () => {
  const lastSeen = new Map();
  const first = stampSeen(lastSeen, new Set(), ["k"], 0);
  assert.deepEqual(first, new Set(["k"]));
  // The key was stamped an hour ago while open; leaving re-stamps at departure.
  const second = stampSeen(lastSeen, first, [], 3_610_000);
  assert.equal(lastSeen.get("k"), 3_610_000);
  assert.deepEqual(evictableKeys({ keys: ["k"], paneKeys: [], lastSeen, now: 3_620_000, idleMs: 300_000 }), [],
    "a key that left ten seconds ago is not evictable");
  const seen = new Map([["stub", 0]]);
  assert.deepEqual(evictableKeys({ keys: ["stub"], paneKeys: [], lastSeen: seen, now: 1e12,
    sessions: { stub: { evicted: true } }, idleMs: 0 }), [], "an unread stub never re-evicts");
});

test("the notice stack dedupes, replaces by id and caps at four items", () => {
  let s = [];
  const push = (n) => { s = noticesReducer(s, { type: "notify", notice: n }); };
  push({ kind: "warn", text: "a" });
  push({ kind: "warn", text: "a" });
  assert.equal(s.length, 1); assert.equal(s[0].count, 2, "identical notices fold into a counter");
  push({ kind: "info", text: "x", id: "k" });
  push({ kind: "warn", text: "y", id: "k" });
  assert.equal(s.length, 2); assert.equal(s[1].text, "y", "an explicit id replaces the same-id item");
  push({ kind: "info", text: "1", sticky: true, id: "sticky-1" });
  push({ kind: "info", text: "2", id: "i2" }); push({ kind: "info", text: "3", id: "i3" }); push({ kind: "info", text: "4", id: "i4" });
  assert.equal(s.length, 4);
  assert.ok(s.some((n) => n.text === "1"), "sticky items outlive the cap");
  assert.deepEqual(s.filter((n) => !n.sticky).map((n) => n.text), ["2", "3", "4"], "the oldest non-sticky drops first");
  s = noticesReducer(s, { type: "dismiss", id: "i3" });
  assert.equal(s.length, 3);
  s = noticesReducer(s, { type: "dismissWhere", pred: (n) => n.sticky });
  assert.equal(s.length, 2, "dismissWhere clears matching items");
});

test("splitOpen, swap and neighborPane drive cross-pane layout actions", () => {
  let state = initialLayout("/w");
  state = layoutReducer(state, { type: "splitOpen", axis: "row", host: "", sessionId: "x", cwd: "/w" });
  let [a, b] = paneLeaves(state.root);
  assert.equal(b.sessionId, "x"); assert.equal(state.focusedId, b.id);
  const again = layoutReducer(state, { type: "splitOpen", axis: "row", host: "", sessionId: "x" });
  assert.equal(again.focusedId, b.id, "the same (host,session) pair dedupes");
  state = layoutReducer(state, { type: "splitOpen", axis: "column", host: "h", sessionId: "y", cwd: "/r" });
  const [,, c] = paneLeaves(state.root);
  const swap = layoutReducer(state, { type: "swap", a: a.id, b: c.id });
  const ids = paneLeaves(swap.root).map((p) => p.id);
  assert.equal(ids[0], c.id); assert.equal(ids[2], a.id, "leaves swap positions keeping ids");
  assert.equal(paneLeaves(swap.root)[0].sessionId, "y");
  assert.equal(layoutReducer(swap, { type: "swap", a: a.id, b: a.id }), swap, "self-swap is a no-op");
  assert.equal(layoutReducer(swap, { type: "swap", a: a.id, b: "missing" }), swap);
  let full = state;
  for (let i = paneLeaves(full.root).length; i < 256; i++) full = layoutReducer(full, { type: "split", axis: "row" });
  assert.equal(layoutReducer(full, { type: "splitOpen", axis: "row", sessionId: "z" }), full, "the 256-pane cap applies");
  // L layout: left half is pane L, right half split top (RT) / bottom (RB).
  const root = { id: "s", axis: "row", ratio: .5, children: [
    { id: "L", host: "", sessionId: null, cwd: "/w" },
    { id: "s2", axis: "column", ratio: .5, children: [
      { id: "RT", host: "", sessionId: null, cwd: "/w" },
      { id: "RB", host: "", sessionId: null, cwd: "/w" } ] } ] };
  const geo = layoutGeometry(root, 1000, 1000).panes;
  assert.equal(neighborPane(geo, "L", "right"), "RT");
  assert.equal(neighborPane(geo, "L", "up"), null);
  assert.equal(neighborPane(geo, "RT", "down"), "RB");
  assert.equal(neighborPane(geo, "RT", "right"), null);
  assert.equal(neighborPane(geo, "RB", "up"), "RT");
  assert.equal(neighborPane(geo, "RB", "left"), "L");
  assert.equal(neighborPane(geo, "RT", "left"), "L");
  const hue = hostHue("h1");
  assert.equal(hostHue("h1"), hue); assert.ok(hue >= 0 && hue < 360);
  assert.notEqual(hostHue("h1"), hostHue("h2") === undefined ? hue : hostHue("h2"));
});

test("terminal flags toggle per pane and persist through the layout", () => {
  let state = initialLayout("/w");
  state = layoutReducer(state, { type: "terminal" });
  const pane = paneLeaves(state.root)[0];
  assert.equal(pane.terminal, true, "the focused pane toggles open");
  state = layoutReducer(state, { type: "split", axis: "row" });
  const panes = paneLeaves(state.root);
  assert.equal(panes[0].terminal, true); assert.equal(panes[1].terminal, undefined, "split does not inherit the flag");
  state = layoutReducer(state, { type: "terminal", paneId: panes[1].id, open: true });
  assert.equal(paneLeaves(state.root)[1].terminal, true);
  state = layoutReducer(state, { type: "terminal", paneId: panes[1].id, open: false });
  assert.equal(paneLeaves(state.root)[1].terminal, false);
  const restored = restoreLayout(JSON.stringify({ root: { id: "s", axis: "row", ratio: .5, children: [
    { id: "a", host: "", sessionId: "x", cwd: "/w", terminal: true },
    { id: "b", host: "", sessionId: "y", cwd: "/w", terminal: "yes" }] }, focusedId: "a" }));
  const [ra, rb] = paneLeaves(restored.root);
  assert.equal(ra.terminal, true, "boolean true survives restore");
  assert.equal(rb.terminal, undefined, "non-boolean values are dropped");
});

test("welcome connect picks trusted hosts and fails closed otherwise", async () => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const posts = [];
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "FileReader", "navigator"].map((k) => [k, dom.window[k]])),
    fetch: async (url, options = {}) => {
      const respond = (data) => ({ ok: true, json: async () => data });
      if (url === "/api/remotes") return respond({ hosts: [
        { id: "trusted", label: "Devbox", hostname: "d", username: "u", port: 22, state: "disconnected", fingerprint: "SHA256:x" },
        { id: "untrusted", label: "Fresh", hostname: "f", username: "u", port: 22, state: "disconnected" },
      ], keyConfigured: true });
      if (url.endsWith("/connect")) { posts.push(url); return respond({}); }
      return respond({ agents: [{ id: "pi", name: "Pi", caps: {} }], workspaces: ["/tmp"], home: "/tmp", sessions: [] }[url.split("/api/")[1]] || {});
    },
    WebSocket: class { readyState = 1; sent = []; send(raw) { this.sent.push(JSON.parse(raw)); } close() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  let vite, root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
    root = createRoot(document.getElementById("root"));
    const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
    await act(async () => root.render(React.createElement(App)));
    const select = document.querySelector(".welcome-host");
    await act(async () => { select.value = "trusted"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.deepEqual(posts, ["/api/remotes/trusted/connect"], "a trusted disconnected host connects in place");
    assert.equal(document.querySelector(".chat-pane").dataset.host, "trusted", "the pane switches to the connected host");
    await act(async () => { document.querySelector(".welcome-host").value = "untrusted"; document.querySelector(".welcome-host").dispatchEvent(new Event("change", { bubbles: true })); });
    assert.equal(posts.length, 1, "an untrusted host never auto-connects");
    assert.ok(document.querySelector(".remote-modal"), "untrusted selection opens host management");
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.close();
    for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});

test("open-tui telemetry counts stream deltas and real usage without tool time or replay spikes", () => {
  let ms = 1000;
  const tracker = new TurnTelemetryTracker(() => ms);
  const handle = (type, fields = {}) => tracker.handle({ type, ...fields });
  const delta = (type, text) => handle("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type, delta: text } });
  const finish = (output) => handle("message_end", { message: { role: "assistant", usage: { input: 10, output, reasoning: output / 2, cacheWrite: 2 } } });
  handle("agent_start"); handle("turn_start"); handle("message_start", { message: { role: "assistant" } });
  ms = 2000; delta("text_delta", "abcd");
  ms = 3000; delta("thinking_delta", "中文");
  assert.deepEqual(tracker.getLiveTps(), { tps: 2, stale: false });
  ms = 4000; delta("toolcall_delta", "x".repeat(40));
  assert.equal(tracker.getLiveTps().tps, 6, "tool JSON contributes, not tool results");
  const live = tracker.liveSnapshot();
  assert.equal(liveTpsAt(live, 500).tps, 4.8);
  assert.equal(liveTpsAt(live, 2000).tps, 0, "stalls decay without a new event");
  ms = 4500; finish(70);
  assert.deepEqual(tracker.getLiveTps(), { tps: 4.8, stale: true });
  ms = 12000; const first = handle("turn_end");
  assert.equal(first.tps, 20);
  assert.equal(first.generationMs, 3500);
  ms = 20000; handle("turn_start"); handle("message_start", { message: { role: "assistant" } });
  ms = 21000; delta("text_delta", "next");
  ms = 22000; finish(30); handle("turn_end");
  ms = 30000; const final = handle("agent_settled");
  assert.equal(final.outputTokens, 100, "reasoning is already included in usage.output");
  assert.equal(final.inputTokens, 24, "cache writes count as uncached input");
  assert.equal(final.generationMs, 5500);
  assert.equal(final.ttftMs, 1000);
  assert.equal(final.totalMs, 29000);
  assert.equal(final.tps, 18.2, "sum request times, never include the long tool wait");
  assert.equal(tracker.getLiveTps(), null);
  assert.equal(estimateDeltaTokens("abcd中文"), 3);

  const events = [
    { t: 1000, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } } },
    { t: 2000, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "history" } } },
  ];
  let state = foldEvents(events);
  assert.equal(state.streamRate, null, "history must not become a live burst");
  state = applyUpdate(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "abcd" } }, 5000);
  assert.equal(state.streamRate.live, null);
  state = applyUpdate(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "中文" } }, 6000);
  assert.equal(liveTpsAt(state.streamRate.live).tps, 2);
  const info = { sessionUpdate: "session_info_update", _meta: { piAcp: { telemetry: { live, final } } } };
  state = applyUpdate(state, info, 7000);
  assert.equal(state.lastTurn.tps, 18.2);
  assert.equal(state.streamRate, null);
  const replay = foldEvents([{ update: info }]);
  assert.equal(replay.telemetry.live, null);
  assert.equal(replay.lastTurn.outputTokens, 100);
  assert.equal(emptySession().telemetry, null, "measurements are session-local");
});

const T = 1000;
const taskResult = (text) => ({ content: [{ type: "text", text }] });

function taskCall(s, name, input, text, id = `${name}-${s.items.length}`, status = "completed") {
  return applyUpdate(s, { sessionUpdate: "tool_call", toolCallId: id, title: name, kind: "other", status, rawInput: input, rawOutput: taskResult(text) });
}

test("task creation uses final arguments and only commits successful tool results", () => {
  let s = applyUpdate(emptySession(), { sessionUpdate: "tool_call", toolCallId: "create", title: "TaskCreate", status: "pending", rawInput: {} });
  s = applyUpdate(s, { sessionUpdate: "tool_call_update", toolCallId: "create", status: "in_progress", rawInput: { subject: "Implement Todo", activeForm: "Implementing Todo" } });
  assert.equal(s.todos.length, 0, "partial arguments are not tasks yet");
  assert.equal(s.items[0].toolName, "TaskCreate");
  s = applyUpdate(s, { sessionUpdate: "tool_call_update", toolCallId: "create", status: "completed", rawOutput: taskResult("Task #6 created successfully: Implement Todo") });
  assert.deepEqual(s.todos.map(({ id, subject, status }) => ({ id, subject, status })), [{ id: "6", subject: "Implement Todo", status: "pending" }]);
  s = taskCall(s, "TaskUpdate", { taskId: "6", status: "in_progress" }, "Updated task #6 status");
  assert.equal(s.todos[0].status, "in_progress");
  s = taskCall(s, "TaskUpdate", { taskId: "6", status: "completed" }, "validation failed", "failed-update", "failed");
  assert.equal(s.todos[0].status, "in_progress", "failed update does not check off a task");
  s = taskCall(s, "TaskUpdate", { taskId: "99", status: "completed" }, "Task #99 not found");
  assert.equal(s.todos.length, 1);
  s = taskCall(s, "TaskUpdate", { taskId: "6", subject: "Todo ready", status: "completed" }, "Updated task #6 status, subject");
  s = applyUpdate(s, { sessionUpdate: "tool_call_update", toolCallId: "create", status: "completed", rawOutput: taskResult("Task #6 created successfully: Implement Todo") });
  assert.equal(s.todos[0].status, "completed", "repeated create snapshots cannot reset completion");
  assert.equal(s.todos[0].subject, "Todo ready");
  s = taskCall(s, "TaskUpdate", { taskId: "6", status: "deleted" }, "Updated task #6 status");
  assert.equal(s.todos.length, 0);
});

test("task list/get snapshots recover real statuses, and new batches may reuse task ids", () => {
  let s = taskCall(emptySession(), "TaskList", {}, "#1 [completed] Done task\n#2 [in_progress] Active task");
  assert.deepEqual(s.todos.map((t) => t.status), ["completed", "in_progress"]);
  s = taskCall(s, "TaskGet", { taskId: "2" }, "Task #2: Renamed task\nStatus: completed\nDescription: details");
  assert.equal(s.todos[1].subject, "Renamed task");
  assert.equal(s.todos[1].status, "completed");
  s = taskCall(s, "TaskCreate", { subject: "New batch" }, "Task #1 created successfully: New batch");
  assert.equal(s.todos[0].subject, "New batch");
  assert.equal(s.todos[0].status, "pending");
  s = taskCall(s, "TaskList", {}, "No tasks found");
  assert.deepEqual(s.todos, []);
  s = taskCall(s, "TaskCreate", { subject: "Fix not found page" }, "Task #3 created successfully: Fix not found page");
  assert.equal(s.todos[0].subject, "Fix not found page", "task text is not mistaken for an error response");
  const other = emptySession();
  assert.deepEqual(other.todos, [], "task state never leaks to another session");
});

test("ACP plans and TodoWrite snapshots update the same task display", () => {
  let s = applyUpdate(emptySession(), { sessionUpdate: "plan", entries: [{ content: "Plan step", status: "in_progress" }] });
  assert.equal(s.todos[0].subject, "Plan step");
  assert.equal(s.todos[0].status, "in_progress");
  s = applyUpdate(s, { sessionUpdate: "plan", entries: [{ content: "Plan step", status: "completed" }] });
  assert.equal(s.todos[0].status, "completed");
  s = taskCall(s, "TodoWrite", { todos: [{ id: "x", content: "Tool todo", status: "pending" }] }, "Saved todos");
  assert.deepEqual(s.todos, [{ id: "x", subject: "Tool todo", status: "pending" }]);
  s = taskCall(s, "TodoWrite", { todos: [{ id: "x", content: "Tool todo", status: "completed" }] }, "failed", "bad-write", "failed");
  assert.equal(s.todos[0].status, "pending");
});

test("live task state matches history replay, including late tool inputs", () => {
  const events = [
    { update: { sessionUpdate: "tool_call", toolCallId: "c", title: "TaskCreate", status: "pending" } },
    { update: { sessionUpdate: "tool_call_update", toolCallId: "c", status: "in_progress", rawInput: { subject: "Replay task" } } },
    { update: { sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed", rawOutput: taskResult("Task #1 created successfully: Replay task") } },
    { update: { sessionUpdate: "tool_call", toolCallId: "u", title: "TaskUpdate", status: "completed", rawInput: { taskId: "1", status: "completed" }, rawOutput: taskResult("Updated task #1 status") } },
  ];
  let live = emptySession();
  for (const e of events) live = applyUpdate(live, e.update);
  assert.deepEqual(foldEvents(events).todos, live.todos);
  assert.equal(live.todos[0].status, "completed");
});

test("live text blocks close at the next block and at turn end", () => {
  let s = { ...emptySession(), running: true };
  s = applyUpdate(s, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  const thought = s.items[0].key;
  assert.deepEqual([...activeBlockKeys(s)], [thought]);
  s = applyUpdate(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
  const answer = s.items[1].key;
  assert.deepEqual([...activeBlockKeys(s)], [answer]);
  s = applyUpdate(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " continues" } });
  assert.deepEqual([...activeBlockKeys(s)], [answer]);
  // Non-streaming metadata/plan updates must not close the live text block.
  s = applyUpdate(s, { sessionUpdate: "plan", entries: [] });
  assert.deepEqual([...activeBlockKeys(s)], [answer]);
  assert.equal(activeBlockKeys({ ...s, running: false }).size, 0);
});

test("parallel tools close independently, including failure and cancellation", () => {
  let s = { ...emptySession(), running: true };
  s = applyUpdate(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
  for (const id of ["a", "b"]) {
    s = applyUpdate(s, { sessionUpdate: "tool_call", toolCallId: id, status: "in_progress" });
  }
  const [, a, b] = s.items;
  assert.deepEqual(activeBlockKeys(s), new Set([a.key, b.key]));
  s = applyUpdate(s, { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" });
  assert.deepEqual([...activeBlockKeys(s)], [b.key]);
  assert.equal(activeBlockKeys({ ...s, running: false }).size, 0, "cancelled turn closes unfinished tools");
  s = applyUpdate(s, { sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed" });
  assert.equal(activeBlockKeys(s).size, 0);
});

test("new prompts do not reopen unfinished tools from an older turn", () => {
  const items = [
    { key: "old", kind: "tool", status: "pending" },
    { key: "user", kind: "user", text: "next" },
    { key: "new", kind: "thought", text: "thinking" },
  ];
  assert.deepEqual([...activeBlockKeys({ items, running: true })], ["new"]);
  assert.equal(activeBlockKeys({ items, running: false }).size, 0, "history stays folded");
});

test("UI preferences default safely, persist sidebar density and notify live listeners", () => {
  const values = new Map();
  const storage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  const previous = Object.fromEntries(["localStorage", "document", "window"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const events = [];
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { style: { setProperty() {} }, dataset: {} } } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: (e) => events.push(e.type) } });
    assert.equal(getUi().autoFold, false);
    setUi({ autoFold: "1" });
    assert.equal(storage.getItem("dw.autoFold"), "1");
    assert.equal(getUi().autoFold, true);
    setUi({ autoFold: null });
    assert.equal(getUi().autoFold, false);
    assert.equal(getUi().sessionRows, "single");
    setUi({ sessionRows: "double" });
    assert.equal(storage.getItem("dw.sessionRows"), "double");
    assert.equal(getUi().sessionRows, "double");
    assert.equal(document.documentElement.dataset.sessionRows, "double");
    setUi({ sessionRows: null });
    assert.equal(getUi().sessionRows, "single");
    assert.equal(document.documentElement.dataset.sessionRows, "single");
    storage.setItem("dw.sessionRows", "invalid");
    assert.equal(getUi().sessionRows, "single", "unknown preferences fall back to compact single-line rows");
    assert.deepEqual(events, ["dw-ui", "dw-ui", "dw-ui", "dw-ui"]);
    assert.equal(getUi().terminalTransparency, 0, "terminal defaults to fully opaque");
    const styles = new Map();
    document.documentElement.style.setProperty = (key, value) => styles.set(key, value);
    setUi({ terminalTransparency: 35 });
    assert.equal(storage.getItem("dw.terminalTransparency"), "35");
    assert.equal(getUi().terminalTransparency, 35);
    assert.equal(styles.get("--terminal-opacity"), "0.65");
    assert.equal(events.at(-1), "dw-ui");
    for (const [stored, expected] of [["invalid", 0], ["-20", 0], ["100", 80], ["Infinity", 80], ["33", 35]]) {
      storage.setItem("dw.terminalTransparency", stored);
      assert.equal(getUi().terminalTransparency, expected, "stored terminal transparency is safely bounded");
    }
    setUi({ terminalTransparency: null });
    assert.equal(storage.getItem("dw.terminalTransparency"), null);
    assert.equal(getUi().terminalTransparency, 0);
    assert.equal(styles.get("--terminal-opacity"), "1");
  } finally {
    for (const [k, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete globalThis[k];
    }
  }
});

test("text chunks of the same kind merge into one item", () => {
  const s = foldEvents([
    { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } }, t: T },
    { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } }, t: T + 1 },
  ]);
  assert.equal(s.items.length, 1);
  assert.deepEqual(
    s.items.map(({ kind, text }) => ({ kind, text })),
    [{ kind: "agent", text: "hello world" }]
  );
});

test("different kinds do not merge", () => {
  const s = foldEvents([
    { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }, t: T },
    { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } }, t: T },
  ]);
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0].kind, "thought");
  assert.equal(s.items[1].kind, "agent");
});

test("tool_call then tool_call_update merges by toolCallId, content is replaced not concatenated", () => {
  const s = foldEvents([
    {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "ls",
        kind: "execute",
        status: "pending",
        content: [{ type: "content", content: { type: "text", text: "a" } }],
      },
      t: T,
    },
    {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ab" } }],
      },
      t: T + 1,
    },
  ]);
  assert.equal(s.items.length, 1);
  const item = s.items[0];
  assert.equal(item.kind, "tool");
  assert.equal(item.status, "completed");
  // cumulative snapshot semantics: "ab" replaces "a", never "aab"
  assert.equal(item.content[0].content.text, "ab");
});

test("tool_call_update for an unknown toolCallId creates the item", () => {
  const s = foldEvents([
    { update: { sessionUpdate: "tool_call_update", toolCallId: "late", status: "completed" }, t: T },
  ]);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].toolCallId, "late");
  assert.equal(s.items[0].status, "completed");
});

test("plan updates in place", () => {
  const s = foldEvents([
    { update: { sessionUpdate: "plan", entries: [{ content: "step1", status: "pending" }] }, t: T },
    { update: { sessionUpdate: "plan", entries: [{ content: "step1", status: "completed" }] }, t: T + 1 },
  ]);
  assert.equal(s.items.filter((i) => i.kind === "plan").length, 1);
  assert.equal(s.items[0].entries[0].status, "completed");
});

test("optimistic user bubble is superseded by echo, not duplicated", () => {
  let s = emptySession();
  // optimistic render (what the UI does on send)
  s = { ...s, items: [{ key: "opt", kind: "user", text: "hello", optimistic: true }] };
  s = applyUpdate(s, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } }, T);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].text, "hello");
  assert.equal(s.items[0].optimistic, false);
});

test("duplicate image blocks on user bubble are deduped", () => {
  const img = { sessionUpdate: "user_message_chunk", content: { type: "image", data: "AAAA", mimeType: "image/png" } };
  const s = foldEvents([{ update: img, t: T }, { update: img, t: T + 1 }]);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].images.length, 1);
});

test("usage_update keeps a bounded history", () => {
  const events = [];
  for (let i = 0; i < 50; i++) {
    events.push({ update: { sessionUpdate: "usage_update", used: i, size: 100 }, t: T + i });
  }
  const s = foldEvents(events);
  assert.equal(s.usageHist.length, 40);
  assert.equal(s.usage.used, 49);
});

test("commands / modes / config / title / unknown updates", () => {
  const s = foldEvents([
    { update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact" }] }, t: T },
    { update: { sessionUpdate: "current_mode_update", currentModeId: "high" }, t: T },
    { update: { sessionUpdate: "config_option_update", configOptions: [{ id: "model" }] }, t: T },
    { update: { sessionUpdate: "session_info_update", title: "My session" }, t: T },
    { update: { sessionUpdate: "something_new", foo: 1 }, t: T },
  ]);
  assert.deepEqual(s.commands, [{ name: "compact" }]);
  assert.equal(s.modeId, "high");
  assert.deepEqual(s.configOptions, [{ id: "model" }]);
  assert.equal(s.title, "My session");
  assert.equal(s.items.length, 0);
});

test("compaction replaces stale context usage with an explicit estimate until a new model sample", () => {
  const before = { sessionUpdate: "usage_update", used: 284050, size: 360000 };
  const compact = (id, status, estimatedTokensAfter) => ({ sessionUpdate: "session_info_update", _meta: { piAcp: { compaction: { id, status, estimatedTokensAfter } } } });
  const measured = { sessionUpdate: "usage_update", used: 42000, size: 360000,
    _meta: { piAcp: { contextUsage: { estimated: false, source: "provider" } } } };
  let state = applyUpdate(emptySession(), before);
  state.stats = { input: 1000000, output: 10000 };
  const cumulative = state.stats;
  state = applyUpdate(state, compact("compact", "running"));
  assert.equal(state.usage.used, 284050, "starting compaction has not changed context yet");
  state = applyUpdate(state, compact("compact", "completed", 33309));
  assert.equal(state.usage.used, 33309);
  assert.equal(state.usage.estimated, true);
  assert.equal(state.usageByAgent.root.used, 33309);
  assert.equal(state.stats, cumulative, "compression does not reset lifetime billing totals");
  assert.equal(state.usageHist.at(-1).used, 33309);
  state = applyUpdate(state, measured);
  assert.equal(state.usage.estimated, false);
  state = applyUpdate(state, compact("compact", "completed", 33309));
  assert.equal(state.usage.used, 42000, "a repeated compaction receipt cannot roll back newer model usage");
  for (const status of ["failed", "cancelled"]) {
    state = applyUpdate(state, compact(status, status, 123));
    assert.equal(state.usage.used, 42000);
  }
  state = applyUpdate(state, compact("zero", "completed", 0));
  assert.equal(state.usage.used, 0, "a valid zero estimate is not treated as missing");
  const cold = foldEvents([{ update: compact("cold", "completed") }]);
  assert.equal(cold.usage.used, null, "missing historical estimates are not invented");
  assert.equal(historyUsage(cold.usage, before).used, null, "legacy cache must not resurrect the pre-compaction percentage");
  assert.equal(historyUsage(cold.usage, before).size, 360000);
  assert.equal(historyUsage(cold.usage, measured).used, 42000, "a new bridge supplies the current usage on cold replay");
  const liveReload = foldEvents([{ update: compact("live", "completed", 33309) }]);
  assert.equal(historyUsage(liveReload.usage, before).used, 33309);
  assert.equal(historyUsage(liveReload.usage, before).estimated, true);
  assert.deepEqual(foldEvents([{ update: before }, { update: compact("replay", "completed", 33309) }, { update: measured }]).usage, applyUpdate(emptySession(), measured).usage);
});

test("legacy terminal metadata renders exact output deltas and exit status", () => {
  let s = applyUpdate(emptySession(), { sessionUpdate: "tool_call", toolCallId: "legacy-bash", title: "printf actual", kind: "execute", content: [{ type: "terminal", terminalId: "internal-id" }] });
  const update = (data) => { s = applyUpdate(s, { sessionUpdate: "tool_call_update", toolCallId: "legacy-bash", _meta: { terminal_output: { data } } }); };
  update("part"); update(" complete");
  s = applyUpdate(s, { sessionUpdate: "tool_call_update", toolCallId: "legacy-bash", status: "failed", _meta: { terminal_exit: { exit_code: 7, signal: null } } });
  assert.equal(s.items[0].content[0].content.text, "part complete");
  assert.equal(s.items[0].exitCode, 7);
  assert.equal(s.items[0].status, "failed");
});

test("composer focus, compact sidebar and fixed message actions preserve layout", async () => {
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const { readFile } = await import("node:fs/promises");
  const errors = [], console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(`<style></style><div class="input-card"><textarea class="input-ta"></textarea><button class="tool-ic-btn">附件</button></div>
    <div class="sb-search"><input /></div><button class="icon-ghost">操作</button>
    <div class="msg agent"><div class="agent-body"><p>正文行距不变</p></div><div class="msg-actions"><button>复制</button></div></div>
    <div class="session-row"><div class="sr-top">会话标题</div><div class="sr-meta"><span class="session-status"><span class="st-label">运行中</span></span><span class="sr-time">刚刚</span></div></div>`, { pretendToBeVisual: true, virtualConsole: console });
  try {
    const { document, getComputedStyle } = dom.window;
    const css = await readFile(new URL("../../web/src/styles.css", import.meta.url), "utf8");
    document.querySelector("style").textContent = css;
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
    const unbound = [...new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1]))].filter((name) => !defined.has(name) && name !== "--row");
    assert.deepEqual(unbound, [], "surface tokens cannot silently fall back to transparency");
    const floating = [...document.styleSheets[0].cssRules].find((rule) => rule.selectorText?.includes(".cp-box") && rule.style.background === "var(--elevated)");
    for (const name of ["modal", "cp-box", "ctx-menu", "cfg-panel", "ns-panel", "usage-panel", "acct-panel", "thm-panel", "sb-filter-panel", "slash-menu"]) {
      assert.ok(floating.selectorText.includes(`.${name}`), `${name} shares the same opaque surface`);
    }
    assert.equal(floating.style.borderRadius, "var(--r-md)");
    const actions = document.querySelector(".msg-actions");
    assert.equal(getComputedStyle(actions).position, "absolute", "assistant copy never participates in text layout");
    assert.equal(getComputedStyle(actions).left, "-24px", "the button stays in the existing column gutter");
    assert.equal(getComputedStyle(actions).width, "24px");
    const copyFocus = [...document.styleSheets[0].cssRules].find((rule) => rule.selectorText === ".msg.agent > .msg-actions button:focus-visible");
    assert.equal(copyFocus.style.getPropertyValue("outline-offset"), "-2px", "keyboard focus stays inside the gutter and cannot cover text");
    assert.equal(getComputedStyle(actions).marginTop, "0px");
    assert.equal(getComputedStyle(document.querySelector(".msg.agent")).position, "relative");
    assert.equal(getComputedStyle(document.querySelector(".agent-body")).lineHeight, "1.7", "body readability is unchanged");
    const keyboardActions = [...document.styleSheets[0].cssRules].find((rule) => rule.selectorText?.includes(".msg:focus-within .msg-actions"));
    assert.equal(keyboardActions.style.opacity, "1", "keyboard focus reveals the same button as hover");
    for (const property of ["height", "min-height", "width", "margin-top", "padding", "position", "transform"]) {
      assert.equal(keyboardActions.style.getPropertyValue(property), "", `hover/focus cannot change ${property} and move messages`);
    }
    const textarea = document.querySelector(".input-ta"), card = document.querySelector(".input-card");
    textarea.focus();
    assert.equal(getComputedStyle(textarea).outline, "none", "typing never adds an inner focus rectangle");
    assert.equal(getComputedStyle(textarea).borderTopWidth, "0px");
    assert.equal(getComputedStyle(card).borderTopWidth, "0px");
    assert.equal(getComputedStyle(card).boxShadow, "none", "the shared surface has no outer ring or heavy shadow");
    assert.equal(getComputedStyle(document.querySelector(".tool-ic-btn")).backgroundColor, "rgba(0, 0, 0, 0)");
    const search = document.querySelector(".sb-search input"); search.focus();
    assert.equal(getComputedStyle(search).outline, "none", "search also uses its shared surface rather than nested borders");
    const action = document.querySelector(".icon-ghost"); action.focus();
    assert.match(getComputedStyle(action).outline, /2px/, "keyboard actions still have a visible focus indicator");
    const row = document.querySelector(".session-row"), status = document.querySelector(".st-label");
    assert.equal(getComputedStyle(row).display, "grid");
    assert.ok(parseInt(getComputedStyle(row).minHeight) <= 36, "desktop single-line rows no longer reserve a second line");
    assert.equal(getComputedStyle(status).display, "none");
    document.documentElement.dataset.sessionRows = "double";
    assert.equal(getComputedStyle(row).display, "block");
    assert.equal(getComputedStyle(status).display, "inline");
    document.documentElement.dataset.sessionRows = "single";
    assert.equal(getComputedStyle(row).display, "grid");
    assert.deepEqual(errors, []);
  } finally { dom.window.close(); }
});

test("clipboard fallback preserves original text, focus, selections and scroll without false success", async () => {
  const { JSDOM } = await import("jsdom");
  const { copyText, COPY_FAILED_EVENT } = await import("../../web/src/clipboard.js");
  const dom = new JSDOM('<div id="scroller"><textarea id="draft"></textarea><p id="text">selected transcript text</p></div>', { url: "http://clipboard.test/" });
  const old = Object.fromEntries(["window", "document", "navigator"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of Object.keys(old)) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  try {
    const draft = document.getElementById("draft"), scroller = document.getElementById("scroller");
    draft.value = "untouched composer draft"; draft.focus(); draft.setSelectionRange(2, 8, "backward");
    const range = document.createRange(); range.selectNodeContents(document.getElementById("text"));
    document.getSelection().removeAllRanges(); document.getSelection().addRange(range);
    assert.equal(document.getSelection().toString(), "selected transcript text");
    scroller.scrollTop = 17; scroller.scrollLeft = 9; draft.scrollTop = 3;
    const notices = [], writes = [];
    window.addEventListener(COPY_FAILED_EVENT, (event) => notices.push(event.detail));
    const raw = "  original 中文🚀\r\n\n" + "full hidden content ".repeat(15000);
    let attempts = 0;
    document.execCommand = (command) => {
      attempts++; assert.equal(command, "copy");
      const field = document.activeElement;
      assert.ok(field.matches("[data-clipboard-copy]")); assert.equal(field.readOnly, true); assert.equal(field.inputMode, "none");
      const event = new window.Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { setData: (type, text) => { assert.equal(type, "text/plain"); writes.push(text); } } });
      field.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
      document.getSelection().removeAllRanges(); scroller.scrollTop = 99; scroller.scrollLeft = 42; draft.scrollTop = 28;
      return true;
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    assert.equal(await copyText(raw), true, "missing modern API uses the synchronous user-gesture fallback");
    assert.equal(writes.at(-1), raw, "fallback keeps CRLF, Unicode and the entire oversized original");
    assert.equal(document.activeElement, draft); assert.equal(draft.value, "untouched composer draft");
    assert.deepEqual([draft.selectionStart, draft.selectionEnd, draft.selectionDirection], [2, 8, "backward"]);
    assert.equal(document.getSelection().toString(), "selected transcript text");
    assert.deepEqual([scroller.scrollTop, scroller.scrollLeft, draft.scrollTop], [17, 9, 3]);
    assert.equal(document.querySelector("[data-clipboard-copy]"), null);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("NotAllowedError"); } } });
    assert.equal(await copyText(raw), true, "permission rejection also falls back");
    Object.defineProperty(navigator, "clipboard", { configurable: true, get() { throw new Error("blocked getter"); } });
    assert.equal(await copyText(raw), true, "a throwing Clipboard getter does not suppress legacy copying");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => writes.push(text) } });
    const legacyAttempts = attempts; assert.equal(await copyText(raw), true); assert.equal(attempts, legacyAttempts, "modern success avoids touching focus/selection");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = () => false;
    assert.equal(await copyText(raw, { host: "source-host" }), false);
    assert.deepEqual(notices, [{ host: "source-host" }], "failure is reported without leaking copied text");
    document.execCommand = () => { throw new Error("copy blocked"); };
    assert.equal(await copyText(raw, { silent: true }), false); assert.equal(notices.length, 1, "terminal callers retain their existing local feedback");
    assert.equal(document.querySelector("[data-clipboard-copy]"), null, "exceptions cannot leak hidden fields");
    delete document.execCommand; assert.equal(await copyText(raw, { silent: true }), false);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => assert.fail("cancelled copies must not write") } });
    assert.equal(await copyText(raw, { shouldCopy: () => false }), false);
    assert.equal(document.activeElement, draft);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of Object.entries(old)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

test("chat, Todo, mobile model selection, queue composer and session refresh preserve state", async () => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "FileReader", "navigator"].map((k) => [k, dom.window[k]])),
    fetch: globalThis.fetch,
    WebSocket: class { readyState = 1; sent = []; send(raw) { this.sent.push(JSON.parse(raw)); } close() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  let vite;
  let root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({
      root: new URL("../../web/", import.meta.url).pathname,
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
    });
    const { default: ChatView } = await vite.ssrLoadModule("/src/components/ChatView.jsx");
    const { default: ToolCall, toolPresentation, compactThoughtText } = await vite.ssrLoadModule("/src/components/ToolCall.jsx");
    const spacedThinking = "\n\n**First heading**\n\n\n  \n**Second heading**\n\n";
    assert.equal(compactThoughtText(spacedThinking), "**First heading**\n**Second heading**");
    assert.equal(compactThoughtText("A\r\n\r\n\r\nB"), "A\nB");
    assert.equal(compactThoughtText("\n \n\t"), "");
    assert.equal(compactThoughtText("A\n\nB"), "A\nB", "even a single paragraph spacer must not leave an empty row");
    assert.equal(compactThoughtText("A\nB"), "A\nB", "normal line breaks stay unchanged");
    assert.equal(compactThoughtText("Intro\n\n```text\nA\n\nB\n```\n\nEnd"), "Intro\n```text\nA\n\nB\n```\nEnd", "only code-internal blank lines survive");
    for (const code of ["```text\nA\n\n\nB\n```", "~~~\nA\n\n\nB\n~~~", "````\n```\n\n\nB\n````", "```unfinished\nA\n\n\n", "    A\n\n\n    B"]) {
      assert.equal(compactThoughtText(code), code, "code whitespace survives display compaction");
    }
    assert.equal(toolPresentation({ toolName: "TaskCreate", rawInput: { subject: "Ship UI" } }).label, "TaskCreate");
    assert.equal(toolPresentation({ toolName: "TaskUpdate", rawInput: { taskId: "1", status: "completed" } }).label, "TaskUpdate");
    assert.equal(toolPresentation({ toolName: "read", rawInput: { path: "/tmp/a" } }).label, "read");
    assert.equal(toolPresentation({ toolName: "bash", toolKind: "execute", rawInput: { command: "npm test" } }).label, "bash");
    assert.equal(toolPresentation({ toolName: "functions.grep", toolKind: "execute", rawInput: { command: "search" } }).label, "functions.grep", "execution kind must not override the real tool name");
    assert.equal(toolPresentation({ title: "npm test", toolKind: "execute" }).label, "execute", "missing names fall back to kind, not command text");
    root = createRoot(document.getElementById("root"));
    const { restoreTranscriptAnchor } = await vite.ssrLoadModule("/src/transcriptScroll.js");
    const viewport = document.createElement("div");
    const readingLine = document.createElement("p"), fallbackLine = document.createElement("p");
    viewport.append(readingLine, fallbackLine); document.body.append(viewport);
    viewport.getBoundingClientRect = () => ({ top: 0 });
    readingLine.getBoundingClientRect = () => ({ top: 200, height: 20 });
    fallbackLine.getBoundingClientRect = () => ({ top: 300, height: 20 });
    viewport.scrollTop = 50;
    const anchors = [{ node: readingLine, offset: 80 }, { node: fallbackLine, offset: 100 }];
    assert.ok(restoreTranscriptAnchor(viewport, anchors));
    assert.equal(viewport.scrollTop, 170, "a moved reading line is restored, not pinned to the bottom");
    readingLine.setAttribute("inert", "");
    assert.ok(restoreTranscriptAnchor(viewport, anchors));
    assert.equal(viewport.scrollTop, 370, "folded text yields to a surviving neighbouring anchor");
    viewport.remove();
    let session = { ...emptySession(), historyLoading: false, attached: true, running: true };
    let paletteOpened = 0;
    const noop = () => {};
    const render = (extra = {}) => act(async () => root.render(React.createElement(ChatView, {
      sessionId: "test", session, onSend: noop, onCancel: noop, environmentName: "测试开发机", remote: true, agentName: "Pi", onOpenPalette: () => paletteOpened++, ...extra,
    })));
    const update = async (u) => { session = applyUpdate(session, u); await render(); };
    const expanded = (head) => head.getAttribute("aria-expanded") === "true";
    const roots = () => [...document.querySelectorAll(".stream-root")];
    const childHeads = () => [...document.querySelectorAll(".stream-root .stream-block > .stream-head")];

    await update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "work" } });
    await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: spacedThinking } });
    assert.equal(document.querySelector(".thought-body"), null, "closed thinking doesn't mount expensive hidden text");
    await act(async () => document.querySelector(".thought summary").click());
    assert.equal(document.querySelector(".thought-body").textContent, "**First heading**\n**Second heading**", "ordinary thinking collapses excess blank lines, not Markdown syntax");
    assert.equal(document.querySelector(".thought-body strong"), null);
    assert.equal(session.items.find((item) => item.kind === "thought").text, spacedThinking, "the raw transcript keeps its whitespace");
    assert.equal(roots().length, 0, "setting defaults off");
    await act(async () => setUi({ autoFold: "1" }));
    const firstRoot = roots()[0];
    assert.ok(expanded(firstRoot.querySelector(".stream-head")));
    assert.ok(expanded(childHeads()[0]), "live thought opens under root");
    assert.equal(firstRoot.querySelector(".thought-body").textContent, "**First heading**\n**Second heading**", "live activity uses the same display-only compaction");

    const scroll = firstRoot.querySelector(".stream-scroll");
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 300 },
    });
    await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " more" } });
    assert.equal(scroll.scrollTop, 1200, "root follows live output");
    scroll.scrollTop = 100;
    scroll.dispatchEvent(new Event("scroll"));
    await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " again" } });
    assert.equal(scroll.scrollTop, 100, "reading earlier output pauses follow");
    scroll.scrollTop = 900; scroll.dispatchEvent(new Event("scroll"));
    await act(async () => childHeads()[0].dispatchEvent(new Event("pointerdown", { bubbles: true })));
    await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " reading a disclosure" } });
    assert.equal(scroll.scrollTop, 900, "opening older content suspends the live root's follow before its next resize");

    await update({ sessionUpdate: "tool_call", toolCallId: "a", status: "in_progress", rawInput: { command: "echo hello" } });
    assert.equal(roots()[0], firstRoot, "first tool does not replace the thought root");
    assert.deepEqual(childHeads().map(expanded), [false, true], "thought closes as tool opens");
    await update({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed", content: [
      { type: "content", content: { type: "text", text: "hello" } },
    ] });
    assert.deepEqual(childHeads().map(expanded), [false, false]);
    assert.ok(expanded(firstRoot.querySelector(".stream-head")), "root stays open between calls");
    await update({ sessionUpdate: "tool_call", toolCallId: "b", status: "pending" });
    assert.deepEqual(childHeads().map(expanded), [false, false, true]);
    await update({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed" });
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Visible answer" } });
    assert.equal(expanded(firstRoot.querySelector(".stream-head")), false, "next prose closes root");
    assert.ok(firstRoot.querySelector(".stream-content"), "closing output stays mounted through its slower exit");
    assert.equal(firstRoot.querySelector(".stream-reveal").getAttribute("aria-hidden"), "true");
    assert.equal(document.querySelector(".agent-body").textContent, "Visible answer");
    assert.equal(document.querySelector(".agent-body").closest(".stream-block"), null, "prose is never folded");
    assert.ok(document.querySelector(".msg-bubble").nextElementSibling.matches(".msg-actions"), "side actions share the positioned message content wrapper");
    assert.ok(document.querySelector(".agent-body").nextElementSibling.matches(".msg-actions"), "assistant copy uses the same lightweight action bar");
    const clipboardWrites = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => clipboardWrites.push(text) } });
    await act(async () => document.querySelector('.msg.agent button[aria-label="复制"]').click());
    assert.deepEqual(clipboardWrites, ["Visible answer"]);
    assert.ok(document.querySelector('.msg.agent button[aria-label="已复制"]'));
    const userContent = document.querySelector(".user-message-content"), chatRoot = document.querySelector(".chat");
    const originalUserBounds = userContent.getBoundingClientRect, originalChatBounds = chatRoot.getBoundingClientRect;
    userContent.getBoundingClientRect = () => ({ left: 20, top: 0, width: 150, height: 48 });
    chatRoot.getBoundingClientRect = () => ({ left: 0, width: 200 });
    await act(async () => window.dispatchEvent(new Event("dw-view")));
    assert.ok(userContent.querySelector('.msg-actions.compact [aria-label="更多消息操作"]'), "insufficient side space uses one menu button without a new row");
    await act(async () => userContent.querySelector('[aria-label="更多消息操作"]').click());
    assert.ok([...document.querySelectorAll(".ctx-item")].some((button) => button.textContent.includes("复制")));
    await act(async () => [...document.querySelectorAll(".ctx-item")].find((button) => button.textContent.includes("复制")).click());
    assert.ok(userContent.querySelector('[aria-label="已复制"]'), "the compact trigger confirms copying");
    userContent.getBoundingClientRect = () => ({ left: 400, top: 0, width: 150, height: 48 });
    await act(async () => window.dispatchEvent(new Event("dw-view")));
    assert.equal(userContent.querySelector(".msg-actions.compact"), null, "roomy layouts restore direct actions");
    userContent.getBoundingClientRect = originalUserBounds; chatRoot.getBoundingClientRect = originalChatBounds;


    await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "next segment" } });
    assert.equal(roots().length, 2, "prose separates activity roots");
    assert.ok(expanded(roots()[1].querySelector(".stream-head")));
    session = { ...session, running: false };
    await render();
    assert.ok(roots().every((el) => !expanded(el.querySelector(".stream-head"))), "turn end folds all roots");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 440)));
    assert.equal(firstRoot.querySelector(".stream-content"), null, "closed root releases its body after the transition");
    await act(async () => firstRoot.querySelector(".stream-head").click());
    assert.deepEqual(childHeads().map(expanded), [false, false, false], "manual root expansion shows child headers");
    await act(async () => childHeads()[1].click());
    assert.equal(firstRoot.querySelector(".tool-out").textContent, "hello", "completed output can be reopened");
    await render();
    assert.ok(expanded(childHeads()[1]), "manual expansion survives unrelated renders");
    const toolBody = firstRoot.querySelector(".tool-out");
    await act(async () => childHeads()[1].click());
    assert.equal(firstRoot.querySelector(".tool-out"), toolBody, "closing retains the current output DOM");
    await act(async () => childHeads()[1].click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 440)));
    assert.equal(firstRoot.querySelector(".tool-out"), toolBody, "quick reversal cancels disposal without remounting output");
    await act(async () => setUi({ motion: "off" }));
    await act(async () => childHeads()[1].click());
    assert.equal(firstRoot.querySelector(".tool-out"), null, "reduced motion releases the closed body immediately");
    await act(async () => setUi({ motion: null }));
    await act(async () => setUi({ autoFold: null }));
    assert.equal(roots().length, 0);
    assert.ok(document.querySelector(".toolgroup"), "disabling restores original groups");
    assert.equal(document.querySelector(".agent-body").textContent, "Visible answer");

    session = { ...emptySession(), historyLoading: false, gen: 100, attached: true, running: true,
      telemetry: { live: { tokens: 20, elapsedMs: 1000, idleMs: 0, stale: false } } };
    await render();
    const rateNode = document.querySelector(".running-hint .tps");
    const firstRate = rateNode.textContent;
    for (let i = 0; i < 8; i++) {
      session = { ...session, telemetry: { live: { tokens: 40 + i, elapsedMs: 1000, idleMs: 0, stale: false } } };
      await render();
      assert.equal(document.querySelector(".running-hint .tps"), rateNode, "new snapshots never unmount the rate readout");
    }
    assert.equal(rateNode.textContent, firstRate, "stream chunks do not redraw digits faster than the display clock");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 270)));
    assert.notEqual(rateNode.textContent, firstRate, "the display clock uses the latest snapshot");
    session = { ...session, telemetry: { live: { tps: 34.2, stale: true } } };
    await render();
    assert.equal(document.querySelector(".tps.stale"), rateNode, "tool status changes without remounting");
    assert.match(rateNode.textContent, /34\.2 tok\/s/);
    session = { ...session, gen: 101, telemetry: { live: { tokens: 3, elapsedMs: 1000, idleMs: 0, stale: false } } };
    await render();
    assert.ok(parseFloat(rateNode.querySelector(".tps-value").textContent) <= 3, "new generations do not reuse the prior reading");
    session = { ...session, running: false, telemetry: { live: null } };
    await render();
    assert.equal(document.querySelector(".running-hint .tps"), null, "turn end clears the live readout");

    session = { ...emptySession(), historyLoading: false, attached: true, items: [
      { key: "search-thought", kind: "thought", text: "past thinking" },
      { key: "search-tool", kind: "tool", status: "completed", toolName: "read", rawInput: { path: "input-needle" },
        content: [{ type: "content", content: { type: "text", text: "hidden-needle" } }], rawOutput: { result: "raw-needle" } },
      { key: "search-exec", kind: "tool", status: "completed", toolName: "bash",
        rawInput: { command: "echo hello", workdir: "exec-needle" } },
    ] };
    const searchInput = async (value) => {
      await act(async () => {
        const input = document.querySelector(".ts-search input");
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
    };
    assert.match(document.querySelector(".chat-context").textContent, /远程 · 测试开发机.*Pi/);
    const openChatActions = () => act(async () => {
      const trigger = document.querySelector('[aria-label="更多会话操作"]'); trigger.focus(); trigger.click();
    });
    const clickMenu = (label) => act(async () => [...document.querySelectorAll(".ctx-item")].find((element) => element.textContent === label).click());
    const escapeLayer = () => act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await openChatActions();
    await act(async () => [...document.querySelectorAll(".ctx-item")].find((e) => e.textContent === "搜索对话").click());
    assert.ok(document.querySelector('[aria-label="搜索对话内容"]'), "search has a touch-accessible entry");
    await act(async () => document.querySelector('.ts-search button[title="关闭 (Esc)"]').click());
    await openChatActions();
    await act(async () => [...document.querySelectorAll(".ctx-item")].find((e) => e.textContent === "命令面板").click());
    assert.equal(paletteOpened, 1);
    await openChatActions();
    assert.equal(document.querySelectorAll(".ctx-item").length, 3, "view choices no longer crowd the top-level menu");
    await clickMenu("对话视图");
    assert.equal(document.querySelectorAll(".ctx-menu").length, 1, "a submenu reuses one opaque surface");
    await escapeLayer();
    assert.equal(document.activeElement.textContent, "对话视图", "Escape returns focus to the parent choice");
    await clickMenu("对话视图");
    await clickMenu("紧凑");
    assert.ok(document.activeElement === document.querySelector('[aria-label="更多会话操作"]'), "a completed nested choice restores the original trigger");
    assert.equal(document.documentElement.dataset.view, "compact");
    await openChatActions();
    await clickMenu("对话视图");
    await clickMenu("默认");
    const startSearch = () => act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", ctrlKey: true })));
    const closeSearch = () => act(async () => document.querySelector('.ts-search button[title="关闭 (Esc)"]').click());
    await act(async () => setUi({ autoFold: "1" }));
    await render();
    await startSearch();
    await searchInput("raw-needle");
    assert.equal(document.querySelector(".stream-root > .stream-head").getAttribute("aria-expanded"), "true");
    assert.ok(document.querySelector(".raw[open]"), "search opens the matching raw output");
    await closeSearch();
    assert.equal(document.querySelector(".stream-root > .stream-head").getAttribute("aria-expanded"), "false", "closing search restores automatic disclosure");
    await startSearch();
    await searchInput("exec-needle");
    assert.match(document.querySelector(".raw[open]").textContent, /exec-needle/, "command arguments beyond the displayed command remain searchable");
    await closeSearch();
    await act(async () => setUi({ autoFold: null }));
    await startSearch();
    await searchInput("hidden-needle");
    assert.ok(document.querySelector(".toolgroup.open .tool.open"), "classic groups and their matching tool also open");
    await closeSearch();
    assert.equal(document.querySelector(".toolgroup.open"), null, "classic group manual state is restored");

    session = { ...session, running: true, todos: [{ id: "1", subject: "First task", status: "pending" }, { id: "2", subject: "Second task", status: "completed" }] };
    await render();
    const todoHead = () => document.querySelector(".todo-notice:not([hidden]) .todo-notice-head") || document.querySelector(".todo-dock-trigger");
    assert.ok(expanded(todoHead()), "new Todo notification opens automatically");
    assert.ok(document.querySelector(".todo-notice").parentElement.matches(".chat"), "Todo floats directly in the chat, outside the header");
    assert.equal(document.querySelector(".todo-host, .todo-panel, .todo-scrim"), null, "Todo reserves no side rail and opens no modal");
    assert.equal(document.querySelectorAll('.todo-check[aria-checked="true"]').length, 1);
    await act(async () => todoHead().click());
    session = { ...session, todos: session.todos.map((task) => task.id === "1" ? { ...task, status: "in_progress", activeForm: "Working on first task" } : task) };
    await render();
    assert.equal(expanded(todoHead()), false, "ordinary updates respect a manual fold");
    assert.ok(document.querySelector(".chat-head .todo-dock-trigger"), "collapsed Todo stays in the header, not over transcript");
    assert.ok(document.querySelector(".todo-notice").hidden);
    assert.match(document.querySelector(".todo-dock-trigger").textContent, /1\/2/);
    assert.ok(document.querySelector(".todo-dock-trigger .spin"), "active tasks spin while the session is running");
    const originalTasks = session.todos, originalTaskData = JSON.stringify(originalTasks);
    session = { ...session, running: false }; await render();
    assert.equal(expanded(todoHead()), false, "stopping does not reopen a manually folded list");
    assert.equal(document.querySelector(".todo-dock-trigger .spin"), null, "stopped sessions have no animated Todo header");
    assert.match(document.querySelector(".todo-dock-trigger").textContent, /1\/2.*已暂停/);
    assert.match(document.querySelector(".todo-dock-trigger").getAttribute("aria-label"), /已暂停/);
    await act(async () => todoHead().click());
    assert.equal(document.querySelector(".todo-notice .spin"), null, "unfinished historical tasks do not spin after stopping");
    const pausedTask = document.querySelector('.todo-entry[data-status="in_progress"]');
    assert.ok(pausedTask.classList.contains("paused"));
    assert.match(pausedTask.textContent, /First task.*已暂停/);
    assert.ok(!pausedTask.textContent.includes("Working on first task"), "paused tasks show their subject rather than an ongoing-action verb");
    assert.equal(pausedTask.querySelector(".todo-check").getAttribute("aria-label"), "已暂停");
    assert.equal(pausedTask.querySelector(".todo-check").getAttribute("aria-checked"), "false");
    assert.equal(document.querySelectorAll('.todo-check[aria-checked="true"]').length, 1, "stopping never completes unfinished tasks");
    session = { ...session, running: true }; await render();
    assert.ok(expanded(todoHead()), "resuming preserves the user's disclosure choice");
    assert.ok(document.querySelector('.todo-entry.in_progress .spin'), "resuming restores the spinner");
    assert.match(document.querySelector('.todo-entry.in_progress').textContent, /Working on first task/);
    assert.equal(document.querySelector('.todo-entry.paused'), null);
    assert.equal(session.todos, originalTasks, "run-state changes never replace the task records");
    assert.equal(JSON.stringify(session.todos), originalTaskData, "pause/resume is presentation-only");
    session = { ...session, todos: session.todos.map((task) => ({ ...task, status: "completed" })) };
    await render();
    assert.equal(expanded(todoHead()), false, "completing the batch folds the notification");
    assert.equal(document.querySelector(".todo-entries"), null, "completed tasks collapse into the compact floating header");
    await act(async () => todoHead().click());
    assert.ok(expanded(todoHead()), "finished tasks remain manually readable");
    assert.equal(document.querySelectorAll('.todo-check[aria-checked="true"]').length, 2);
    session = { ...session, todos: [...session.todos, { id: "3", subject: "New work", status: "pending" }] };
    await render();
    assert.ok(expanded(todoHead()), "new unfinished work opens the notification again");
    await act(async () => {
      const list = document.querySelector(".todo-entries");
      list.focus();
      list.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(expanded(todoHead()), false, "Escape folds the focused floating list");
    assert.equal(document.activeElement, document.querySelector(".todo-dock-trigger"));
    const animations = [];
    const originalAnimate = window.HTMLElement.prototype.animate;
    window.HTMLElement.prototype.animate = function (frames, options) {
      const animation = { frames, options, onfinish: null, cancelled: false, cancel() { this.cancelled = true; } };
      animations.push(animation);
      return animation;
    };
    await act(async () => todoHead().click());
    assert.equal(animations.at(-1).options.duration, 260);
    await act(async () => todoHead().click());
    assert.ok(animations[0].cancelled, "closing interrupts the in-flight expansion");
    assert.equal(animations.at(-1).options.duration, 220);
    assert.ok(document.querySelector(".todo-notice.closing .todo-entries[inert]"), "exit keeps content for the retract animation but disables interaction");
    assert.equal(document.querySelector(".todo-entries").getAttribute("aria-hidden"), "true");
    await act(async () => animations.at(-1).onfinish());
    assert.equal(document.querySelector(".todo-entries"), null, "exit removes content only after retraction finishes");
    await act(async () => todoHead().click());
    await act(async () => todoHead().click());
    const oldFinish = animations.at(-1).onfinish;
    await act(async () => todoHead().click());
    await act(async () => oldFinish());
    assert.ok(expanded(todoHead()), "a stale close callback cannot collapse a reversed expansion");
    await act(async () => animations.at(-1).onfinish());
    const animatedCount = animations.length;
    await act(async () => setUi({ motion: "off" }));
    await act(async () => todoHead().click());
    assert.equal(animations.length, animatedCount, "disabled motion closes immediately without a Web Animation");
    assert.equal(document.querySelector(".todo-entries"), null);
    await act(async () => setUi({ motion: null }));
    await act(async () => todoHead().click());
    session = { ...session, todos: [] };
    await render();
    assert.ok(animations.at(-1).cancelled, "unmount cancels the active animation");
    if (originalAnimate) window.HTMLElement.prototype.animate = originalAnimate;
    else delete window.HTMLElement.prototype.animate;
    assert.equal(document.querySelector(".todo-notice"), null, "empty sessions have no Todo notification");

    const longPrompt = Array.from({ length: 25 }, (_, i) => `Line ${i + 1}: exact user input 中文🚀${i === 24 ? " message-tail-needle" : ""}`).join("\n");
    const otherPrompt = longPrompt.replace("message-tail-needle", "other-tail-needle");
    const sentPrompts = [], editedPrompts = [];
    const promptActions = { onSend: (blocks) => sentPrompts.push(blocks), onEditPrompt: (text) => editedPrompts.push(text) };
    const longItem = Object.freeze({ key: "long-user", kind: "user", text: longPrompt, images: ["data:image/png;base64,fixture"] });
    session = { ...emptySession(), historyLoading: false, attached: true, items: [longItem, { key: "long-other", kind: "user", text: otherPrompt }, { key: "short-user", kind: "user", text: "Short prompt" }] };
    await render(promptActions);
    const userMessages = () => [...document.querySelectorAll(".msg.user")];
    const userText = (index = 0) => userMessages()[index].querySelector(".user-message-text");
    const userToggle = (index = 0) => userMessages()[index].querySelector(".user-message-toggle");
    assert.equal(userText().dataset.collapsed, "true", "long user prompts start collapsed");
    assert.equal(userText().textContent, longPrompt, "collapsing never slices or reformats the original text");
    assert.equal(userToggle(2), null, "short prompts have no expand affordance");
    assert.equal(userMessages()[0].querySelectorAll(".msg-imgs img").length, 1, "images are outside the text clamp");
    assert.equal(document.getElementById(userToggle().getAttribute("aria-controls")), userText());
    const originalTextNode = userText().firstChild;
    await act(async () => userToggle().click());
    assert.equal(userText().dataset.collapsed, "false");
    assert.equal(userToggle().getAttribute("aria-expanded"), "true");
    assert.equal(userText(1).dataset.collapsed, "true", "expansion is local to one message");
    await act(async () => userToggle().click());
    assert.equal(userText().dataset.collapsed, "true");
    assert.equal(userText().firstChild, originalTextNode, "toggle retains the same complete DOM text node");
    await act(async () => userMessages()[0].querySelector('[aria-label="复制"]').click());
    assert.equal(clipboardWrites.at(-1), longPrompt, "copy includes the hidden tail");
    await act(async () => userMessages()[0].querySelector('[aria-label="原样重发"]').click());
    await act(async () => userMessages()[0].querySelector('[aria-label="编辑后重新发送"]').click());
    assert.deepEqual(sentPrompts, [[{ type: "text", text: longPrompt }]]);
    assert.deepEqual(editedPrompts, [longPrompt]);
    await startSearch(); await searchInput("message-tail-needle");
    assert.equal(userText().dataset.collapsed, "false", "a hidden tail search result opens before highlighting");
    assert.equal(userToggle(), null, "a forced search match cannot be accidentally re-collapsed");
    assert.equal(userText(1).dataset.collapsed, "true", "unmatched long prompts remain clamped");
    await closeSearch();
    assert.equal(userText().dataset.collapsed, "true", "closing search restores the default preview");
    await act(async () => userToggle().click());
    await startSearch(); await searchInput("other-tail-needle");
    assert.equal(userText(1).dataset.collapsed, "false");
    await closeSearch();
    assert.equal(userText().dataset.collapsed, "false", "search preserves an explicit manual expansion");
    assert.equal(userText(1).dataset.collapsed, "true");
    assert.equal(longItem.text, longPrompt);
    assert.equal(sentPrompts.length, 1, "reading and searching never sends a message");

    let markdownReads = 0;
    const stableMessage = { key: "stable-md", kind: "agent", get text() { markdownReads++; return "**Static history**\n\n```js\nconst value = 1;\n```"; } };
    session = { ...emptySession(), historyLoading: false, attached: true, items: [stableMessage] };
    await render(); markdownReads = 0;
    session = { ...session, telemetry: { live: { tokens: 100, elapsedMs: 2000 } } };
    await render();
    assert.equal(markdownReads, 0, "telemetry-only renders do not reparse unchanged historical Markdown");
    session = { ...session, attached: false }; await render();
    session = { ...session, attached: true }; await render();
    assert.equal(markdownReads, 0, "user-only action availability does not invalidate assistant Markdown");

    let oldToolReads = 0;
    const oldTool = Object.freeze({ key: "old-tool", kind: "tool", title: "read", get status() { oldToolReads++; return "completed"; }, rawInput: { path: "old.txt" } });
    const oldItems = Object.freeze([{ key: "old-u", kind: "user", text: "old turn" }, { key: "old-th", kind: "thought", text: "old thinking" }, oldTool,
      { key: "old-a", kind: "agent", text: "old answer" }, { key: "new-u", kind: "user", text: "new turn" }, { key: "new-a", kind: "agent", text: "new reply" }]);
    await act(async () => setUi({ autoFold: "1" }));
    session = { ...emptySession(), historyLoading: false, attached: true, running: true, items: oldItems }; await render(); oldToolReads = 0;
    session = { ...session, items: [...oldItems.slice(0, -1), { ...oldItems.at(-1), text: "new reply continued" }] }; await render();
    assert.equal(oldToolReads, 0, "streaming a new turn does not re-render inactive historical tool groups");
    assert.equal(oldItems.length, 6, "derived run building never mutates persisted message arrays");
    await act(async () => setUi({ autoFold: null }));

    const { highlightCode } = await import("../../web/src/syntaxHighlight.worker.js");
    const flatten = (nodes) => nodes.map((node) => node.type === "text" ? node.value : flatten(node.children || [])).join("");
    for (const source of ["const x = '<script>';\n", "// 中文\nconst x = 1;\n", "a\r\nb\t\n"]) {
      const result = highlightCode(source, "js");
      assert.equal(flatten(result.nodes), source, "syntax coloring preserves all code characters");
    }
    assert.equal(highlightCode("x".repeat(200001), "js"), null, "oversized code remains complete plain text, not thousands of syntax spans");
    assert.equal(highlightCode("const value = 1;\n".repeat(1500), "js"), null, "syntax-node count is bounded independently of source length");
    assert.equal(flatten(highlightCode("unknown source\n", "unknown-language").nodes), "unknown source\n");
    const savedGlobals = Object.fromEntries(["Worker", "IntersectionObserver"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const workers = [], observers = [];
    class FakeWorker {
      jobs = [];
      constructor() { workers.push(this); }
      postMessage(job) { this.jobs.push(job); }
      terminate() { this.terminated = true; }
      deliver(job) { this.onmessage({ data: { id: job.id, result: highlightCode(job.code, job.language) } }); }
    }
    class FakeObserver {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {} disconnect() {}
      show() { this.callback([{ isIntersecting: true, boundingClientRect: { width: 500 } }]); }
      hide() { this.callback([{ isIntersecting: false, boundingClientRect: { width: 500 } }]); }
    }
    try {
      globalThis.Worker = FakeWorker; globalThis.IntersectionObserver = FakeObserver;
      const { default: CodePre } = await vite.ssrLoadModule("/src/components/CodePre.jsx");
      const { TranscriptSearch } = await vite.ssrLoadModule("/src/transcriptSearch.js");
      const code = (source, searching = false) => act(async () => root.render(React.createElement(TranscriptSearch.Provider, { value: { query: searching ? "value" : "", keys: new Set() } },
        React.createElement(CodePre, null, React.createElement("code", { className: "language-js" }, source)))));
      await code("const value = 1;\n");
      assert.equal(workers.length, 0, "offscreen code does not start or load a worker");
      assert.equal(document.querySelector(".code-card code").textContent, "const value = 1;\n");
      await act(async () => observers.at(-1).show());
      assert.equal(workers.length, 1);
      const worker = workers[0], oldJob = worker.jobs[0];
      await code("const value = 2;\n"); await code("const value = 3;\n");
      assert.equal(worker.jobs.length, 1, "only one job is posted; stream updates coalesce while it runs");
      await act(async () => worker.deliver(oldJob));
      assert.equal(document.querySelector(".code-card code").textContent, "const value = 3;\n", "stale coloring cannot replace new code");
      assert.equal(worker.jobs.length, 2); assert.equal(worker.jobs[1].code, "const value = 3;\n");
      await act(async () => worker.deliver(worker.jobs[1]));
      assert.ok(document.querySelector(".hljs-keyword"));
      await code("const value = 3;\n", true);
      assert.equal(document.querySelector(".code-card code span"), null, "search owns stable plain-text Range nodes");
      await code("const value = 3;\n");
      assert.ok(document.querySelector(".hljs-keyword"), "cached coloring returns after search");
      assert.equal(worker.jobs.length, 2, "a cache hit does not re-run syntax parsing");
      await act(async () => observers.at(-1).hide());
      assert.equal(document.querySelector(".code-card code span"), null, "offscreen syntax spans are released without removing text");
      assert.equal(document.querySelector(".code-card code").textContent, "const value = 3;\n");
      await act(async () => observers.at(-1).show());
      assert.ok(document.querySelector(".hljs-keyword"));
      assert.equal(worker.jobs.length, 2, "returning to view reuses the bounded cache");
      await act(async () => document.querySelector(".cc-copy").click());
      assert.equal(clipboardWrites.at(-1), "const value = 3;\n", "copy always uses the full original text");
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      const originalExec = document.execCommand;
      document.execCommand = () => false;
      await act(async () => document.querySelector(".cc-copy").click());
      assert.equal(document.querySelector(".cc-copy").textContent.trim(), "复制", "failed code copy must not claim success");
      const fallbackCopies = [];
      document.execCommand = () => { fallbackCopies.push(document.activeElement.value); return true; };
      await act(async () => document.querySelector(".cc-copy").click());
      assert.equal(fallbackCopies.at(-1), "const value = 3;\n");
      assert.equal(document.querySelector(".cc-copy").textContent.trim(), "已复制");
      let finishOldCopy;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => new Promise((resolve) => { finishOldCopy = resolve; }) } });
      await act(async () => document.querySelector(".cc-copy").click());
      await code("new text while the earlier copy is pending");
      await act(async () => finishOldCopy());
      assert.equal(document.querySelector(".cc-copy").textContent.trim(), "复制", "late success belongs to the old source, not the new code");
      if (originalExec) document.execCommand = originalExec; else delete document.execCommand;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => clipboardWrites.push(text) } });
      await act(async () => worker.onerror({ preventDefault() {} }));
      await code("const value = 4;\n");
      assert.equal(document.querySelector(".code-card code").textContent, "const value = 4;\n", "worker failure safely leaves the complete code readable");
    } finally {
      for (const [name, descriptor] of Object.entries(savedGlobals)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
    }

    const { default: InputBar } = await vite.ssrLoadModule("/src/components/InputBar.jsx");
    const sent = [], configs = [], previews = [];
    let cancelled = 0;
    const composer = (running = true, disabled = false, extra = {}) => act(async () => root.render(React.createElement(InputBar, {
      sessionId: "composer", running, disabled, onSend: (blocks) => sent.push(blocks), onCancel: () => cancelled++, onPreviewImage: (src) => previews.push(src), ...extra,
    })));
    const fill = (element, value) => {
      const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const matchMedia = window.matchMedia;
    window.matchMedia = () => ({ matches: true });
    await composer();
    assert.ok(document.querySelector(".stop"));
    await act(async () => fill(document.querySelector(".input-ta"), "next instruction"));
    assert.ok(document.querySelector(".stop"), "typing keeps an independent stop action beside queue-send");
    assert.equal(document.querySelector(".send").getAttribute("aria-label"), "排队发送");
    await act(async () => {
      const enter = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      document.querySelector(".input-ta").dispatchEvent(enter);
      assert.equal(enter.defaultPrevented, false, "mobile Enter is still a newline");
    });
    assert.equal(sent.length, 0);
    await act(async () => document.querySelector(".send").click());
    assert.deepEqual(sent, [[{ type: "text", text: "next instruction" }]]);
    assert.equal(cancelled, 0, "queue sending must not cancel the active task");
    assert.ok(document.querySelector(".stop"), "empty composer restores stop after enqueueing");
    await act(async () => fill(document.querySelector(".input-ta"), " \n"));
    assert.ok(document.querySelector(".stop"), "whitespace alone is not a message");
    await act(async () => document.querySelector(".stop").click());
    assert.equal(cancelled, 1);
    const attachImage = () => act(async () => {
      const upload = document.querySelector('input[type="file"]');
      Object.defineProperty(upload, "files", { configurable: true, value: [new window.File(["image"], "phone.png", { type: "image/png" })] });
      upload.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await attachImage();
    await act(async () => document.querySelector(".img-preview").click());
    assert.match(previews[0], /^data:image\/png;base64,/);
    assert.equal(sent.length, 1, "preview does not send or remove the attachment");
    assert.ok(document.querySelector(".img-preview"));
    await act(async () => document.querySelector(".img-remove").click());
    assert.equal(previews.length, 1, "remove does not also open preview");
    assert.ok(document.querySelector(".stop"));
    await attachImage();
    assert.equal(document.querySelector(".send").getAttribute("aria-label"), "排队发送", "an image-only draft can be queued");
    assert.ok(document.querySelector(".stop"), "attachments never hide stop either");
    await act(async () => document.querySelector(".send").click());
    assert.equal(sent[1][0].type, "image");
    assert.ok(document.querySelector(".stop"));
    await act(async () => fill(document.querySelector(".input-ta"), "offline draft"));
    await composer(true, true);
    assert.ok(document.querySelector(".send").disabled);
    await composer(false);
    assert.equal(document.querySelector(".send").getAttribute("aria-label"), "发送");
    window.matchMedia = () => ({ matches: false });
    await act(async () => document.querySelector(".input-ta").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
    assert.equal(sent.length, 2, "IME confirmation never submits a draft");
    await act(async () => document.querySelector(".input-ta").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true })));
    assert.equal(sent.length, 2, "legacy WebView IME confirmation never submits either");
    await act(async () => document.querySelector(".input-ta").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.equal(sent.length, 3, "desktop Enter still submits");
    await composer(false, false, { onSend: () => false });
    await act(async () => fill(document.querySelector(".input-ta"), "keep this draft"));
    await act(async () => document.querySelector(".send").click());
    assert.equal(document.querySelector(".input-ta").value, "keep this draft", "synchronous transport failure never clears input");
    window.matchMedia = matchMedia;

    await composer(false);
    const attachFile = (file) => act(async () => {
      const upload = document.querySelector('input[type="file"]');
      Object.defineProperty(upload, "files", { configurable: true, value: [file] });
      upload.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await attachFile(new window.File(["plain text"], "readme.txt", { type: "text/plain" }));
    assert.equal(document.querySelector(".file-chip span").textContent, "readme.txt", "ordinary text is a valid attachment");
    await act(async () => document.querySelector(".send").click());
    assert.equal(sent.at(-1)[0].resource.text, "plain text");
    await attachFile(new window.File(["binary\u0000payload"], "binary.bin"));
    assert.equal(document.querySelector(".file-chip"), null);
    assert.match(document.querySelector('.input-error[role="alert"]').textContent, /二进制文件/);
    await attachFile(new window.File(["x".repeat(200 * 1024 + 1)], "large.txt", { type: "text/plain" }));
    assert.match(document.querySelector(".input-error").textContent, /超过 200KB/);
    await act(async () => document.querySelector('[aria-label="关闭附件提示"]').click());
    assert.equal(document.querySelector(".input-error"), null);

    const draftBlocks = [
      { type: "text", text: "review @src/main.js" },
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      { type: "resource", resource: { uri: "file:///notes.txt", mimeType: "text/plain", text: "draft notes" } },
      { type: "resource_link", name: "src/main.js", uri: "file:///project/src/main.js" },
    ];
    await composer(false, false, { inject: { sessionId: "composer", n: 1, blocks: draftBlocks } });
    assert.ok(document.querySelector(".img-preview"));
    assert.ok(document.querySelector(".file-chip"));
    await composer(false, false, { sessionId: "other-composer" });
    assert.equal(document.querySelector(".input-ta").value, "");
    assert.equal(document.querySelectorAll(".img-preview,.file-chip").length, 0, "draft attachments never cross sessions");
    await composer(false);
    assert.equal(document.querySelector(".input-ta").value, "review @src/main.js");
    assert.equal(document.querySelectorAll(".img-preview,.file-chip").length, 2);
    const { readDraft: readAfterReload, saveDraft: saveReloadedDraft, emptyDraft: blankDraft } = await vite.ssrLoadModule("/src/composerDrafts.js?reload");
    const reloadedDraft = readAfterReload("composer");
    assert.equal(reloadedDraft.images[0].data, "aW1hZ2U=");
    assert.equal(reloadedDraft.files[0].data, "draft notes");
    assert.equal(reloadedDraft.refs.get("src/main.js"), "/project/src/main.js", "tab storage restores reference paths as well as text");
    const largeDraft = { ...blankDraft("quota-composer"), images: [{ mimeType: "image/png", data: "x".repeat(2 * 1024 * 1024) }] };
    assert.match(saveReloadedDraft(largeDraft), /限额/);
    assert.equal(sessionStorage.getItem("devin-web.attachments.quota-composer"), null);
    assert.equal(readAfterReload("quota-composer").images.length, 1, "quota fallback keeps the in-memory draft");
    await act(async () => document.querySelector(".send").click());
    assert.deepEqual(sent.at(-1).find((b) => b.type === "resource_link"), draftBlocks[3]);
    assert.equal(sessionStorage.getItem("devin-web.attachments.composer"), null, "successful send clears tab-local attachments");
    assert.equal(localStorage.getItem("devin-web.draft.composer"), null);

    const { default: ConfigMenu } = await vite.ssrLoadModule("/src/components/ConfigMenu.jsx");
    const longName = "deepseek-nothink/DeepSeek V4 Flash (classifier with a very long model name)";
    await act(async () => root.render(React.createElement(ConfigMenu, { selects: [{ id: "model", category: "model", name: "模型", currentValue: "sol", options: [
      { value: "sol", name: "openai-codex/GPT-6.1 Sol" }, { value: "terra", name: "openai-codex/GPT-6.1 Terra" }, { value: "classifier", name: longName },
    ] }], onConfig: (id, value) => configs.push([id, value]) })));
    await act(async () => document.querySelector(".cfg-trigger").click());
    await act(async () => document.querySelector(".cfg-row .ns-trigger").click());
    assert.equal(document.querySelector(".ns-floating").parentElement, document.body, "model list escapes the clipping config parent");
    assert.ok(document.querySelector('input[aria-label="搜索模型"]'), "even a three-model list has search");
    assert.equal(document.querySelector(".cfg-label").textContent, "GPT-6.1 Sol", "the composer keeps the actual model name, not its provider prefix");
    assert.ok([...document.querySelectorAll(".ns-name")].some((element) => element.textContent === longName.split("/").slice(1).join("/")));
    assert.equal(document.querySelectorAll(".ns-desc")[0].textContent, "openai-codex", "the provider remains visible in menu details");
    assert.ok([...document.querySelectorAll(".ns-item")].some((element) => element.title === longName));
    await act(async () => {
      const input = document.querySelector(".ns-search input");
      input.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
      fill(input, "classifier");
    });
    assert.ok(document.querySelector(".cfg-panel"), "touching the portaled search does not dismiss its owner");
    assert.equal(document.querySelectorAll(".ns-item").length, 1);
    await act(async () => document.querySelector(".ns-search input").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    assert.equal(document.activeElement.getAttribute("role"), "option", "ArrowDown enters filtered model options");
    await act(async () => {
      const option = document.querySelector(".ns-item");
      option.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
      option.click();
    });
    assert.deepEqual(configs, [["model", "classifier"]]);
    assert.equal(document.querySelector(".ns-floating"), null);
    await act(async () => document.querySelector(".cfg-row .ns-trigger").click());
    await act(async () => document.querySelector(".ns-search input").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(document.querySelector(".ns-floating"), null);
    assert.ok(document.querySelector(".cfg-panel"), "Escape closes only the model list first");
    assert.equal(document.activeElement, document.querySelector(".cfg-row .ns-trigger"));

    await act(async () => document.querySelector(".cfg-row .ns-trigger").click());
    await act(async () => { history.back(); await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.equal(document.querySelector(".ns-floating"), null, "Back closes only the top model layer");
    assert.ok(document.querySelector(".cfg-panel"));
    await act(async () => { history.back(); await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.equal(document.querySelector(".cfg-panel"), null, "a second Back closes its parent");

    await act(async () => root.render(React.createElement(ToolCall, { item: { key: "flat-exec", toolName: "bash", status: "failed", exitCode: 7,
      rawInput: { command: "printf fixture", workdir: "/tmp/project" }, rawOutput: { exit: 7 },
      content: [{ type: "content", content: { type: "text", text: "actual stdout" } }] } })));
    await act(async () => document.querySelector(".tool-head").click());
    assert.ok(document.querySelector(".tool.failed"));
    assert.equal(document.querySelector(".term-card"), null, "command output does not add another framed card");
    assert.equal(document.querySelector(".tool-exit.failed").textContent, "退出 7");
    assert.equal(document.querySelector(".tool-workdir").title, "/tmp/project");
    assert.equal(document.querySelector(".term-scroll .tool-out").textContent, "actual stdout");
    assert.ok([...document.querySelectorAll(".raw")].some((element) => !element.open && element.querySelector("summary").textContent === "原始输出"));

    session = { ...foldEvents([
      { update: { sessionUpdate: "usage_update", used: 284050, size: 360000 } },
      { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "before compression" } } },
      { update: { sessionUpdate: "session_info_update", _meta: { piAcp: { compaction: { id: "ui-compaction", at: 100000, status: "completed", tokensBefore: 35000, estimatedTokensAfter: 8000, summary: "compaction-summary-needle", reason: "manual" } } } } },
      { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after compression" } } },
    ]), historyLoading: false, attached: true, running: true, stats: { input: 1000000, output: 10000 } };
    await render();
    assert.equal(document.querySelector(".ctx-pct").textContent, "≈2%");
    await act(async () => document.querySelector(".ctx-meter").click());
    assert.match(document.querySelector(".usage-panel").textContent, /上下文（估算）.*≈8.0k.*会话累计.*不随上下文压缩减少/s);
    session = applyUpdate(session, { sessionUpdate: "usage_update", used: 42000, size: 360000, _meta: { piAcp: { contextUsage: { estimated: false, source: "provider" } } } });
    await render();
    assert.equal(document.querySelector(".ctx-pct").textContent, "12%", "model usage replaces the estimate while the task is still running");
    assert.doesNotMatch(document.querySelector(".usage-panel").textContent, /上下文（估算）/);
    await escapeLayer();
    const compaction = document.querySelector(".compaction-node");
    assert.equal(compaction.open, false, "compression information starts as a compact separator");
    assert.match(compaction.querySelector("summary").textContent, /上下文已压缩.*35,000.*8,000/);
    assert.equal(document.querySelectorAll(".msg.agent").length, 1, "compression is not a second assistant reply");
    await startSearch(); await searchInput("compaction-summary-needle");
    assert.equal(compaction.open, true, "summary search opens matching compression details");
    await closeSearch();
    assert.equal(compaction.open, false, "temporary search reveal preserves manual folding");
    await act(async () => { compaction.querySelector("summary").click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(compaction.open, true);
    assert.match(compaction.textContent, /手动压缩/);

    const { default: AccountUsage } = await vite.ssrLoadModule("/src/components/AccountUsage.jsx");
    const quotaFetch = globalThis.fetch;
    let quotaLoads = 0;
    globalThis.fetch = async () => { quotaLoads++; return { ok: true, json: async () => ({ sources: [{ id: "pi-codex", agent: "pi", name: "Codex", rows: [{ id: "week", label: "每周额度", short: "周", remaining: 21 }] }] }) }; };
    await act(async () => root.render(React.createElement(AccountUsage, { agent: "pi", provider: "openai-codex" })));
    assert.equal(document.querySelector(".acct-period").textContent, "周 ");
    assert.equal(document.querySelector(".acct-value").textContent, "21%", "the collapsed rail can hide the period without dropping the percentage");
    assert.match(document.querySelector(".acct-btn").getAttribute("aria-label"), /每周额度剩余 21%/);
    await act(async () => document.querySelector(".acct-btn").click());
    assert.equal(document.querySelector(".acct-btn").getAttribute("aria-expanded"), "true");
    assert.match(document.querySelector(".acct-panel").textContent, /每周额度/);
    assert.match(document.querySelector(".acct-panel").textContent, /21%/);
    await act(async () => document.querySelector(".acct-reload").click());
    assert.equal(quotaLoads, 2, "quota detail refresh still works");
    await act(async () => root.render(null));
    globalThis.fetch = quotaFetch;

    const { default: Sidebar } = await vite.ssrLoadModule("/src/components/Sidebar.jsx");
    const sidebar = (loading, sessions = [], extra = {}) => act(async () => root.render(React.createElement(Sidebar, { loading, sessions, ...extra })));
    await sidebar(true);
    assert.equal(document.querySelectorAll(".session-skeleton").length, 6);
    assert.equal(document.querySelector(".session-list").getAttribute("aria-busy"), "true");
    assert.doesNotMatch(document.querySelector(".session-list").textContent, /暂无会话/);
    await sidebar(false);
    assert.match(document.querySelector(".session-list").textContent, /暂无会话/);
    await sidebar(true, [{ sessionId: "kept", cwd: "/tmp", title: "Existing session" }]);
    assert.equal(document.querySelector(".sessions-skeleton"), null, "background refresh keeps existing rows");
    assert.match(document.querySelector(".session-list").textContent, /Existing session/);
    await sidebar(false, [
      { sessionId: "wait", cwd: "/tmp", title: "Needs confirmation", state: "working" },
      { sessionId: "work", cwd: "/tmp", title: "Working", state: "working" },
      { sessionId: "unread", cwd: "/tmp", title: "Unread", state: "free" },
    ], { attentionIds: new Set(["wait"]), unreadIds: new Set(["wait", "unread"]) });
    const waiting = document.querySelector('.session-row[title="Needs confirmation"]');
    assert.match(waiting.textContent, /等待确认/);
    assert.match(waiting.querySelector(".session-open").getAttribute("aria-label"), /等待确认/);
    assert.equal(waiting.querySelector('.session-status[role="img"]').getAttribute("aria-label"), "等待确认", "compact status dots keep a readable accessible label");
    assert.doesNotMatch(waiting.textContent, /工作中/);
    assert.match(document.querySelector('.session-row[title="Unread"]').textContent, /未读/);
    assert.ok(document.querySelector(".sr-meta .sr-time"));

    await act(async () => document.querySelector('[aria-label="筛选会话"]').click());
    const toggleStatus = (label) => act(async () => [...document.querySelectorAll(".sb-filter-panel label")].find((e) => e.textContent === label).querySelector("input").click());
    await toggleStatus("运行中");
    assert.equal(document.querySelectorAll(".session-row").length, 2);
    await toggleStatus("未读");
    assert.equal(document.querySelectorAll(".session-row").length, 3, "combined status filters match either status, not their intersection");
    await toggleStatus("运行中");
    assert.equal(document.querySelectorAll(".session-row").length, 2, "both unread sessions remain");
    await toggleStatus("未读"); await toggleStatus("待确认");
    assert.equal(document.querySelectorAll(".session-row").length, 1);
    assert.match(document.querySelector(".sb-filter-summary").textContent, /待确认.*1 个会话/);
    await act(async () => document.querySelector('[aria-label="清除会话筛选"]').click());
    assert.equal(document.querySelectorAll(".session-row").length, 3);
    await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(document.querySelectorAll(".sb-filter-panel").length, 0);

    const created = [], picked = [], focusedWorkspaces = [], openedSessions = [];
    const workspaceSession = [{ sessionId: "workspace", cwd: "/tmp/project", title: "Project session", agent: "devin" },
      { sessionId: "pi-workspace", cwd: "/tmp/project", title: "Pi session", agent: "pi" }];
    const agentsById = new Map([["devin", { id: "devin", name: "Devin" }], ["pi", { id: "pi", name: "Pi" }]]);
    const creationProps = { activeWorkspace: "/tmp/another", agentsById, onNewSession: (...args) => created.push(args), onPickAgent: (id) => picked.push(id), onOpenWorkspace: (cwd) => focusedWorkspaces.push(cwd), onFocusWorkspace() {}, onOpenSession: (s) => openedSessions.push(s.sessionId) };
    await sidebar(false, workspaceSession, creationProps);
    assert.equal(document.querySelector(".new-session-row"), null);
    assert.deepEqual([...document.querySelectorAll(".sb-agent-tag")].map((e) => e.textContent), ["de", "Pi"]);
    assert.equal(document.querySelector(".sb-agent-tag").title, "Devin", "only the compact list badge is abbreviated");
    assert.equal(document.querySelectorAll(".ws-sub").length, 0, "workspace paths do not repeat beneath every group");
    assert.equal(document.querySelector(".ws-head").title, "/tmp/project", "the full path remains available on hover");
    await act(async () => document.querySelector('button[title="设置"]').click());
    const densityButtons = () => [...document.querySelectorAll('[aria-label="侧栏会话布局"] button')];
    assert.equal(densityButtons().find((e) => e.getAttribute("aria-pressed") === "true").textContent, "单行");
    await act(async () => densityButtons().find((e) => e.textContent === "双行").click());
    assert.equal(document.documentElement.dataset.sessionRows, "double");
    assert.equal(localStorage.getItem("dw.sessionRows"), "double");
    assert.equal(document.querySelectorAll(".session-row").length, 2, "changing density keeps the current list and selection intact");
    await act(async () => densityButtons().find((e) => e.textContent === "单行").click());
    assert.equal(document.documentElement.dataset.sessionRows, "single");
    await act(async () => document.querySelector('.set-modal button[title="关闭"]').click());
    await act(async () => document.querySelector(".ws-chev").click());
    assert.equal(document.querySelector(".ws-chev").getAttribute("aria-expanded"), "false");
    assert.deepEqual(focusedWorkspaces, [], "disclosure does not navigate");
    await act(async () => document.querySelector(".ws-focus").click());
    assert.deepEqual(focusedWorkspaces, ["/tmp/project"]);
    assert.equal(document.querySelector(".ws-chev").getAttribute("aria-expanded"), "false", "workspace navigation does not also change disclosure");
    await act(async () => document.querySelector(".ws-chev").click());
    const sessionButton = document.querySelector(".session-open");
    assert.equal(sessionButton.tagName, "BUTTON"); assert.equal(sessionButton.tabIndex, 0);
    await act(async () => sessionButton.click());
    assert.deepEqual(openedSessions, ["workspace"], "the keyboard-accessible primary button opens its session");
    const openListActions = () => act(async () => document.querySelector('[aria-label="更多列表操作"]').click());
    assert.equal(document.querySelectorAll(".sb-tools > button").length, 1, "the toolbar retains just search, filter and one more button");
    await openListActions(); await clickMenu("批量选择");
    await act(async () => document.querySelector(".session-row").click());
    assert.match(document.querySelector(".sel-n").textContent, /已选 1/);
    await act(async () => document.querySelector(".ws-head .sr-check").click());
    assert.match(document.querySelector(".sel-n").textContent, /已选 2/);
    assert.deepEqual(openedSessions, ["workspace"], "compact batch-selection clicks never open a conversation");
    await openListActions(); await clickMenu("退出批量选择");
    assert.equal(document.querySelectorAll(".session-open").length, 2);
    await act(async () => document.querySelector(".ws-add").click());
    assert.equal(created.length, 0, "workspace plus asks for an agent before creating");
    assert.deepEqual([...document.querySelectorAll(".ctx-item")].map((e) => e.textContent), ["新建 Devin 会话", "新建 Pi 会话"]);
    await act(async () => [...document.querySelectorAll(".ctx-item")].find((e) => e.textContent.includes("Pi")).click());
    assert.deepEqual(created, [["/tmp/project", "pi"]], "use the clicked workspace, not the active one");
    assert.deepEqual(picked, ["pi"]);
    await sidebar(false, workspaceSession, { ...creationProps, creating: "pi" });
    assert.ok(document.querySelector(".ws-add").disabled);
    await sidebar(false, workspaceSession, { ...creationProps, agentsById: new Map([["pi", agentsById.get("pi")]]) });
    await act(async () => document.querySelector(".ws-add").click());
    assert.equal(created.length, 2, "a single available agent creates directly");

    await openListActions(); await clickMenu("排序方式");
    assert.equal(document.querySelector('[role="menuitemradio"][aria-checked="true"]').textContent, "最近活跃");
    await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
    assert.equal(document.activeElement.textContent, "排序方式");
    await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    await clickMenu("按名称");
    assert.equal(localStorage.getItem("devin-web.sort"), "name");
    assert.deepEqual([...document.querySelectorAll(".session-title")].map((element) => element.textContent), ["Pi session", "Project session"]);
    await openListActions(); await clickMenu("排序方式"); await clickMenu("最近活跃");

    const archivedFixture = [...workspaceSession, { sessionId: "archived", cwd: "/tmp/project", title: "Archived fixture", archived: true }];
    await sidebar(false, archivedFixture, creationProps);
    const toggleArchived = async () => {
      await act(async () => document.querySelector(".ws-head").dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })));
      await act(async () => [...document.querySelectorAll(".ctx-item")].find((e) => /已归档会话/.test(e.textContent)).click());
    };
    assert.equal(document.querySelectorAll(".session-row").length, 2);
    await toggleArchived();
    assert.equal(document.querySelectorAll(".session-row").length, 3, "archive visibility updates without a session refresh");
    await toggleArchived();
    assert.equal(document.querySelectorAll(".session-row").length, 2);
    await sidebar(false, [archivedFixture.at(-1)], creationProps);
    assert.equal(document.querySelectorAll(".ws-head").length, 0);
    await act(async () => document.querySelector('[aria-label="筛选会话"]').click());
    await act(async () => document.querySelector('.archive-filter input').click());
    assert.equal(document.querySelectorAll(".session-row").length, 1, "archived-only workspaces can be recovered without a context-menu target");
    await act(async () => document.querySelector('.archive-filter input').click());
    await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    const { default: WorkspacePicker } = await vite.ssrLoadModule("/src/components/WorkspacePicker.jsx");
    const beforePickerFetch = globalThis.fetch, selectedDirs = [];
    let finishBrowse;
    globalThis.fetch = async (url) => {
      if (url === "/api/sessions") return { ok: true, json: async () => ({ sessions: [] }) };
      const path = new URL(url, location.href).searchParams.get("path");
      if (path === "/old") return { ok: true, json: async () => ({ path, parent: "/", entries: [{ isDir: true, name: "new", path: "/new" }] }) };
      return new Promise((resolve) => { finishBrowse = resolve; });
    };
    await act(async () => root.render(React.createElement(WorkspacePicker, { initial: "/old", onClose() {}, onSelect: (path) => selectedDirs.push(path) })));
    const confirmDirectory = () => [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === "使用此目录");
    await act(async () => [...document.querySelectorAll(".dir-row")].find((e) => e.textContent === "new").click());
    assert.equal(document.querySelector(".path-input input").value, "/new");
    assert.equal(document.querySelector(".dir-list").getAttribute("aria-busy"), "true");
    assert.ok(confirmDirectory().disabled, "pending navigation cannot select the previous directory");
    await act(async () => confirmDirectory().click());
    assert.deepEqual(selectedDirs, []);
    await act(async () => finishBrowse({ ok: false, status: 404, json: async () => ({ error: "directory missing" }) }));
    assert.match(document.querySelector('[role="alert"]').textContent, /directory missing/);
    assert.ok(confirmDirectory().disabled, "failed navigation cannot select stale data either");
    await act(async () => fill(document.querySelector(".path-input input"), "/valid"));
    await act(async () => finishBrowse({ ok: true, json: async () => ({ path: "/valid", parent: "/", entries: [] }) }));
    assert.equal(confirmDirectory().disabled, false);
    await act(async () => confirmDirectory().click());
    assert.deepEqual(selectedDirs, ["/valid"]);
    await act(async () => root.render(null));
    globalThis.fetch = beforePickerFetch;

    const { default: ConfirmDialog } = await vite.ssrLoadModule("/src/components/ConfirmDialog.jsx");
    const origin = document.createElement("button"); document.body.append(origin); origin.focus();
    let confirmed = 0;
    await act(async () => root.render(React.createElement(ConfirmDialog, { title: "Delete safely", message: "fixture",
      confirmLabel: "删除", onCancel: () => root.render(null), onConfirm: async () => { confirmed++; throw new Error("fixture delete failure"); } })));
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.equal(document.activeElement.textContent, "取消");
    await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.equal(confirmed, 0, "Enter is never a global destructive shortcut");
    const remove = [...dialog.querySelectorAll("button")].find((e) => e.textContent === "删除");
    remove.focus();
    await act(async () => remove.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    assert.equal(document.activeElement.textContent, "取消", "Tab wraps within a modal");
    await act(async () => remove.click());
    assert.equal(confirmed, 1);
    assert.match(dialog.querySelector('[role="alert"]').textContent, /fixture delete failure/);
    assert.ok(document.querySelector('[role="alertdialog"]'), "failed deletion keeps confirmation open");
    await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
    assert.equal(document.activeElement, origin, "closing restores the invoking control"); origin.remove();

    const { default: SettingsMenu } = await vite.ssrLoadModule("/src/components/SettingsMenu.jsx");
    await act(async () => root.render(React.createElement(SettingsMenu)));
    await act(async () => document.querySelector('button[title="设置"]').click());
    assert.deepEqual([...document.querySelectorAll('.set-body input[type="checkbox"]')].map((e) => e.getAttribute("aria-label")), ["减少动画", "流式自动收起", "按键提示常显"]);
    assert.ok(document.querySelector('[aria-label="侧栏字号"]'));
    assert.ok(document.querySelector('[aria-label="发送方式"] button[aria-pressed="true"]'));
    await act(async () => {
      const select = document.querySelector('[aria-label="转录样式"]');
      select.value = "terminal"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(document.documentElement.dataset.view, "terminal");
    await act(async () => document.querySelector('.set-modal button[title="关闭"]').click());
    await render();
    const { setView } = await vite.ssrLoadModule("/src/theme.js");
    await act(async () => setView("compact"));
    await openChatActions();
    await clickMenu("对话视图");
    assert.equal([...document.querySelectorAll(".ctx-item")].find((e) => e.textContent === "紧凑").getAttribute("aria-checked"), "true", "external view preferences synchronize into a mounted chat menu");
    await escapeLayer(); await escapeLayer();
    await act(async () => setView("default"));

    const { default: Welcome } = await vite.ssrLoadModule("/src/components/Welcome.jsx");
    const entered = [], continued = [], newProjects = [];
    const welcomeProps = { sessions: [...workspaceSession, { sessionId: "other-project", title: "Another project", cwd: "/tmp/other" }, { sessionId: "hidden-project", title: "Archived project", cwd: "/tmp/archived", archived: true }], activeWorkspace: "/tmp/project", agents: [...agentsById.values()], onOpenWorkspace: (cwd) => entered.push(cwd),
      onOpenSession: (session) => continued.push(session.sessionId), onNewSession: (...args) => newProjects.push(args) };
    await act(async () => root.render(React.createElement(Welcome, welcomeProps)));
    await act(async () => document.querySelector(".ws-card").click());
    assert.deepEqual(entered, ["/tmp/other"]);
    assert.equal(document.querySelectorAll(".ws-card").length, 1, "the active workspace and archived-only projects are not duplicated below continue");
    assert.equal(document.querySelectorAll(".project-session").length, 2);
    assert.equal(document.querySelectorAll(".welcome-new").length, 1, "welcome has one explicit create entry");
    assert.equal(newProjects.length, 0, "entering a recent project never creates or resumes a conversation");
    await act(async () => document.querySelector(".project-session").click());
    assert.equal(continued.length, 1, "continuing a project session requires an explicit click");
    await act(async () => document.querySelector(".welcome-new").click());
    assert.equal(newProjects.length, 0);
    await act(async () => [...document.querySelectorAll(".ctx-item")].find((e) => e.textContent.includes("Pi")).click());
    assert.deepEqual(newProjects, [["/tmp/project", "pi"]]);
    await act(async () => root.render(React.createElement(Welcome, { ...welcomeProps, activeWorkspace: null })));
    assert.equal(document.querySelector(".welcome-new").textContent, "选择工作区");
    assert.equal(document.querySelectorAll(".project-session").length, 3, "the unselected welcome page can continue recent sessions without creating any");
    assert.equal(newProjects.length, 1);

    const { default: CommandPalette } = await vite.ssrLoadModule("/src/components/CommandPalette.jsx");
    const paletteChoices = [];
    await act(async () => root.render(React.createElement(CommandPalette, { open: true, onClose: () => root.render(null),
      actions: [{ id: "new", title: "新建会话", run: () => paletteChoices.push("new") }], sessions: [{ sessionId: "palette", title: "Palette fixture", cwd: "/tmp/project" }],
      onOpenSession: (id) => paletteChoices.push(id) })));
    assert.deepEqual([...document.querySelectorAll(".cp-group")].map((element) => element.textContent), ["操作", "会话"]);
    assert.equal(document.querySelector(".cp-hint").textContent, "project");
    assert.equal(document.querySelector(".cp-hint").title, "/tmp/project");
    await act(async () => fill(document.querySelector(".cp-input-row input"), "Palette fixture"));
    assert.equal(document.querySelectorAll(".cp-item").length, 1);
    await act(async () => document.querySelector(".cp-input-row input").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
    assert.deepEqual(paletteChoices, [], "IME confirmation never invokes a palette action");
    await act(async () => document.querySelector(".cp-input-row input").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    assert.deepEqual(paletteChoices, ["palette"]);
    assert.equal(document.querySelector(".cp-box"), null);

    const { default: RemoteHosts } = await vite.ssrLoadModule("/src/components/RemoteHosts.jsx");
    const beforeRemoteFetch = globalThis.fetch, hostCalls = [];
    let remoteRows = [], remoteState = "disconnected", finishRemoteInstall;
    const remoteId = "11111111-1111-4111-8111-111111111111";
    const remotePlan = { id: "plan-1", version: "fixture", root: "/home/fixture/.local/share/agent-web-remote", nodeVersion: "22.23.2", installed: false, running: false, compatible: true, operations: ["fixture install action"] };
    globalThis.fetch = async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : {};
      hostCalls.push({ url, method: options.method || "GET", body });
      let data = {}, status = 200;
      if (url === "/api/remotes" && options.method === "POST") remoteRows = [{ id: remoteId, label: body.label, hostname: body.hostname, username: body.username, port: body.port, state: remoteState }];
      else if (url.endsWith("/probe")) { if (remoteRows[0]?.fingerprint) data = remotePlan; else { status = 409; data = { error: "trust first", code: "HOST_KEY_UNKNOWN", fingerprint: "SHA256:fixture" }; } }
      else if (url.endsWith("/trust")) { remoteRows[0].fingerprint = "SHA256:fixture"; data = remotePlan; }
      else if (url.endsWith("/install")) { await new Promise((resolve) => { finishRemoteInstall = resolve; }); remoteRows[0].busy = false; data = { ...remotePlan, installed: true }; }
      else if (url.endsWith("/connect")) remoteRows[0].state = "connected";
      if (url === "/api/remotes") data = { hosts: remoteRows, keyConfigured: true };
      return { ok: status === 200, status, json: async () => data };
    };
    await sidebar(false, [], { wsUp: true, environmentControl: React.createElement(RemoteHosts, { wsUp: true }) });
    assert.equal(document.querySelectorAll(".environment-control").length, 1);
    assert.equal(document.querySelector(".environment-control").parentElement.className, "sb-foot", "environment and connection status share one footer control");
    assert.equal(document.querySelectorAll(".sb-foot .conn").length, 1, "connection dot is not duplicated");
    assert.match(document.querySelector(".environment-control").textContent, /本机已连接/);
    await sidebar(false, [], { wsUp: false, environmentControl: React.createElement(RemoteHosts, { wsUp: false }) });
    assert.equal(document.querySelector(".environment-control .conn.up"), null);
    assert.match(document.querySelector(".environment-control").textContent, /连接断开/);
    await act(async () => document.querySelector(".environment-control").click());
    await act(async () => document.querySelector(".remote-add").click());
    await act(async () => {
      const fields = document.querySelectorAll(".remote-form input");
      ["Fixture host", "fixture.example", "22", "fixture", "fixture-password"].forEach((value, i) => fill(fields[i], value));
    });
    await act(async () => document.querySelector(".remote-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(document.querySelector(".remote-form"), null, "saved password is removed from the form");
    const hostAction = async (label) => {
      const direct = [...document.querySelectorAll(".remote-actions button")].find((e) => e.textContent === label);
      if (direct) await act(async () => direct.click());
      else {
        await act(async () => document.querySelector('.remote-actions [aria-haspopup="menu"]').click());
        await act(async () => [...document.querySelectorAll(".ctx-item")].find((e) => e.textContent === label).click());
      }
    };
    assert.equal(document.querySelectorAll(".remote-actions button").length, 2, "host rows expose one primary action plus maintenance menu");
    await hostAction("检测 / 安装");
    assert.match(document.querySelector('[role="alertdialog"]').textContent, /SHA256:fixture/);
    assert.equal(document.activeElement.textContent, "取消");
    assert.equal(hostCalls.filter((c) => c.url.endsWith("/trust")).length, 0, "fingerprint never auto-trusts");
    await act(async () => document.querySelector('.confirm-dialog .modal-actions button:last-child').click());
    assert.ok(document.querySelector('[aria-label="远端组件安装确认"]'));
    assert.equal(hostCalls.filter((c) => c.url.endsWith("/install")).length, 0, "detection never auto-installs");
    Object.assign(remotePlan, { needsNode: true, nodeVersion: "v18.0.0", nodeInstall: { version: "22.99.0", target: "/home/fixture/component/runtimes/node-v22.99.0-linux-x64", sha256: "a".repeat(64) } });
    await act(async () => { document.querySelector('[aria-label="远端组件安装确认"] .secondary').click(); });
    await hostAction("检测 / 安装");
    assert.match(document.querySelector(".remote-runtime-plan").textContent, /自动安装组件专用 Node 22.99.0/);
    assert.match(document.querySelector(".remote-runtime-plan").textContent, /不替换系统/);
    assert.match(document.querySelector('[aria-label="远端组件安装确认"] .primary').textContent, /确认自动安装 Node/);
    assert.equal(hostCalls.filter((c) => c.url.endsWith("/install")).length, 0, "runtime installation remains explicitly confirmed");
    remoteRows[0].busy = true;
    remoteRows[0].progress = { stage: "node_download", bytes: 12 * 1048576, total: 54 * 1048576, attempt: 2 };
    await act(async () => document.querySelector('[aria-label="远端组件安装确认"] .primary').click());
    const progress = document.querySelector('[aria-label="远端组件安装确认"] .remote-progress');
    assert.match(progress.textContent, /部署主机下载 Node/); assert.match(progress.textContent, /12.0 \/ 54.0 MiB/);
    assert.match(progress.textContent, /续传尝试 2/);
    assert.ok(document.querySelector('[aria-label="远端组件安装确认"] .primary').disabled, "a slow active download never encourages duplicate installs");
    await act(async () => { finishRemoteInstall(); });
    const installCall = hostCalls.find((c) => c.url.endsWith("/install"));
    assert.deepEqual(installCall.body, { confirm: true, planId: "plan-1" });
    assert.equal(hostCalls.filter((c) => c.url.endsWith("/connect")).length, 1);
    assert.match(document.querySelector(".remote-host").textContent, /已连接/);
    assert.equal([...document.querySelectorAll(".remote-actions button")].some((e) => e.textContent === "停止组件"), false, "destructive controls stay out of the primary row");
    await hostAction("停止组件");
    assert.match(document.querySelector('[role="alertdialog"]').textContent, /中断.*任务/);
    await act(async () => document.querySelector('.confirm-dialog .secondary').click());
    assert.equal(hostCalls.filter((c) => c.url.endsWith("/stop")).length, 0);
    await act(async () => root.render(null));
    globalThis.fetch = beforeRemoteFetch;

    let resolveSessions;
    globalThis.fetch = async (url) => {
      if (url === "/api/sessions") return new Promise((resolve) => { resolveSessions = resolve; });
      const data = url === "/api/agents" ? { agents: [{ id: "pi", name: "Pi", caps: {} }] } :
        url === "/api/state" ? { workspaces: ["/tmp"], home: "/tmp" } : { sources: [] };
      return { ok: true, json: async () => data };
    };
    history.replaceState(null, "", "#/session/linked");
    sessionStorage.setItem("dw.layout", JSON.stringify({ root: { id: "restored-pane", sessionId: "linked", cwd: "/tmp" }, focusedId: "restored-pane" }));
    sessionStorage.setItem("dw.promptDeliveries", JSON.stringify([{ id: "restored-receipt", sessionId: "linked", phase: "accepted", accepted: true,
      text: "restored prompt", blocks: [{ type: "text", text: "restored prompt" }] }]));
    const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
    await act(async () => root.render(React.createElement(App)));
    assert.equal(location.hash, "#/session/linked", "loading must not erase the current session link");
    assert.equal(document.querySelectorAll(".session-skeleton").length, 6);
    const { environment } = await vite.ssrLoadModule("/src/api.js");
    const wsClient = environment("").ws;
    assert.equal(wsClient.ws.sent.filter((message) => message.type === "subscribe").length, 0, "offline subscriptions are retained as intent, not queued on the wire");
    const outbound = [];
    await act(async () => { wsClient.ws.send = (raw) => outbound.push(JSON.parse(raw)); wsClient.ws.onopen(); });
    assert.deepEqual(outbound.filter((message) => message.type === "subscribe").map((message) => message.sessionId), ["linked"], "first connection requests each restored history exactly once");
    await act(async () => {
      for (const listener of wsClient.handlers.get("prompt_delivery") || []) listener({ sessionId: "linked", requestId: "restored-receipt", status: "accepted", accepted: true });
      for (const listener of wsClient.handlers.get("session_attached") || []) listener({ sessionId: "linked" });
      for (const listener of wsClient.handlers.get("session_update") || []) listener({ sessionId: "linked", gen: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "early partial output" } } });
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
    assert.ok(document.querySelector(".ld-text"), "receipts, attachment and live deltas cannot claim history has loaded");
    assert.equal(document.querySelector(".delivery-recovery"), null, "a restored receipt never becomes a naked row while loading");
    assert.equal(document.querySelector(".msg"), null, "partial live output waits for the authoritative initial snapshot");
    assert.equal(document.querySelector(".empty-hints"), null, "attachment alone must not flash a new-chat welcome");
    await act(async () => resolveSessions({ ok: true, json: async () => ({ sessions: [{ sessionId: "linked", title: "Restored chat", cwd: "/tmp", agent: "pi" }, { sessionId: "other", title: "Other chat", cwd: "/tmp/other", agent: "pi" }] }) }));
    assert.equal(document.querySelector(".chat-title-col .t").textContent, "Restored chat");
    assert.equal(location.hash, "#/session/linked", "refresh restores the linked chat once the list arrives");
    await act(async () => {
      for (const listener of wsClient.handlers.get("history") || []) listener({ sessionId: "linked", gen: 1, attached: true, events: [{ t: 1,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "restored prompt" }, _meta: { "devin-web/requestId": "restored-receipt" } } }] });
    });
    assert.equal(document.querySelector(".ld-text"), null);
    assert.equal(document.querySelector(".delivery-recovery"), null);
    assert.ok(document.querySelector(".msg-bubble > .delivery-notice.accepted"), "the unchanged receipt rejoins its historical user message once ready");
    await act(async () => { for (const listener of wsClient.handlers.get("prompt_delivery") || []) listener({ sessionId: "linked", requestId: "restored-receipt", status: "completed" }); });
    assert.equal(document.querySelector(".chat-title-col .t").textContent, "Restored chat", "history without a title must not flash the raw session id");
    const emit = (type, message) => act(async () => { for (const handler of wsClient.handlers.get(type) || []) handler(message); });
    // A history frame can arrive before rAF flushes earlier token updates.
    // Those deltas are already in the snapshot; replaying them duplicates text.
    await act(async () => {
      for (const handler of wsClient.handlers.get("session_update") || []) handler({ sessionId: "linked", gen: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "deduplicated snapshot" } } });
      for (const handler of wsClient.handlers.get("history") || []) handler({ sessionId: "linked", gen: 1, revision: 2, attached: true, events: [{ t: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "deduplicated snapshot" } } }] });
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
    assert.equal(document.querySelector(".msg.agent .agent-body").textContent, "deduplicated snapshot");
    await emit("history", { sessionId: "linked", gen: 1, revision: 3, attached: true, events: [{ t: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "coalesced revision updated" } } }] });
    assert.equal(document.querySelector(".msg.agent .agent-body").textContent, "coalesced revision updated", "same-length history still updates after buffer compaction");

    await emit("hello", { caps: { promptAck: true, dedupMs: 86400000 }, instanceId: "test-instance" });
    await act(async () => fill(document.querySelector(".input-ta"), "delivery fixture"));
    await act(async () => document.querySelector(".send").click());
    const message = outbound.find((m) => m.type === "prompt");
    assert.ok(message.requestId);
    assert.match(document.querySelector(".delivery-notice.sending").textContent, /发送中/);
    assert.ok(document.querySelector(".msg-bubble > .delivery-notice.sending"), "send receipt shares the user message, never a separate transcript row");
    await emit("prompt_delivery", { sessionId: "linked", requestId: message.requestId, status: "accepted", accepted: true });
    assert.match(document.querySelector(".delivery-notice.accepted").textContent, /已接收/);
    await act(async () => fill(document.querySelector(".input-ta"), "failed followup"));
    await attachImage();
    await act(async () => document.querySelector(".send").click());
    const followup = outbound.filter((m) => m.type === "prompt").at(-1);
    await emit("error", { op: "prompt", sessionId: "linked", requestId: followup.requestId, error: "fixture rejection" });
    assert.ok(document.querySelector(".delivery-notice.failed"));
    assert.ok(document.querySelector(".running-hint"), "a rejected queued message must not stop the active task");
    await act(async () => fill(document.querySelector(".input-ta"), "new draft"));
    await act(async () => [...document.querySelectorAll(".delivery-notice.failed button")].find((e) => e.textContent === "恢复编辑").click());
    assert.equal(document.querySelector(".input-ta").value, "new draft\n\nfailed followup");
    assert.ok(document.querySelector(".img-preview"), "recovery retains image attachments as well as text");
    await emit("prompt_delivery", { sessionId: "linked", requestId: message.requestId, status: "completed" });
    assert.equal(document.querySelector(".delivery-notice.accepted"), null);

    const firstInput = document.querySelector(".input-ta");
    await act(async () => document.querySelector('[aria-label="左右拆分当前窗格"]').click());
    assert.equal(document.querySelectorAll(".chat-pane").length, 2);
    assert.equal(document.querySelector(".conversation-pane").lastElementChild.classList.contains("split-toolbar"), true, "pane controls occupy the bottom, not a second top header");
    assert.equal(document.querySelector(".input-ta"), firstInput, "splitting keeps the existing draft/attachment component mounted");
    await act(async () => document.querySelector('.session-row[title="Other chat"] .session-open').click());
    await emit("history", { sessionId: "other", gen: 1, attached: true, events: [] });
    const otherPane = document.querySelector('[data-session-id="other"]');
    const firstPane = document.querySelector('[data-session-id="linked"]');
    const otherInput = otherPane.querySelector(".input-ta");
    assert.ok(otherPane.classList.contains("focused"));
    await act(async () => { fill(firstInput, "only first"); fill(otherInput, "only second"); });
    await act(async () => firstPane.querySelector(".send").click());
    assert.equal(outbound.filter((message) => message.type === "prompt").at(-1).sessionId, "linked", "even an unfocused view's callback sends only to its own session");
    assert.equal(otherInput.value, "only second");
    await act(async () => firstPane.querySelector(".stop").click());
    assert.equal(outbound.filter((message) => message.type === "cancel").at(-1).sessionId, "linked");
    assert.ok(otherPane.classList.contains("focused"), "an async action doesn't switch pane focus");
    await emit("session_update", { sessionId: "linked", gen: 1, update: { sessionUpdate: "config_option_update", configOptions: [{ id: "mode", type: "select", name: "Mode", currentValue: "auto", options: [{ value: "auto", name: "Auto" }, { value: "manual", name: "Manual" }] }] } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 35)); });
    await act(async () => firstPane.querySelector(".nice-select .ns-trigger").click());
    const focusOther = () => {
      const select = document.querySelector(".pane-switcher select");
      select.value = otherPane.dataset.paneId; select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    await act(async () => focusOther());
    await act(async () => document.querySelector('.ns-item[title="Manual"]').click());
    assert.deepEqual(outbound.filter((message) => message.type === "set_config_option").at(-1), { type: "set_config_option", sessionId: "linked", configId: "mode", value: "manual" });
    await emit("queue_update", { sessionId: "linked", queue: [{ id: "queue-first", text: "edit first queue" }] });
    await act(async () => firstPane.querySelector('.qc-btn[title="撤回编辑"]').click());
    assert.equal(firstInput.value, "edit first queue");
    assert.equal(otherInput.value, "only second", "queue editing never overwrites another pane's draft");
    assert.deepEqual(outbound.filter((message) => message.type === "queue_remove").at(-1), { type: "queue_remove", sessionId: "linked", queueId: "queue-first" });
    await emit("queue_update", { sessionId: "linked", queue: [] });
    await act(async () => focusOther());

    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true })));
    assert.equal(firstPane.querySelector(".ts-search"), null);
    assert.ok(otherPane.querySelector(".ts-search"), "global transcript search belongs to just the focused pane");
    await act(async () => otherPane.querySelector('.ts-search button[title="关闭 (Esc)"]').click());
    const beforeClose = outbound.length;
    await act(async () => document.querySelector('[aria-label="关闭当前窗格"]').click());
    assert.equal(document.querySelectorAll(".chat-pane").length, 1);
    assert.equal(document.querySelector(".input-ta"), firstInput);
    assert.ok(outbound.slice(beforeClose).some((message) => message.type === "unsubscribe" && message.sessionId === "other"));
    assert.equal(outbound.slice(beforeClose).some((message) => ["cancel", "delete", "close"].includes(message.type)), false, "closing a view never terminates its task");
    const savedLayout = JSON.parse(sessionStorage.getItem("dw.layout"));
    assert.equal(savedLayout.root.sessionId, "linked");
    await act(async () => document.querySelector('[aria-label="收起侧栏"]').click());
    assert.ok(document.querySelector(".sidebar.sidebar-collapsed"));
    assert.equal(localStorage.getItem("dw.sidebarCollapsed"), "1");
    await act(async () => document.querySelector('[aria-label="展开侧栏"]').click());
    assert.equal(document.querySelector(".sidebar.sidebar-collapsed"), null);


  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.close();
    for (const [k, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete globalThis[k];
    }
  }
});

test("split panes reach separate environments without cross-host bleed", async () => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const sockets = [];
  const FakeWebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.closed = false; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.closed = true; }
  };
  const H = "host-1";
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "FileReader", "navigator"].map((k) => [k, dom.window[k]])),
    fetch: async (url) => {
      const respond = (data) => ({ ok: true, json: async () => data });
      if (url === "/api/remotes") return respond({ hosts: [{ id: H, label: "Devbox", hostname: "devbox", username: "u", port: 22, state: "connected" }], keyConfigured: true });
      if (url === "/api/agents" || url.endsWith("/proxy/api/agents")) return respond({ agents: [{ id: "pi", name: "Pi", caps: {} }] });
      if (url === "/api/state" || url.endsWith("/proxy/api/state")) return respond({ workspaces: ["/tmp"], home: "/tmp" });
      if (url === "/api/sessions") return respond({ sessions: [{ sessionId: "dup", title: "Local dup", cwd: "/tmp", agent: "pi" }] });
      if (url === `/api/remotes/${H}/proxy/api/sessions`) return respond({ sessions: [{ sessionId: "dup", title: "Remote dup", cwd: "/srv", agent: "pi" }] });
      return respond({});
    },
    WebSocket: FakeWebSocket,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  let vite;
  let root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({
      root: new URL("../../web/", import.meta.url).pathname,
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
    });
    const fill = (element, value) => {
      const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    };
    root = createRoot(document.getElementById("root"));
    history.replaceState(null, "", "#/session/dup");
    sessionStorage.setItem("dw.layout", JSON.stringify({ root: { id: "p1", host: "", sessionId: "dup", cwd: "/tmp" }, focusedId: "p1" }));
    const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
    await act(async () => root.render(React.createElement(App)));
    const localWs = sockets.find((s) => s.url === "ws://localhost/ws");
    assert.ok(localWs, "the local environment opened its own socket");
    await act(async () => localWs.onopen());
    assert.ok([...document.querySelectorAll(".session-row")].some((r) => r.title === "Local dup"));

    await act(async () => document.querySelector('[aria-label="左右拆分当前窗格"]').click());
    assert.equal(document.querySelectorAll(".chat-pane").length, 2);
    const welcomeSelect = document.querySelectorAll(".chat-pane")[1].querySelector(".welcome-host");
    assert.ok(welcomeSelect, "an empty pane offers an environment selector");
    await act(async () => { welcomeSelect.value = H; welcomeSelect.dispatchEvent(new Event("change", { bubbles: true })); });
    const remoteWs = sockets.find((s) => s.url.includes(`/ws/remotes/${H}`));
    assert.ok(remoteWs, "choosing a remote environment opens that host's socket");
    assert.ok(location.search.includes(`remote=${H}`), "the deep link follows the focused pane");
    await act(async () => remoteWs.onopen());
    assert.ok([...document.querySelectorAll(".session-row")].some((r) => r.title === "Remote dup"));
    assert.ok(![...document.querySelectorAll(".session-row")].some((r) => r.title === "Local dup"), "the sidebar follows the focused pane's host");

    await act(async () => document.querySelector('.session-row[title="Remote dup"] .session-open').click());
    const dupPanes = () => [...document.querySelectorAll('.chat-pane[data-session-id="dup"]')];
    assert.equal(dupPanes().length, 2, "the same session id lives once per host");
    assert.equal(dupPanes().find((p) => p.classList.contains("focused")).dataset.host, H, "no dedupe across hosts");
    assert.ok(remoteWs.sent.some((m) => m.type === "subscribe" && m.sessionId === "dup"));
    const remotePane = dupPanes().find((p) => p.dataset.host === H);
    const localPane = dupPanes().find((p) => p.dataset.host === "");
    const emit = (sock, msg) => sock.onmessage({ data: JSON.stringify(msg) });
    await act(async () => emit(remoteWs, { type: "history", sessionId: "dup", gen: 1, attached: true, events: [{ t: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "remote text" } } }] }));
    await act(async () => emit(localWs, { type: "history", sessionId: "dup", gen: 1, attached: true, events: [{ t: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "local text" } } }] }));
    assert.match(remotePane.textContent, /remote text/);
    assert.doesNotMatch(remotePane.textContent, /local text/);
    assert.match(localPane.textContent, /local text/);
    assert.doesNotMatch(localPane.textContent, /remote text/);

    await act(async () => fill(remotePane.querySelector(".input-ta"), "hi remote"));
    await act(async () => remotePane.querySelector(".send").click());
    assert.ok(remoteWs.sent.some((m) => m.type === "prompt" && m.sessionId === "dup"));
    assert.ok(!localWs.sent.some((m) => m.type === "prompt"), "a pane's prompt stays on its own socket");
    await act(async () => fill(localPane.querySelector(".input-ta"), "hi local"));
    await act(async () => localPane.querySelector(".send").click());
    assert.ok(localWs.sent.some((m) => m.type === "prompt" && m.sessionId === "dup"));

    await act(async () => emit(remoteWs, { type: "permission_request", sessionId: "dup", requestId: "req-1", toolCall: { title: "run" }, options: [{ optionId: "allow", name: "Allow", kind: "allow" }] }));
    assert.ok(remotePane.querySelector(".perm-card"), "the permission card lands in the remote pane");
    await act(async () => [...remotePane.querySelectorAll(".perm-actions button")].find((b) => b.textContent === "Allow").click());
    assert.ok(remoteWs.sent.some((m) => m.type === "permission_response" && m.requestId === "req-1"));
    assert.ok(!localWs.sent.some((m) => m.type === "permission_response"), "request ids never leak across hosts");

    const switchPane = (pane) => {
      const select = document.querySelector(".pane-switcher select");
      select.value = pane.dataset.paneId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    await act(async () => switchPane(localPane));
    assert.ok(!location.search.includes("remote="), "focusing the local pane clears the deep link");
    assert.ok([...document.querySelectorAll(".session-row")].some((r) => r.title === "Local dup"));
    assert.ok(![...document.querySelectorAll(".session-row")].some((r) => r.title === "Remote dup"));

    await act(async () => switchPane(remotePane));
    const sentBefore = [...remoteWs.sent, ...localWs.sent].length;
    await act(async () => document.querySelector('[aria-label="关闭当前窗格"]').click());
    assert.equal(document.querySelectorAll(".chat-pane").length, 1);
    assert.equal(remoteWs.closed, true, "leaving use releases that host's socket");
    assert.equal([...remoteWs.sent, ...localWs.sent].slice(sentBefore).some((m) => m.type === "cancel"), false, "closing a view never cancels its task");
    const savedLayout = JSON.parse(sessionStorage.getItem("dw.layout"));
    assert.equal(savedLayout.root.host, "", "saved panes carry their host");
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.close();
    for (const [k, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete globalThis[k];
    }
  }
});

test("offline actions never replay, and pane drops feed the composer", async () => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const sockets = [];
  const FakeWebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.closed = false; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.closed = true; }
  };
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "FileReader", "navigator"].map((k) => [k, dom.window[k]])),
    fetch: async (url) => {
      const respond = (data) => ({ ok: true, json: async () => data });
      if (url === "/api/remotes") return respond({ hosts: [], keyConfigured: true });
      if (url === "/api/agents") return respond({ agents: [{ id: "pi", name: "Pi", caps: {} }] });
      if (url === "/api/state") return respond({ workspaces: ["/tmp"], home: "/tmp" });
      if (url === "/api/sessions") return respond({ sessions: [{ sessionId: "s1", title: "Chat", cwd: "/tmp", agent: "pi" }] });
      return respond({});
    },
    WebSocket: FakeWebSocket,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  let vite;
  let root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
    root = createRoot(document.getElementById("root"));
    history.replaceState(null, "", "#/session/s1");
    sessionStorage.setItem("dw.layout", JSON.stringify({ root: { id: "p1", host: "", sessionId: "s1", cwd: "/tmp" }, focusedId: "p1" }));
    const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
    await act(async () => root.render(React.createElement(App)));
    const ws = sockets.find((s) => s.url === "ws://localhost/ws");
    await act(async () => ws.onopen());
    const emit = (sock, msg) => sock.onmessage({ data: JSON.stringify(msg) });
    await act(async () => emit(ws, { type: "history", sessionId: "s1", gen: 1, attached: true, state: "working", events: [{ t: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } }] }));
    assert.ok(document.querySelector(".stop"), "a running turn shows the stop button");

    // Socket drops mid-frame without onStatus — every action send must fail
    // in place, warn, and leave nothing for the reconnect to replay.
    const { environment } = await vite.ssrLoadModule("/src/api.js");
    environment("").ws.open = false;
    ws.readyState = 3;
    const sentBefore = ws.sent.length;
    await act(async () => document.querySelector(".stop").click());
    await act(async () => emit(ws, { type: "permission_request", sessionId: "s1", requestId: "req-off", toolCall: { title: "run" }, options: [{ optionId: "allow", name: "Allow", kind: "allow" }] }));
    const allow = [...document.querySelectorAll(".perm-actions button")].find((b) => b.textContent === "Allow");
    assert.ok(allow, "the permission card stays answerable while offline");
    await act(async () => allow.click());
    assert.equal(ws.sent.slice(sentBefore).filter((m) => ["cancel", "permission_response"].includes(m.type)).length, 0, "no action goes out offline");
    assert.ok([...document.querySelectorAll(".notice-stack .toast.warn, .notice-stack .banner")].some((n) => n.textContent.includes("连接不可用")), "the failed send warns instead of queueing");
    assert.ok(document.querySelector(".perm-card"), "a failed answer never marks the card answered");
    await act(async () => { environment("").ws.open = true; ws.readyState = 1; ws.onopen(); });
    assert.equal(ws.sent.slice(sentBefore).filter((m) => ["cancel", "permission_response"].includes(m.type)).length, 0, "reconnect replays no user actions");

    // Pane-level drops feed the composer's existing attachment path.
    const chat = document.querySelector(".chat");
    const dropEvent = (dataTransfer) => {
      const e = new window.Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", { value: dataTransfer });
      return e;
    };
    const textFile = new window.File(["plain text body"], "note.txt", { type: "text/plain" });
    await act(async () => {
      chat.dispatchEvent(dropEvent({ types: ["Files"], files: [textFile], items: [{ kind: "file", webkitGetAsEntry: () => null, getAsFile: () => textFile }] }));
      await new Promise((resolve) => setTimeout(resolve, 20)); // FileReader is async
    });
    assert.ok(document.querySelector(".file-chip"), "a text file drop adds an attachment chip");
    await act(async () => chat.dispatchEvent(dropEvent({ types: ["Files"], files: [], items: [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }] })));
    assert.match(document.querySelector(".input-error")?.textContent || "", /不支持拖入文件夹/);
    const plainDrop = dropEvent({ types: ["text/plain"] });
    await act(async () => chat.dispatchEvent(plainDrop));
    assert.equal(plainDrop.defaultPrevented, false, "text/link drags keep their default behavior");
    const stray = dropEvent({ types: ["Files"], files: [textFile], items: [] });
    await act(async () => document.body.dispatchEvent(stray));
    assert.equal(stray.defaultPrevented, true, "a Files drop outside the pane can never navigate away");
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.close();
    for (const [k, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete globalThis[k];
    }
  }
});

test("pane markers track completion and attention across splits", async () => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const sockets = [];
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "FileReader", "navigator"].map((k) => [k, dom.window[k]])),
    fetch: async (url) => {
      const respond = (data) => ({ ok: true, json: async () => data });
      if (url === "/api/remotes") return respond({ hosts: [], keyConfigured: true });
      if (url === "/api/agents") return respond({ agents: [{ id: "pi", name: "Pi", caps: {} }] });
      if (url === "/api/state") return respond({ workspaces: ["/tmp"], home: "/tmp" });
      if (url === "/api/sessions") return respond({ sessions: [{ sessionId: "s1", title: "One", cwd: "/tmp", agent: "pi" }, { sessionId: "s2", title: "Two", cwd: "/tmp", agent: "pi" }] });
      return respond({});
    },
    WebSocket: class { constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); } send() {} close() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  let vite, root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
    root = createRoot(document.getElementById("root"));
    sessionStorage.setItem("dw.layout", JSON.stringify({ root: { id: "split", axis: "row", ratio: .5, children: [
      { id: "p1", host: "", sessionId: "s1", cwd: "/tmp" }, { id: "p2", host: "", sessionId: "s2", cwd: "/tmp" }] }, focusedId: "p1" }));
    const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
    await act(async () => root.render(React.createElement(App)));
    const ws = sockets.find((s) => s.url === "ws://localhost/ws");
    await act(async () => ws.onopen());
    const emit = (msg) => ws.onmessage({ data: JSON.stringify(msg) });
    // s2 in the unfocused pane runs then idles -> pane-done + switcher suffix.
    await act(async () => { emit({ type: "session_state", sessionId: "s2", state: "working" });
      emit({ type: "history", sessionId: "s2", gen: 1, state: "working", events: [] }); });
    await act(async () => { emit({ type: "session_state", sessionId: "s2", state: "idle" });
      emit({ type: "history", sessionId: "s2", gen: 2, state: "idle", events: [] }); });
    const pane2 = document.querySelector('[data-pane-id="p2"]');
    assert.ok(pane2.classList.contains("pane-done"), "an unfocused finished turn marks the pane done");
    const option = [...document.querySelectorAll(".pane-switcher option")].find((o) => o.value === "p2");
    assert.match(option.textContent, /· 已完成$/, "the switcher labels the done pane");
    const option1 = [...document.querySelectorAll(".pane-switcher option")].find((o) => o.value === "p1");
    assert.doesNotMatch(option1.textContent, /已完成/, "the focused pane never shows done");
    await act(async () => emit({ type: "permission_request", sessionId: "s2", requestId: "pr1", toolCall: { title: "t" }, options: [] }));
    assert.ok(document.querySelector('[data-pane-id="p2"]').classList.contains("pane-attention"), "a pending card marks the pane for attention");
    assert.match([...document.querySelectorAll(".pane-switcher option")].find((o) => o.value === "p2").textContent, /· 待确认/);
    await act(async () => pane2.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
    assert.ok(!document.querySelector('[data-pane-id="p2"]').classList.contains("pane-done"), "focusing clears the done mark");
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.close();
    for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});

test("pane drag-swap reorders leaves without remounting composers", async () => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "FileReader", "navigator"].map((k) => [k, dom.window[k]])),
    fetch: async (url) => {
      const respond = (data) => ({ ok: true, json: async () => data });
      if (url === "/api/remotes") return respond({ hosts: [], keyConfigured: true });
      if (url === "/api/agents") return respond({ agents: [{ id: "pi", name: "Pi", caps: {} }] });
      if (url === "/api/state") return respond({ workspaces: ["/tmp"], home: "/tmp" });
      if (url === "/api/sessions") return respond({ sessions: [{ sessionId: "s1", title: "One", cwd: "/tmp", agent: "pi" }, { sessionId: "s2", title: "Two", cwd: "/tmp", agent: "pi" }] });
      return respond({});
    },
    WebSocket: class { readyState = 1; send() {} close() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  let vite, root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
    root = createRoot(document.getElementById("root"));
    history.replaceState(null, "", "#/session/s1");
    sessionStorage.setItem("dw.layout", JSON.stringify({ root: { id: "split", axis: "row", ratio: .5, children: [
      { id: "p1", host: "", sessionId: "s1", cwd: "/tmp" }, { id: "p2", host: "", sessionId: "s2", cwd: "/tmp" }] }, focusedId: "p1" }));
    const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
    await act(async () => root.render(React.createElement(App)));
    const ta = document.querySelector('[data-pane-id="p1"] .input-ta');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(ta, "draft text");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(document.querySelector(".mobile-pane-tabs"), null, "removed mobile strip does not render hidden tabs");
    assert.equal(document.querySelector('[aria-label="新增聊天窗口"]'), null);
    const selector = document.querySelector('.pane-switcher select');
    await act(async () => { selector.value = "p2"; selector.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.equal(document.querySelector('[data-pane-id="p2"]').classList.contains("focused"), true);
    assert.equal(document.querySelector('[data-pane-id="p1"] .input-ta'), ta);
    assert.equal(ta.value, "draft text", "the retained desktop selector preserves composers and drafts");
    await act(async () => { selector.value = "p1"; selector.dispatchEvent(new Event("change", { bubbles: true })); });
    const beforeLeft = document.querySelector('[data-pane-id="p1"]').style.getPropertyValue("--pane-left");
    const drop = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["application/x-dw-pane"], getData: () => "p1" } });
    await act(async () => document.querySelector('[data-pane-id="p2"]').dispatchEvent(drop));
    const moved = document.querySelector('[data-pane-id="p1"]');
    assert.notEqual(moved.style.getPropertyValue("--pane-left"), beforeLeft, "the panes traded positions");
    assert.equal(moved.querySelector(".input-ta"), ta, "the composer never remounted");
    assert.equal(ta.value, "draft text", "the draft survives the swap");
    const { default: SplitWorkspace } = await vite.ssrLoadModule("/src/components/SplitWorkspace.jsx");
    const actions = [], dragLayout = JSON.parse(sessionStorage.getItem("dw.layout"));
    await act(async () => root.render(React.createElement(SplitWorkspace, { layout: dragLayout, titles: {}, onAction: (action) => actions.push(action), renderPane: () => null })));
    const divider = document.querySelector(".split-divider"); divider.setPointerCapture = () => {};
    const pointer = (type, x = 350) => divider.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId: 1, clientX: x, clientY: 100 }));
    await act(async () => pointer("pointerdown"));
    assert.ok(document.querySelector(".split-resize-shield"), "a local shield prevents stray pane clicks without restyling all history nodes");
    await act(async () => { pointer("pointermove", 330); pointer("pointermove", 360); });
    assert.equal(actions.length, 0, "resize events are frame-batched");
    await act(async () => pointer("pointerup"));
    assert.equal(actions.length, 1, "pointer up flushes the last pending ratio once");
    assert.equal(actions[0].type, "ratio");
    assert.equal(document.querySelector(".split-resize-shield"), null);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 35)));
    assert.equal(actions.length, 1, "a cancelled animation frame cannot replay an old ratio");
    await act(async () => { pointer("pointerdown"); pointer("pointermove", 390); });
    await act(async () => root.unmount()); root = null;
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(actions.length, 1, "unmount cancels pending resize work");
    assert.equal(document.body.classList.contains("layout-resizing"), false);
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.close();
    for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});

test("each pane owns its terminal dropdown across hosts", async () => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const sockets = [], terminalFetch = [];
  const H = "remote-h";
  dom.window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "FileReader", "navigator", "HTMLTextAreaElement"].map((k) => [k, dom.window[k]])),
    fetch: async (url) => {
      const respond = (data) => ({ ok: true, json: async () => data });
      if (url === "/api/remotes") return respond({ hosts: [{ id: H, label: "Devbox", hostname: "d", username: "u", port: 22, state: "connected", fingerprint: "SHA256:x" }], keyConfigured: true });
      if (url === "/api/agents" || url.endsWith("/proxy/api/agents")) return respond({ agents: [{ id: "pi", name: "Pi", caps: {} }] });
      if (url === "/api/state" || url.endsWith("/proxy/api/state")) return respond({ workspaces: ["/tmp"], home: "/tmp" });
      if (url === "/api/sessions" || url.endsWith("/proxy/api/sessions")) return respond({ sessions: [{ sessionId: "s1", title: "One", cwd: "/tmp", agent: "pi" }] });
      if (url.startsWith("/api/terminal") || url.includes("/proxy/api/terminal")) { terminalFetch.push(url); return respond({ available: true }); }
      return respond({});
    },
    WebSocket: class { constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); } send() {} close() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  let vite, root;
  try {
    const { createRoot } = await import("react-dom/client");
    // xterm cannot run in JSDOM: alias its modules with permissive stubs so
    // TerminalPanel mounts and opens its connection.
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom",
      resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: new URL("./xterm-stub.mjs", import.meta.url).pathname },
        { find: /^@xterm\/addon-fit$/, replacement: new URL("./xterm-fit-stub.mjs", import.meta.url).pathname }] },
      ssr: { noExternal: [/^@xterm/] } });
    root = createRoot(document.getElementById("root"));
    sessionStorage.setItem("dw.layout", JSON.stringify({ root: { id: "split", axis: "row", ratio: .5, children: [
      { id: "p1", host: "", sessionId: null, cwd: "/tmp" }, { id: "p2", host: H, sessionId: null, cwd: "/tmp" }] }, focusedId: "p1" }));
    const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
    await act(async () => root.render(React.createElement(App)));
    const toggles = [...document.querySelectorAll("[data-terminal-toggle]")];
    assert.equal(toggles.length, 2, "each pane's welcome exposes its own toggle");
    for (const toggle of toggles) await act(async () => toggle.click());
    await act(async () => { // lazy TerminalPanel import + mount can take a moment
      for (let i = 0; i < 150 && terminalFetch.length < 2 && !document.querySelector(".err-msg"); i++)
        await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // NOTE: xterm is stubbed (resolve.alias) and the panel mounts per pane,
    // but the async connect() chain never issues a fetch in JSDOM — socket
    // URL routing is therefore asserted via the env data sockets instead.
const panels = document.querySelectorAll(".terminal-panel");
    assert.ok(panels.length >= 2, "two pane terminals mount side by side");
    assert.ok(terminalFetch.some((u) => u.startsWith("/api/terminal")), "the local pane probes its own terminal");
    assert.ok(terminalFetch.some((u) => u.includes(`/api/remotes/${H}/proxy/api/terminal`)), "the remote pane probes its remote terminal");
    assert.ok(sockets.some((s) => s.url === "ws://localhost/ws") && sockets.some((s) => s.url === `ws://localhost/ws/remotes/${H}`), "each pane's host keeps its own socket");
    const saved = JSON.parse(sessionStorage.getItem("dw.layout"));
    assert.deepEqual(paneLeaves(saved.root).map((pane) => pane.terminal === true), [true, true], "both leaves persist their flag");
    await act(async () => document.querySelector('[data-pane-id="p1"] [data-terminal-toggle]').click());
    assert.equal(JSON.parse(sessionStorage.getItem("dw.layout")).root.children[0].terminal, false, "closing one drops only its flag");
    assert.equal(JSON.parse(sessionStorage.getItem("dw.layout")).root.children[1].terminal, true, "the other pane's terminal stays open");
    // Ctrl+` toggles only the focused pane.
    const flagOf = () => paneLeaves(JSON.parse(sessionStorage.getItem("dw.layout")).root).map((pane) => !!pane.terminal);
    await act(async () => document.querySelector('[data-pane-id="p2"]').dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
    const before = flagOf();
    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { code: "Backquote", ctrlKey: true, bubbles: true })));
    const after = flagOf();
    assert.equal(after[0], before[0], "the unfocused pane's flag is untouched");
    assert.notEqual(after[1], before[1], "Ctrl+` toggles the focused pane only");
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.close();
    for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});

test("sidebar content search opens a prefilled transcript search", async (t) => {
  const { JSDOM } = await import("jsdom");
  const { createRoot } = await import("react-dom/client");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "FileReader", "navigator", "HTMLTextAreaElement"].map((k) => [k, dom.window[k]])),
    fetch: async (url) => {
      const respond = (data) => ({ ok: true, json: async () => data });
      if (url === "/api/remotes") return respond({ hosts: [], keyConfigured: true });
      if (url === "/api/agents") return respond({ agents: [{ id: "pi", name: "Pi", caps: {} }] });
      if (url === "/api/state") return respond({ workspaces: ["/tmp"], home: "/tmp" });
      if (url === "/api/sessions") return respond({ sessions: [{ sessionId: "s1", title: "One", cwd: "/tmp", agent: "pi" }] });
      if (url.startsWith("/api/sessions/search"))
        return respond({ results: [{ sessionId: "s1", agent: "pi", title: "One", cwd: "/tmp", role: "user", snippet: "…foo alpha bar…", matchStart: 5, matchEnd: 10, count: 1, countCapped: false }], truncated: true });
      return respond({});
    },
    WebSocket: class { constructor(url) { this.url = url; this.readyState = 1; } send() {} close() {} },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  const vite = await createServer({ root: new URL("../../web", import.meta.url).pathname, logLevel: "silent", server: { middlewareMode: true } });
  t.after(async () => { try { await vite.close(); } catch {} for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } });
  let root;
  try {
    const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
    root = createRoot(document.getElementById("root"));
    await act(async () => root.render(React.createElement(App)));
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 100)));
    const input = document.querySelector(".sb-search input");
    await act(async () => {
      const fiberKey = Object.keys(input).find((k) => k.startsWith("__reactFiber"));
      const onChange = input[fiberKey]?.pendingProps?.onChange || input[fiberKey]?.memoizedProps?.onChange;
      assert.equal(typeof onChange, "function", "search input carries onChange");
      onChange({ target: { value: "alpha" } });
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    await act(async () => { for (let i = 0; i < 60 && !document.querySelector(".content-matches .content-hit"); i++) await new Promise((r) => setTimeout(r, 30)); });
    const row = document.querySelector(".content-matches .content-hit");
    assert.ok(row, "content matches section renders");
    assert.ok(row.querySelector("mark"), "match wrapped in mark");
    assert.ok(document.querySelector(".content-matches").textContent.includes("结果已截断"), "truncated footer shows");
    await act(async () => row.click());
    assert.ok(document.querySelector(".ts-search"), "transcript search opened in the pane");
    assert.equal(document.querySelector(".ts-search input")?.value, "alpha", "prefilled with the query");
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    // globals restored by t.after
  }
});

test("Pi branch list defaults to users and indents only forks, not linear conversations", async () => {
  const { sessionTreeRows } = await import("../../web/src/sessionTree.js");
  const raw = [
    { id: "m", parentId: null, kind: "model_change" },
    { id: "u", parentId: "m", kind: "user" },
    { id: "a", parentId: "u", kind: "assistant" },
    { id: "x", parentId: "a", kind: "user" },
    { id: "b", parentId: "a", kind: "assistant" },
    { id: "y", parentId: "b", kind: "user" },
    { id: "c", parentId: "y", kind: "assistant" },
    { id: "z", parentId: "c", kind: "user" },
    { id: "cursor", parentId: "z", kind: "custom" },
  ];
  const before = JSON.stringify(raw), list = sessionTreeRows(raw, "cursor");
  assert.deepEqual(list.rows.map((row) => row.id), ["u", "x", "y", "z"]);
  assert.ok(list.rows.every((row) => row.kind === "user"));
  assert.equal(list.nearest("c"), "y");
  assert.equal(list.current, "z"); assert.equal(list.byId.get("u").parent, null);
  assert.equal(list.byId.get("x").parent, "u"); assert.equal(list.byId.get("y").parent, "u", "hidden assistant fork preserves visible ancestry");
  assert.equal(list.byId.get("u").depth, 0);
  assert.equal(list.byId.get("x").depth, 1); assert.equal(list.byId.get("y").depth, 1);
  assert.equal(list.byId.get("z").depth, 1, "continuing on a branch adds no indentation");
  assert.ok(!list.byId.get("x").active); assert.ok(list.byId.get("y").active);
  assert.equal(list.byId.get("x").branchIndex, 1); assert.equal(list.byId.get("y").branchIndex, 2);
  assert.equal(list.byId.get("z").branchStart, false);
  assert.equal(sessionTreeRows(raw, "cursor", "all").current, "cursor");
  assert.ok(sessionTreeRows(raw, "cursor", "messages").byId.has("a"));
  assert.ok(!sessionTreeRows(raw, "cursor", "messages").byId.has("m"));
  assert.equal(sessionTreeRows(raw, "m").current, null);
  assert.equal(JSON.stringify(raw), before, "projection never mutates persisted tree data");
  const hiddenFork = sessionTreeRows([
    { id: "u", parentId: null, kind: "user" }, { id: "a", parentId: "u", kind: "assistant" },
    { id: "b", parentId: "a", kind: "assistant" }, { id: "x", parentId: "b", kind: "user" },
    { id: "empty-branch", parentId: "a", kind: "assistant" },
  ], "empty-branch");
  assert.equal(hiddenFork.current, "u"); assert.equal(hiddenFork.byId.get("x").depth, 1, "a native fork stays marked even when its other branch has no user messages");
  assert.equal(hiddenFork.byId.get("x").branchIndex, 1);
  const deep = Array.from({ length: 20000 }, (_, i) => ({ id: `n${i}`, parentId: i ? `n${i - 1}` : null, kind: i % 2 ? "custom" : "user" }));
  const linear = sessionTreeRows(deep, "n19999");
  assert.equal(linear.current, "n19998"); assert.equal(linear.rows.length, 10000);
  assert.ok(linear.rows.every((row) => row.depth === 0), "20,000 native entries remain a flat scrollable conversation");
  const repaired = sessionTreeRows([{ id: "a", parentId: "b", kind: "user" }, { id: "b", parentId: "a", kind: "user" }], "a");
  assert.equal(repaired.rows.length, 2); assert.ok(repaired.rows.every((row) => Number.isFinite(row.depth)), "corrupt cycles remain finite");
  assert.deepEqual(sessionTreeRows([{ id: "a", parentId: null, kind: "assistant" }], "a").rows, [], "no synthetic root or assistant leaks into the default view");
});

test("Pi visual tree scopes preview/navigation, protects drafts and never sends /tree as a model prompt", async () => {
  const { JSDOM } = await import("jsdom"), { createServer } = await import("vite"), { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const calls = [], sockets = [], H = "tree-host", version = "a".repeat(64);
  let finishNavigation, previewRead;
  const nodes = [
    { id: "u", parentId: null, kind: "user", text: "historic question", navigable: true },
    { id: "a", parentId: "u", kind: "assistant", text: "historic answer", navigable: true },
    { id: "u2", parentId: "a", kind: "user", text: "second user question", navigable: true },
    { id: "meta", parentId: "a", kind: "custom", text: "hidden metadata", navigable: false },
  ];
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "FileReader", "navigator"].map((k) => [k, dom.window[k]])),
    fetch: async (url, options = {}) => {
      calls.push({ url, options }); const respond = (data) => ({ ok: true, json: async () => data });
      if (url === "/api/remotes") return respond({ hosts: [{ id: H, label: "Tree host", state: "connected" }], keyConfigured: true });
      if (url.endsWith("/api/agents")) return respond({ agents: [{ id: "pi", name: "Pi", caps: { tree: true } }] });
      if (url.endsWith("/api/state")) return respond({ workspaces: ["/tmp"], home: "/tmp" });
      if (url.endsWith("/api/sessions")) return respond({ sessions: [{ sessionId: "dup", cwd: "/tmp", title: "Tree session", agent: "pi" }] });
      if (url.endsWith("/tree")) return respond({ nodes, leafId: "a", version, busy: false });
      if (url.includes("/tree/nodes/")) {
        const id = url.split("/").at(-1);
        if (previewRead) return await previewRead(id, respond);
        return respond({ ...nodes.find((node) => node.id === id), thinking: id === "a" ? "recorded thinking" : "" });
      }
      if (url.endsWith("/tree/navigate")) return await new Promise((resolve) => { finishNavigation = (data) => resolve(respond(data)); });
      return respond({});
    },
    WebSocket: class { constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); } send(raw) { this.sent.push(JSON.parse(raw)); } close() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  let vite, root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
    history.replaceState(null, "", `?remote=${H}#/session/dup`);
    sessionStorage.setItem("dw.layout", JSON.stringify({ root: { id: "remote-pane", host: H, cwd: "/tmp", sessionId: "dup" }, focusedId: "remote-pane" }));
    const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
    const { environment } = await vite.ssrLoadModule("/src/api.js");
    const { saveDraft, emptyDraft, readDraft } = await vite.ssrLoadModule("/src/composerDrafts.js");
    const fill = (element, value) => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); };
    root = createRoot(document.getElementById("root"));
    await act(async () => root.render(React.createElement(App)));
    const remoteWs = sockets.find((sock) => sock.url.includes(`/ws/remotes/${H}`));
    await act(async () => { remoteWs.onopen(); remoteWs.onmessage({ data: JSON.stringify({ type: "history", sessionId: "dup", attached: true, gen: 1, events: [] }) }); });
    await act(async () => fill(document.querySelector(".input-ta"), "/tree"));
    const beforePrompt = remoteWs.sent.filter((msg) => msg.type === "prompt").length;
    await act(async () => document.querySelector(".send").click());
    assert.ok(document.querySelector(".session-tree"));
    assert.equal(remoteWs.sent.filter((msg) => msg.type === "prompt").length, beforePrompt, "/tree must not call a model or create a delivery receipt");
    assert.ok(calls.some((call) => call.url === `/api/remotes/${H}/proxy/api/sessions/dup/tree`));
    assert.ok(!calls.some((call) => call.url === "/api/sessions/dup/tree"));
    assert.equal(document.querySelector(".tree-filter").value, "user");
    assert.equal(document.querySelectorAll(".tree-row").length, 2);
    assert.ok([...document.querySelectorAll(".tree-row")].every((row) => row.dataset.kind === "user"));
    assert.equal(document.querySelector('[data-tree-node="a"]'), null, "assistant rows are hidden by default");
    assert.equal(document.querySelector(".tree-list-panel svg"), null, "a normal list replaces the canvas");
    const filter = (value) => { const select = document.querySelector(".tree-filter"); select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); };
    await act(async () => filter("all"));
    await act(async () => document.querySelector('[data-tree-node="meta"]').click());
    assert.equal(document.querySelector(".tree-continue .btn").disabled, true, "metadata cannot become a navigation target");
    await act(async () => filter("messages"));
    assert.equal(document.querySelector('[data-tree-node="meta"]'), null);
    await act(async () => document.querySelector('[data-tree-node="a"]').click());
    assert.ok(document.querySelector(".tree-preview").textContent.includes("historic answer"));
    await act(async () => document.querySelector(".tree-list-panel").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    await act(async () => filter("user"));
    assert.equal(document.querySelector('[data-tree-node="u"]').getAttribute("aria-pressed"), "true");
    await act(async () => {
      const input = document.querySelector(".tree-search");
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "second");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.querySelector('[aria-label="下一个匹配"]').click());
    assert.equal(document.querySelector('[data-tree-node="u2"]').getAttribute("aria-pressed"), "true");
    await act(async () => document.querySelector('[aria-label="定位当前分支"]').click());
    assert.equal(document.querySelector('[data-tree-node="u"]').getAttribute("aria-pressed"), "true");
    assert.ok(document.querySelector(".tree-preview").textContent.includes("historic question"));
    const continueButton = () => [...document.querySelectorAll(".tree-continue button")].find((b) => b.textContent.includes("从这里继续"));
    assert.equal(continueButton().disabled, false);
    // Closing never switches context; menu entry reopens with the latest draft.
    await act(async () => document.querySelector('[aria-label="关闭会话树"]').click());
    await act(async () => fill(document.querySelector(".input-ta"), "keep unsent draft"));
    await act(async () => document.querySelector('[aria-label="更多会话操作"]').click());
    await act(async () => [...document.querySelectorAll(".ctx-item")].find((b) => b.textContent === "会话树").click());
    await act(async () => document.querySelector(".tree-list-panel").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    assert.equal(continueButton().disabled, true, "draft replacement needs explicit consent");
    const checks = [...document.querySelectorAll(".tree-continue input")];
    assert.equal(checks[0].checked, false, "model summary is default-off");
    await act(async () => checks[1].click());
    assert.equal(continueButton().disabled, false);
    await act(async () => { continueButton().click(); });
    const navCalls = calls.filter((call) => call.url.endsWith("/tree/navigate"));
    assert.equal(navCalls.length, 1); assert.equal(navCalls[0].url, `/api/remotes/${H}/proxy/api/sessions/dup/tree/navigate`);
    assert.deepEqual(JSON.parse(navCalls[0].options.body), { targetId: "u", version, summarize: false });
    assert.ok(navCalls[0].options.signal, "navigation has an abortable request deadline");
    assert.equal(continueButton().disabled, true);
    await act(async () => document.querySelector('[aria-label="关闭会话树"]').click());
    // A same-id local session's draft is unrelated to the delayed remote result.
    saveDraft({ ...emptyDraft("dup"), text: "local draft" }, environment(""));
    await act(async () => { finishNavigation({ cancelled: false, editorText: "historic question", leafId: "cursor", version, historyGen: 2 }); });
    assert.equal(document.querySelector(".input-ta").value, "historic question");
    assert.equal(readDraft("dup", environment("")).text, "local draft");
    assert.equal(readDraft("dup", environment(H)).text, "historic question");
    assert.ok(document.querySelector(".ld-text"), "an HTTP success waits for its corresponding complete history snapshot");
    assert.equal(document.querySelector(".input-ta").disabled, true, "cannot send against a stale visible branch");
    await act(async () => remoteWs.onmessage({ data: JSON.stringify({ type: "history", sessionId: "dup", gen: 1, revision: 2, attached: true,
      events: [{ t: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stale branch" } } }] }) }));
    assert.ok(document.querySelector(".ld-text"), "a late old generation cannot claim readiness");
    assert.ok(!document.querySelector(".transcript").textContent.includes("stale branch"));
    await act(async () => remoteWs.onmessage({ data: JSON.stringify({ type: "history", sessionId: "dup", gen: 2, attached: true,
      events: [{ t: 2, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new active branch" } } }] }) }));
    assert.ok(!document.querySelector(".ld-text")); assert.equal(document.querySelector(".input-ta").disabled, false);
    assert.ok(document.querySelector(".transcript").textContent.includes("new active branch"));
    // Once fulfilled, a fence cannot be revived by future lower generations
    // (for example after an idle server entry is recreated).
    await act(async () => remoteWs.onmessage({ data: JSON.stringify({ type: "history", sessionId: "dup", gen: 1, revision: 99, attached: true, events: [] }) }));
    assert.equal(document.querySelector(".input-ta").disabled, false);


    assert.ok(!remoteWs.sent.some((msg) => msg.type === "cancel"));
    assert.equal(remoteWs.sent.filter((msg) => msg.type === "prompt").length, beforePrompt, "switching never auto-sends the restored prompt");
    // Invalid/lost responses are not success: keep the draft and do not retry.
    await act(async () => document.querySelector('[aria-label="更多会话操作"]').click());
    await act(async () => [...document.querySelectorAll(".ctx-item")].find((b) => b.textContent === "会话树").click());
    await act(async () => document.querySelector('[data-tree-node="u"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(document.querySelector('[data-tree-node="u"]').getAttribute("aria-pressed"), "true", "assistive click activation selects the node without a pointer gesture");
    await act(async () => document.querySelectorAll(".tree-continue input")[1].click());
    await act(async () => { continueButton().click(); });
    await act(async () => { finishNavigation({}); });
    assert.equal(document.querySelector(".input-ta").value, "historic question", "malformed success cannot erase a draft");
    assert.ok(document.querySelector(".tree-error").textContent.includes("未确认"));
    assert.equal(calls.filter((call) => call.url.endsWith("/tree/navigate")).length, 2, "no automatic mutation retry");
    await act(async () => document.querySelector('[aria-label="关闭会话树"]').click());
    // A fresh connection can recreate a server entry at gen:1, even within
    // the same worker. Its complete snapshot releases the outstanding fence,
    // including when its content fingerprint equals the previously cached one.
    await act(async () => document.querySelector('[aria-label="更多会话操作"]').click());
    await act(async () => [...document.querySelectorAll(".ctx-item")].find((b) => b.textContent === "会话树").click());
    await act(async () => document.querySelector('[data-tree-node="u"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    await act(async () => document.querySelectorAll(".tree-continue input")[1].click());
    await act(async () => { continueButton().click(); });
    await act(async () => { finishNavigation({ cancelled: false, editorText: "historic question", leafId: "cursor", version, historyGen: 5 }); });
    assert.ok(document.querySelector(".ld-text"));
    const beforeConnection = environment(H).ws.connectionId;
    await act(async () => { remoteWs.readyState = 3; remoteWs.onclose(); environment(H).ws._wake(); });
    const replacement = sockets.at(-1);
    await act(async () => { replacement.onopen(); replacement.onmessage({ data: JSON.stringify({ type: "history", sessionId: "dup", gen: 1, revision: 99, attached: true, events: [] }) }); });
    assert.notEqual(environment(H).ws.connectionId, beforeConnection);
    assert.ok(!document.querySelector(".ld-text"), "fresh authoritative history may reset generation numbering");
    assert.equal(document.querySelector(".input-ta").disabled, false);


  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close(); dom.window.close();
    for (const [k, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else delete globalThis[k]; }
  }
});

test("process summaries are live state and completion notifications deduplicate in history and exports", async () => {
  const { applyUpdate, emptySession, foldEvents } = await import("../../web/src/sessionReducer.js");
  const { buildMarkdown } = await import("../../web/src/export.js");
  let s = emptySession();
  const update = { sessionUpdate: "session_info_update", _meta: { piAcp: { running: true, processes: { available: true, activeCount: 1, pending: false, limit: 8 } } } };
  s = applyUpdate(s, update, 1); assert.equal(s.running, true); assert.equal(s.processes.activeCount, 1);
  const notice = { sessionUpdate: "session_info_update", _meta: { piAcp: { processNotification: { id: "notification-1", processId: "job-1", name: "tests", kind: "failure", summary: "exit 7", at: 2, exitCode: 7 } } } };
  s = applyUpdate(s, notice, 2); const unchanged = applyUpdate(s, notice, 2);
  assert.equal(s, unchanged);
  assert.equal(s.items[0].kind, "processNotification");
  assert.equal(s.items[0].notificationKind, "failure", "keep the upstream event kind separate from the transcript item kind");
  assert.match(buildMarkdown(s.items), /tests.*\*\*\n> exit 7/);
  const replay = foldEvents([{ update }, { update: notice }, { update: notice }]);
  assert.equal(replay.items.length, 1);
  assert.equal(replay.processes.limit, 8);
  assert.equal(emptySession().processes, null, "old process tool calls never imply a running OS process");
});

test("successful process notices collapse across tool runs while failures, boundaries and search stay visible", async () => {
  const { JSDOM } = await import("jsdom"), { createServer } = await import("vite"), { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "FileReader", "navigator"].map((k) => [k, dom.window[k]])),
    fetch: async () => ({ ok: true, json: async () => ({}) }), WebSocket: class { readyState = 1; send() {} close() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  let vite, root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
    const { default: ChatView } = await vite.ssrLoadModule("/src/components/ChatView.jsx");
    const { setUi } = await vite.ssrLoadModule("/src/ui.js");
    const { buildMarkdown } = await vite.ssrLoadModule("/src/export.js");
    const notice = (key, kind = "success", exitCode = 0) => ({ key, id: key, kind: "processNotification", notificationKind: kind, name: key, summary: `RESULT_${key}`, exitCode });
    const tool = (key) => ({ key, kind: "tool", status: "completed", toolName: "bash", rawInput: { command: "true" } });
    let session = { ...emptySession(), historyLoading: false, attached: true, items: [
      { key: "u", kind: "user", text: "run checks" }, tool("t1"), notice("first"),
      { key: "thinking", kind: "thought", text: "keep working" }, tool("t2"), notice("second"),
      notice("failure", "failure", 7), notice("ready", "log_match", 0),
      notice("third"), { key: "answer", kind: "agent", text: "Done" }, notice("after-prose"),
    ] };
    const original = JSON.stringify(session.items);
    root = createRoot(document.getElementById("root"));
    const render = (extra = {}) => act(async () => root.render(React.createElement(ChatView, { sessionId: "process-summary", session, wsUp: true, onSend() {}, onCancel() {}, ...extra })));
    await render();
    const summaries = () => [...document.querySelectorAll(".process-summary")];
    assert.equal(summaries().length, 3, "successes merge through tools, but not failures, log matches or prose");
    assert.match(summaries()[0].querySelector("summary").textContent, /2/);
    assert.equal(document.querySelectorAll(".toolgroup").length, 1, "success notices no longer split the tool run");
    assert.equal(summaries()[0].querySelector(".process-notification"), null, "closed summaries keep detail bodies lazy");
    assert.deepEqual([...document.querySelectorAll(".process-notification")].map((el) => el.dataset.searchKey), ["failure", "ready"]);
    const first = summaries()[0], head = first.querySelector("summary");
    await act(async () => head.click());
    assert.equal(head.getAttribute("aria-expanded"), "true");
    assert.match(first.textContent, /RESULT_first/); assert.match(first.textContent, /RESULT_second/);
    session = { ...session, items: [...session.items.slice(0, 6), notice("fourth"), ...session.items.slice(6)] };
    await render();
    assert.equal(summaries()[0], first, "appended completions preserve the disclosure identity and manual state");
    assert.equal(head.getAttribute("aria-expanded"), "true"); assert.match(head.textContent, /3/);
    await act(async () => setUi({ motion: "off" }));
    await act(async () => head.click());
    assert.equal(first.querySelector(".process-notification"), null);
    await render({ searchRequest: { n: 1, q: "RESULT_second" } });
    assert.equal(head.getAttribute("aria-expanded"), "true", "search immediately reveals a collapsed success");
    assert.ok(first.querySelector('[data-search-key="second"]'));
    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(head.getAttribute("aria-expanded"), "false", "closing search restores manual expansion state");
    await act(async () => setUi({ autoFold: "1" }));
    assert.equal(document.querySelectorAll(".stream-root").length, 1);
    assert.equal(summaries().length, 3, "the live-block preference keeps the same notification summary policy");
    assert.ok(buildMarkdown(session.items).includes("RESULT_fourth"));
    assert.equal(JSON.stringify(session.items.filter((item) => item.key !== "fourth")), original, "presentation never mutates or discards transcript records");
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close(); dom.window.close();
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

test("background process panel scopes reads/stops to its host+session and never retries uncertain stops", async () => {
  const { JSDOM } = await import("jsdom"), { createServer } = await import("vite"), { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const calls = [];
  let stopA, delayedLogA, holdLogs = false;
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "navigator"].map((k) => [k, dom.window[k]])),
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      const host = url.includes("/host-A/") ? "A" : "B";
      const respond = (data) => ({ ok: true, json: async () => data });
      if (options.method === "POST") {
        if (host === "A") return await new Promise((resolve) => { stopA = () => resolve(respond({ process: { id: "same-job", status: "killed" } })); });
        throw new Error("lost stop response");
      }
      if (url.endsWith("/output")) {
        if (host === "A" && holdLogs) return await new Promise((resolve) => { delayedLogA = () => resolve(respond({ id: "same-job", text: "STALE_A_LOGS" })); });
        return respond({ id: "same-job", text: `LOG_${host} <img src=x onerror=alert(1)>`, truncated: false });
      }
      return respond({ available: true, attached: true, activeCount: 1, limit: 8, processes: [{ id: "same-job", name: `JOB_${host}`, command: `echo ${host}`, cwd: `/tmp/${host}`, pid: 123, status: "running" }] });
    },
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  let vite, root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
    const { default: Panel } = await vite.ssrLoadModule("/src/components/ProcessesPanel.jsx");
    const { EnvironmentContext } = await vite.ssrLoadModule("/src/environmentContext.js");
    const { environment } = await vite.ssrLoadModule("/src/api.js");
    root = createRoot(document.getElementById("root"));
    const render = async (host, wsUp = true) => {
      await act(async () => root.render(React.createElement(EnvironmentContext.Provider, { value: environment(`host-${host}`) },
        React.createElement(Panel, { key: host, sessionId: "same-session", title: "fixture", environmentName: host, wsUp, onClose() {} }))));
    };
    await render("A");
    assert.match(document.querySelector(".processes-output").textContent, /LOG_A/);
    assert.equal(document.querySelector(".processes-output img"), null, "logs must be plain text, never interpreted HTML");
    const stop = () => document.querySelector(".processes-detail-head .btn");
    const confirm = () => [...document.querySelectorAll(".confirm-dialog .modal-actions button")].at(-1);
    await act(async () => { stop().click(); stop().click(); });
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 0, "stopping now requires confirmation first");
    await act(async () => { confirm().click(); });
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
    holdLogs = true;
    await act(async () => document.querySelector('[aria-label="刷新任务列表"]').click());
    await render("B");
    await act(async () => { stopA(); delayedLogA(); });
    assert.match(document.querySelector(".processes-output").textContent, /LOG_B/);
    assert.ok(!document.querySelector(".processes-panel").textContent.includes("STALE_A_LOGS"));
    await act(async () => stop().click());
    await act(async () => { confirm().click(); });
    assert.match(document.querySelector('.tree-error[role="alert"]').textContent, /不会自动重试/);
    assert.equal(stop().disabled, true);
    await act(async () => document.querySelector('[aria-label="刷新任务列表"]').click());
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 2, "verification only reads; it does not resend a stop");
    await render("B", false);
    assert.equal(stop().disabled, true);
    const mutations = calls.filter((call) => call.options.method === "POST");
    assert.deepEqual(mutations.map((call) => call.url), [
      "/api/remotes/host-A/proxy/api/sessions/same-session/processes/same-job/stop",
      "/api/remotes/host-B/proxy/api/sessions/same-session/processes/same-job/stop",
    ]);
    assert.ok(calls.every((call) => call.url.startsWith("/api/remotes/host-")), "remote actions must never fall back to localhost");
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.close();
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

test("history string-table roundtrip is exact, collision-free and rejects unsafe references", async () => {
  const { packHistoryEvents, unpackHistory, HISTORY_ENCODING } = await import("../src/history-wire.js");
  const long = "complete 中文🚀\r\n".repeat(300);
  const events = [{ t: 1, update: { content: long, same: long, marker: { $historyText: 0 }, data: JSON.parse('{"__proto__":{"value":null},"constructor":{"prototype":{"safe":true}}}'), nested: [null, long], date: new Date(0) } }];
  events[0].update.data.__proto__.value = long;
  events[0].update.jsonLike = { content: long, toJSON() { return this; } };
  const saved = JSON.stringify(events), packed = packHistoryEvents(events);
  assert.equal(packed.historyStrings.filter((text) => text === long).length, 1, "identical strings are transmitted once");
  const decoded = unpackHistory(JSON.parse(JSON.stringify({ historyEncoding: HISTORY_ENCODING, ...packed })));
  assert.equal(JSON.stringify(decoded.events), saved); assert.equal(JSON.stringify(events), saved); assert.equal({}.value, undefined);
  assert.throws(() => unpackHistory({ historyEncoding: HISTORY_ENCODING, events: [], historyStrings: [long], historyRefs: [[0, "__proto__", "polluted"]] }));
  assert.throws(() => unpackHistory({ historyEncoding: HISTORY_ENCODING, events: [null], historyStrings: [long], historyRefs: [[99, "events", 0]] }));
  assert.equal({}.polluted, undefined);
});

test("history transport resumes cached transcripts, preserves metadata and safely recovers missing UI caches", async () => {
  const { JSDOM } = await import("jsdom"), { createServer } = await import("vite"), { default: React, act } = await import("react");
  const { packHistoryEvents, HISTORY_ENCODING_V2, HISTORY_ENCODING } = await import("../src/history-wire.js");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/#/session/resume", pretendToBeVisual: true }), sockets = [];
  const globals = { ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "FileReader", "navigator"].map((key) => [key, dom.window[key]])),
    fetch: async (url) => ({ ok: true, json: async () => url === "/api/agents" ? { agents: [{ id: "pi", name: "Pi", caps: {} }] } : url === "/api/state" ? { home: "/tmp", workspaces: ["/tmp"] } : url === "/api/sessions" ? { sessions: [{ sessionId: "resume", agent: "pi", title: "Resume", cwd: "/tmp" }] } : { hosts: [] } }),
    WebSocket: class { readyState = 1; sent = []; constructor() { sockets.push(this); } send(raw) { this.sent.push(JSON.parse(raw)); } close() {} },
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let vite, root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
    const { default: App } = await vite.ssrLoadModule("/src/App.jsx"), { environment } = await vite.ssrLoadModule("/src/api.js");
    root = createRoot(document.getElementById("root")); await act(async () => root.render(React.createElement(App)));
    const client = environment("").ws, first = sockets[0], emit = (socket, message) => socket.onmessage({ data: JSON.stringify(message) });
    await act(async () => first.onopen());
    const beforeInvalid = first.sent.length;
    await act(async () => emit(first, { type: "history", sessionId: "resume", gen: 1, unchanged: true }));
    assert.equal(first.sent.length, beforeInvalid + 1); assert.equal(first.sent.at(-1).historyToken, null, "an unvalidated empty receipt cannot mark history ready");
    assert.equal(document.querySelector(".agent-body"), null);
    const text = "complete cached history 中文 ".repeat(100).trimEnd(), events = [{ t: 1, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }];
    const full = { type: "history", sessionId: "resume", gen: 2, revision: 1, state: "held", attached: true, historyToken: "first-token", historyEncoding: HISTORY_ENCODING_V2, historyLength: 1, usage: { size: 100, used: 50 }, ...packHistoryEvents(events) };
    await act(async () => emit(first, full));
    const body = document.querySelector(".agent-body"), composer = document.querySelector(".input-ta"); assert.equal(body.textContent, text);
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(composer, "preserved draft"); composer.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { first.readyState = 3; first.onclose(); client._wake(); });
    const next = sockets.at(-1); await act(async () => next.onopen());
    assert.equal(next.sent.find((message) => message.type === "subscribe").historyToken, "first-token");
    await act(async () => emit(next, { type: "history", sessionId: "resume", gen: 2, attached: true, state: "working", historyToken: "first-token", unchanged: true, historyEncoding: HISTORY_ENCODING_V2, historyLength: 1, usage: { size: 100, used: 77 }, queue: [] }));
    assert.equal(document.querySelector(".agent-body"), body, "validation does not rebuild historical Markdown");
    assert.equal(composer.value, "preserved draft"); assert.ok(document.querySelector(".stop"), "unchanged body still applies authoritative running state");
    assert.match(document.querySelector(".ctx-meter").title, /77%/, "a validated body still accepts the fresh context-usage envelope");
    client.send({ type: "unsubscribe", sessionId: "resume" }); client.send({ type: "subscribe", sessionId: "resume", cwd: "/tmp" });
    assert.equal(next.sent.at(-1).historyToken, "first-token", "reopening a retained cache avoids another full download");
    client.send({ type: "subscribe", sessionId: "evicted", cwd: "/tmp", historyToken: "evicted-token" });
    await act(async () => emit(next, { type: "history", sessionId: "evicted", gen: 1, historyToken: "evicted-token", unchanged: true }));
    assert.equal(next.sent.at(-1).historyToken, null, "a validator without corresponding UI data requests one full snapshot");
    await act(async () => emit(next, { type: "session_update", sessionId: "resume", gen: 2, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " tail" } } }));
    client.send({ type: "subscribe", sessionId: "resume", cwd: "/tmp" }); assert.equal(next.sent.at(-1).historyToken, null, "live changes invalidate the cached snapshot token");
    // Keep only the immutable authoritative checkpoint, never replay a delta
    // on top of the already-rendered live tail.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
    assert.equal(body.textContent, text + " tail");
    client.send({ type: "subscribe", sessionId: "resume", cwd: "/tmp", historyToken: null, historyBaseToken: "first-token" });
    assert.equal(next.sent.at(-1).historyEncoding, HISTORY_ENCODING, "old workers retain their v1 optimization");
    assert.deepEqual(next.sent.at(-1).historyEncodings, [HISTORY_ENCODING_V2, HISTORY_ENCODING]);
    await act(async () => { for (const id of ["KEEP_PERMISSION", "CLEAR_PERMISSION"]) emit(next, { type: "permission_request", sessionId: "resume", requestId: id, toolCall: { title: id }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }); });
    const deltaTail = [{ t: 2, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " tail" } } }];
    await act(async () => emit(next, { type: "history", sessionId: "resume", gen: 2, state: "working", attached: true,
      historyEncoding: HISTORY_ENCODING_V2, historyToken: "second-token", delta: true, historyBaseToken: "first-token", historyBaseLength: 1, historyLength: 2,
      usage: { size: 100, used: 81 }, configOptions: [], availableCommands: [], processes: { running: 0 }, pendingPermissionIds: ["KEEP_PERMISSION"], pendingElicitationIds: [], ...packHistoryEvents(deltaTail) }));
    assert.equal(document.querySelector(".agent-body"), body, "delta recovery preserves the original Markdown DOM");
    assert.equal(body.textContent, text + " tail", "an already applied live tail is not concatenated twice");
    assert.match(document.querySelector(".ctx-meter").title, /81%/);
    assert.ok(document.body.textContent.includes("KEEP_PERMISSION")); assert.ok(!document.body.textContent.includes("CLEAR_PERMISSION"), "authoritative permission IDs remove resolved cards without losing unanswered ones");
    assert.equal(composer.value, "preserved draft");
    await act(async () => emit(next, { type: "history", sessionId: "resume", gen: 2, historyEncoding: HISTORY_ENCODING_V2,
      historyToken: "second-token", unchanged: true, historyLength: 2, state: "held", attached: true, usage: null,
      modes: null, processes: null, pendingPermissionIds: [], pendingElicitationIds: [] }));
    assert.ok(!(document.querySelector(".ctx-meter")?.title || "").includes("81%"), "explicit unknown current usage never falls back to a stale cached percentage");
    assert.ok(!document.body.textContent.includes("KEEP_PERMISSION")); assert.equal(document.querySelector(".stop"), null);
    const beforeStale = next.sent.length;
    await act(async () => emit(next, { type: "history", sessionId: "resume", gen: 3, historyEncoding: HISTORY_ENCODING_V2,
      historyToken: "stale-token", delta: true, historyBaseToken: "second-token", historyBaseLength: 2, historyLength: 2, ...packHistoryEvents([]) }));
    assert.equal(next.sent.length, beforeStale + 1); assert.equal(next.sent.at(-1).historyBaseToken, null, "a generation mismatch requests an authoritative full snapshot");
    assert.ok([...document.querySelectorAll('[role="status"]')].some((node) => node.textContent.includes("正在加载会话")), "invalid deltas cannot leave old history ready for sending");

    await act(async () => emit(next, { type: "history", sessionId: "resume", gen: 3, state: "held", attached: true, events }));
    assert.equal(document.querySelector(".agent-body").textContent, text, "old workers remain compatible and discard queued older deltas");
    assert.equal(client.historyTokens.has("resume"), false);
    const beforeMalformed = next.sent.length;
    await act(async () => emit(next, { ...full, gen: 3, historyToken: "malformed-token", historyLength: 99 }));
    assert.equal(next.sent.length, beforeMalformed + 1); assert.equal(next.sent.at(-1).historyEncoding, null);
    assert.deepEqual(next.sent.at(-1).historyEncodings, [], "malformed v2 recovery cannot accidentally opt into the broken format again");
    assert.equal(next.sent.some((message) => ["prompt", "cancel"].includes(message.type)), false);
    const { default: ToolCall } = await vite.ssrLoadModule("/src/components/ToolCall.jsx");
    let serializations = 0;
    const original = "complete raw output 中文🚀\r\n".repeat(1000), rawOutput = { toJSON() { serializations++; return { original }; } };
    await act(async () => root.render(React.createElement(ToolCall, { item: { key: "lazy", title: "Read", toolName: "read", status: "completed", rawOutput, content: [{ type: "content", content: { type: "text", text: "Output preview" } }] } })));
    await act(async () => document.querySelector(".tool-head").click());
    assert.equal(serializations, 0, "an open tool must not stringify a closed multi-MiB raw-output disclosure");
    await act(async () => document.querySelector(".raw summary").click());
    assert.equal(document.querySelector(".raw pre").textContent, JSON.stringify({ original }, null, 2), "opening raw output still reveals its full original text");
    const { EnvironmentContext } = await vite.ssrLoadModule("/src/environmentContext.js");
    const wire = await vite.ssrLoadModule(new URL("../src/history-wire.js", import.meta.url).pathname);
    const assetUrl = "/api/sessions/raw-session/img/pi-" + "b".repeat(64) + "/0";
    const rawImage = { type: "image", mimeType: "image/png", data: null };
    const packet = wire.unpackHistory({ sessionId: "raw-session", historyEncoding: wire.HISTORY_ENCODING_V2, ...wire.packHistoryEvents([{ update: { rawOutput: { content: [rawImage] } } }]),
      historyAssets: [{ url: assetUrl, mimeType: "image/png", width: 20, height: 10, path: ["events", 0, "update", "rawOutput", "content", 0, "data"] }] });
    let imageReads = 0, finishImage;
    const imageData = "original base64\r\nwith preserved whitespace";
    globalThis.fetch = async (url) => { imageReads++; assert.equal(url, "/api/remotes/remote-assets/proxy" + assetUrl + "?encoding=base64");
      await new Promise((resolve) => { finishImage = resolve; }); return { ok: true, json: async () => ({ data: imageData, mimeType: "image/png" }) }; };
    await act(async () => root.render(React.createElement(EnvironmentContext.Provider, { value: environment("remote-assets") }, React.createElement(ToolCall, { key: "deferred", item: { key: "deferred", title: "read", rawOutput: packet.events[0].update.rawOutput, content: [{ type: "content", content: { type: "text", text: "complete text stays available" } }] } }))));
    assert.equal(imageReads, 0);
    await act(async () => document.querySelector(".tool-head").click()); assert.equal(imageReads, 0, "opening text output does not preload raw binary images");
    await act(async () => document.querySelector(".raw summary").click()); assert.equal(imageReads, 1);
    assert.ok([...document.querySelectorAll('[role="status"]')].some((node) => node.textContent.includes("完整原始图片")));
    assert.equal(document.querySelector(".raw pre"), null, "a placeholder is never presented as complete raw output");
    await act(async () => { finishImage(); });
    assert.equal(document.querySelector(".raw pre").textContent, JSON.stringify({ content: [{ ...rawImage, data: imageData }] }, null, 2));
    assert.equal(packet.events[0].update.rawOutput.content[0].data, null);
    const opaque = { type: "opaque", image: packet.events[0].update.rawOutput.content[0] };
    await act(async () => root.render(React.createElement(EnvironmentContext.Provider, { value: environment("remote-assets") }, React.createElement(ToolCall, { key: "opaque", bodyOnly: true, item: { key: "opaque", title: "read", content: [opaque] } }))));
    assert.equal(document.querySelector("pre.tool-out"), null, "unknown structured display also waits instead of printing null image placeholders");
    await act(async () => { finishImage(); });
    assert.equal(document.querySelector("pre.tool-out").textContent, JSON.stringify({ type: "opaque", image: { ...rawImage, data: imageData } }, null, 2));



  } finally {
    if (root) await act(async () => root.unmount()); if (vite) await vite.close(); dom.window.close();
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

test("file preview links preserve host/session paths and format JSON without changing values", async () => {
  const { fileLink, formatJson, previewResourcePath } = await import("../../web/src/filePreview.js");
  assert.deepEqual(fileLink("file:///tmp/report%20one.html#result"), { path: "/tmp/report one.html" });
  assert.deepEqual(fileLink("reports/REPORT.md#conclusion"), { path: "reports/REPORT.md" });
  assert.deepEqual(fileLink("/api/remotes/remote-one/proxy/api/sessions/duplicate/raw?path=reports%2Fresult.json"), { host: "remote-one", sessionId: "duplicate", path: "reports/result.json" });
  for (const url of ["javascript:alert(1)", "data:text/html,test", "//external/report.html", "https://example.com/report.html", "#summary", "/api/state", "file://other-host/etc/passwd"]) assert.equal(fileLink(url), null);
  assert.equal(previewResourcePath("figures/a.png", "/report.html"), "/figures/a.png");
  assert.throws(() => previewResourcePath("https://external.example/a.png"));
  const json = '{"id":9007199254740993,"same":1,"same":2,"literal":"a\\\"b","empty":[],"next":{}}';
  const pretty = formatJson(json);
  assert.match(pretty, /9007199254740993/); assert.match(pretty, /"same": 1,[\s\S]*"same": 2/);
  assert.deepEqual(JSON.parse(pretty), JSON.parse(json)); assert.match(pretty, /\n  "id"/);
  assert.throws(() => formatJson("[".repeat(101) + "0" + "]".repeat(101)));
  const { sandboxHTML } = await import("../../web/src/previewSandbox.js");
  const sandbox = sandboxHTML('</script><script>window.attack=true</script>', "test-nonce", false);
  assert.equal(sandbox.includes('</script><script>window.attack'), false, "report source cannot escape the trusted bootstrap literal");
  assert.match(sandbox, /default-src 'none'/); assert.match(sandbox, /form-action 'none'/);
});

test("file preview binary transport scopes authentication and cancels oversized bodies", async (t) => {
  const saved = new Map(["location", "sessionStorage", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  globalThis.location = { search: "?token=preview-fixture-token", href: "http://fixture.invalid/", protocol: "http:" };
  globalThis.sessionStorage = { setItem() {}, getItem() { return null; } };
  const { environment } = await import("../../web/src/api.js?file-preview-limits");
  let cancelled = false;
  globalThis.fetch = async (url, opts) => {
    assert.match(url, /^\/api\/remotes\/other-host\/proxy\/api\/sessions\/a\/preview\//);
    assert.equal(opts.headers["x-devin-token"], "preview-fixture-token");
    return new Response("完整🚀", { headers: { "x-preview-kind": "markdown", "content-type": "text/markdown" } });
  };
  const api = environment("other-host").api, result = await api.file("/api/sessions/a/preview/ticket/file");
  assert.equal(new TextDecoder().decode(result.bytes), "完整🚀"); assert.equal(result.kind, "markdown");
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } }));
  await assert.rejects(api.file("/api/sessions/a/preview/ticket/file", { maxBytes: 8 }), (e) => e.status === 413);
  assert.equal(cancelled, true, "an oversized streaming response is cancelled, not left downloading");
  cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": "9" } });
  await assert.rejects(api.file("/api/sessions/a/preview/ticket/file", { maxBytes: 8 }), (e) => e.status === 413);
  assert.equal(cancelled, true);
});

const MARKDOWN_CORPUS = [
  "First **para** with `code` and [a link](http://x).\n\nSecond para, ~~struck~~ text.\n\nThird paragraph.",
  "# ATX Heading\n\nSetext heading\n==============\n\n## Two\n\npara\n\nSetext two\n----------",
  "- one\n- two\n- three\n\nloose item\n\n- after\n  continued lazy\n\n1. ordered\n2. items\n\n   continuation para\n\n10. done",
  "```js\nconst a = 1;\n\nconst b = 2;\n```\n\npara\n\n~~~~\ntilde fence\n\n~~~ shorter is not a close\n~~~~\n\nend\n\n````\n``` inside\n\n````\n\ntail",
  "para\n\n    indented code\n\n    more indented\n\nnext para",
  "> quote para one\n>\n> quote para two\n\n> new quote\n\nplain text",
  "| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] task\n- [x] done\n\n<https://auto.link>\n\n<!-- comment\n\nspanning blanks -->\n\ntrailing",
  "text with a [ref] link\n\n[ref]: https://ref.example\n\npara[^n]\n\n[^n]: footnote body",
  "para one\r\n\r\npara two\r\n\r\n- item\r\n- item2\r\n\r\n```\r\ncode\r\n```\r\n",
  "<script>\n\nalert(1)\n\n</script>\n\npara\n\n<?pi data\n\n?>\n\nmore",
];

test("streaming markdown blocks split only at safe boundaries and concatenate exactly", () => {
  assert.deepEqual(splitStreamingMarkdown("a\n\nb\n"), ["a\n\n", "b\n"]);
  assert.deepEqual(splitStreamingMarkdown("a\n\nb"), ["a\n\nb"], "an incomplete next line stays attached to the tail");
  assert.deepEqual(splitStreamingMarkdown("a\n\n"), ["a\n\n"], "trailing blanks alone never split");
  assert.deepEqual(splitStreamingMarkdown("- a\n\n- b\n"), ["- a\n\n- b\n"], "consecutive list items stay in one block");
  assert.deepEqual(splitStreamingMarkdown("p\n\n- a\n\npara\n\n- b\n"), ["p\n\n", "- a\n\n", "para\n\n", "- b\n"]);
  assert.deepEqual(splitStreamingMarkdown("> a\n\n> b\n"), ["> a\n\n> b\n"], "a continuing quote is not split");
  assert.deepEqual(splitStreamingMarkdown("> a\n\np\n\n> b\n"), ["> a\n\n", "p\n\n", "> b\n"]);
  assert.deepEqual(splitStreamingMarkdown("[a]: /x\n\npara\n\nmore\n"), ["[a]: /x\n\npara\n\nmore\n"], "reference definitions parse whole-document");
  assert.deepEqual(splitStreamingMarkdown("```\nx\n\ny\n```\n\nz\n"), ["```\nx\n\ny\n```\n\n", "z\n"], "fences containing blanks split only after the close");
  assert.deepEqual(splitStreamingMarkdown("- a\n\n  cont\n\n- b\n"), ["- a\n\n  cont\n\n- b\n"], "indented list continuation never orphans");
  assert.deepEqual(splitStreamingMarkdown("p\n\n    code\n\nnext\n"), ["p\n\n    code\n\n", "next\n"], "indented code never splits, plain text still may");
  for (const doc of MARKDOWN_CORPUS) {
    for (let i = 0; i <= doc.length; i++) {
      const prefix = doc.slice(0, i);
      assert.equal(splitStreamingMarkdown(prefix).join(""), prefix);
    }
  }
});

test("streaming markdown blocks render identically to the whole document, and the element cache is bounded", async (t) => {
  const saved = new Map(["location", "sessionStorage"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  globalThis.location = { search: "", href: "http://fixture.invalid/" };
  globalThis.sessionStorage = { setItem() {}, getItem() { return null; } };
  const { createServer } = await import("vite");
  const { default: React } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { renderMarkdown, clearMarkdownCache } = await vite.ssrLoadModule("/src/components/Markdown.jsx");
    const normalize = (html) => html.replace(/>\s+</g, "><");
    const whole = (text) => normalize(renderToStaticMarkup(renderMarkdown(text, { cache: false })));
    const split = (text) => normalize(renderToStaticMarkup(React.createElement(React.Fragment, null,
      ...splitStreamingMarkdown(text).flatMap((block, index) => index ? ["\n", renderMarkdown(block, { cache: false })] : [renderMarkdown(block, { cache: false })]))));
    for (const doc of MARKDOWN_CORPUS) {
      for (let i = 0; i <= doc.length; i++) {
        const prefix = doc.slice(0, i);
        assert.equal(split(prefix), whole(prefix), `prefix ${i} renders differently: ${JSON.stringify(prefix.slice(Math.max(0, i - 30), i))}`);
      }
    }
    clearMarkdownCache();
    const first = renderMarkdown("cached **text**");
    const e0 = renderMarkdown("entry 0");
    assert.equal(renderMarkdown("cached **text**"), first, "same text returns the identical element");
    for (let i = 1; i < 256; i++) renderMarkdown(`entry ${i}`);
    const overflow = renderMarkdown("overflow");
    assert.equal(renderMarkdown("overflow"), overflow, "the newest entry survives count eviction");
    assert.notEqual(renderMarkdown("cached **text**"), first, "the oldest entry was evicted by count");
    assert.notEqual(renderMarkdown("entry 0"), e0, "an evicted entry recomputes");
    clearMarkdownCache();
    const big = "x".repeat(190000);
    const bigA = renderMarkdown(big + "a");
    renderMarkdown(big + "b");
    assert.equal(renderMarkdown(big + "a"), bigA, "two ~190k entries fit the char budget");
    for (const c of "cdefgh") renderMarkdown(big + c);
    assert.notEqual(renderMarkdown(big + "a"), bigA, "the char budget evicts oldest entries");
    assert.equal(renderMarkdown(big + "h"), renderMarkdown(big + "h"), "newest entry stays under budget eviction");
    const huge = "y".repeat(200001);
    assert.notEqual(renderMarkdown(huge), renderMarkdown(huge), "oversized text renders but is never cached");
    assert.equal(renderMarkdown("after huge"), renderMarkdown("after huge"), "an uncacheable render does not clear the cache");
  } finally {
    await vite.close();
  }
});

const replayEvents = () => {
  const ev = [];
  let t = 0;
  const u = (update) => ev.push({ t: t += 10, update });
  u({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "first question" } });
  for (let i = 0; i < 15; i++) u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `thought ${i} ` } });
  u({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", kind: "execute", status: "pending", rawInput: { command: "ls" } });
  u({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", _meta: { terminal_output: { data: "line one\n" } } });
  u({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", _meta: { terminal_output: { data: "line two\n" }, terminal_exit: { exit_code: 0, signal: null } }, content: [{ type: "content", content: { type: "text", text: "out" } }] });
  u({ sessionUpdate: "tool_call", toolCallId: "todo-1", title: "TaskCreate", kind: "other", status: "completed", rawInput: { subject: "Ship it" }, rawOutput: { content: [{ type: "text", text: "Task #1 created successfully: Ship it" }] } });
  u({ sessionUpdate: "tool_call", toolCallId: "t2", title: "read", kind: "read", status: "completed", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
  u({ sessionUpdate: "plan", entries: [{ content: "step one", status: "in_progress" }, { content: "step two", status: "pending" }] });
  for (let i = 0; i < 40; i++) u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `word ${i} ` } });
  u({ sessionUpdate: "usage_update", used: 100, size: 1000 });
  u({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "tree" }] });
  u({ sessionUpdate: "current_mode_update", currentModeId: "code" });
  u({ sessionUpdate: "config_option_update", configOptions: [{ id: "mode", type: "select", options: [{ value: "code" }] }] });
  u({ sessionUpdate: "session_info_update", _meta: { piAcp: { processNotification: { id: "p1", kind: "success", name: "job", summary: "done", at: 5 } } } });
  u({ sessionUpdate: "session_info_update", _meta: { piAcp: { branchSummary: { id: "b1", summary: "branch recap", status: "completed", at: 6 } } } });
  u({ sessionUpdate: "session_info_update", title: "titled", _meta: { piAcp: { compaction: { id: "c1", status: "running", at: 7 } } } });
  u({ sessionUpdate: "session_info_update", _meta: { piAcp: { compaction: { id: "c1", status: "completed", at: 9, summary: "recap", estimatedTokensAfter: 50 } } } });
  return ev;
};

const normalizeItemKeys = (value) => {
  const ids = new Map();
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === "key" && typeof x === "string") {
          if (!ids.has(x)) ids.set(x, `k${ids.size}`);
          out[k] = ids.get(x);
        } else out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value);
};

test("history fold matches live applyUpdate and never mutates the snapshot", () => {
  const events = replayEvents();
  const echo = [{ t: 2, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "opt" } } },
    { t: 3, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "opt" } } },
    { t: 4, update: { sessionUpdate: "user_message_chunk", content: { type: "image", data: "AAAA", mimeType: "image/png" } } }];
  const reference = (list) => list.reduce((s, e) => applyUpdate(s, e.update, e.t), emptySession());
  const finalize = (s) => ({ ...s, streamRate: null, telemetry: s.telemetry ? { ...s.telemetry, live: null } : null });
  assert.deepEqual(normalizeItemKeys(foldEvents(events)), normalizeItemKeys(finalize(reference(events))),
    "folded replay equals the live reducer path");
  assert.deepEqual(normalizeItemKeys(foldEvents(echo)), normalizeItemKeys(finalize(reference(echo))),
    "echoed text and images fold identically");
  // A mid-stream snapshot plus a delta equals one continuous pass, and the
  // shared snapshot is provably untouched.
  const cut = 17;
  const snapshot = historySnapshot(reference(events.slice(0, cut)));
  const freeze = (v) => {
    if (v && typeof v === "object") { for (const x of Object.values(v)) freeze(x); Object.freeze(v); }
    return v;
  };
  freeze(snapshot.items);
  const delta = foldHistoryDelta(snapshot, events.slice(cut));
  assert.deepEqual(normalizeItemKeys(delta), normalizeItemKeys(historySnapshot(reference(events))),
    "snapshot + delta equals the full fold");
  assert.deepEqual(normalizeItemKeys(foldHistoryDelta(snapshot, events.slice(cut))), normalizeItemKeys(delta),
    "replaying the same snapshot twice is stable");
});

test("streaming tail code stays plain and a streaming agent row keeps its DOM node", async () => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "FileReader", "navigator"].map((k) => [k, dom.window[k]])),
    fetch: globalThis.fetch,
    WebSocket: class { readyState = 1; sent = []; send(raw) { this.sent.push(JSON.parse(raw)); } close() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  let vite, root;
  try {
    const { createRoot } = await import("react-dom/client");
    const { highlightCode } = await import("../../web/src/syntaxHighlight.worker.js");
    const savedGlobals = Object.fromEntries(["Worker", "IntersectionObserver"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const workers = [], observers = [];
    class FakeWorker {
      jobs = [];
      constructor() { workers.push(this); }
      postMessage(job) { this.jobs.push(job); }
      terminate() { this.terminated = true; }
      deliver(job) { this.onmessage({ data: { id: job.id, result: highlightCode(job.code, job.language) } }); }
    }
    class FakeObserver {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {} disconnect() {}
      show() { this.callback([{ isIntersecting: true, boundingClientRect: { width: 500 } }]); }
    }
    globalThis.Worker = FakeWorker; globalThis.IntersectionObserver = FakeObserver;
    try {
      vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
      const { default: CodePre } = await vite.ssrLoadModule("/src/components/CodePre.jsx");
      const { StreamingTailContext } = await vite.ssrLoadModule("/src/markdownBlocks.js");
      const { TranscriptSearch } = await vite.ssrLoadModule("/src/transcriptSearch.js");
      const { default: ChatView } = await vite.ssrLoadModule("/src/components/ChatView.jsx");
      root = createRoot(document.getElementById("root"));
      const render = (element) => act(async () => root.render(element));
      const code = (tail) => render(React.createElement(StreamingTailContext.Provider, { value: tail },
        React.createElement(TranscriptSearch.Provider, { value: { query: "", keys: new Set() } },
          React.createElement(CodePre, null, React.createElement("code", { className: "language-js" }, "const value = 1;\n")))));
      await code(true);
      await act(async () => observers.at(-1).show());
      assert.equal(workers.length, 0, "a still-streaming code block never requests highlighting");
      assert.equal(document.querySelector(".code-card code").textContent, "const value = 1;\n");
      assert.equal(document.querySelector(".code-card code span"), null);
      await code(false);
      await act(async () => observers.at(-1).show());
      assert.equal(workers.length, 1, "committing the block restores normal highlighting");
      // The live row streams, then commits without remounting its DOM.
      let session = { ...emptySession(), historyLoading: false, attached: true, running: true,
        items: [{ key: "u1", kind: "user", text: "go" }, { key: "a1", kind: "agent", text: "part **one**\n\n" }] };
      const noop = () => {};
      const view = () => React.createElement(ChatView, { sessionId: "test", session, onSend: noop, onCancel: noop });
      await render(view());
      const body = document.querySelector(".agent-body");
      assert.ok(body.textContent.includes("part"), "the live row renders");
      session = { ...session, items: [session.items[0], { ...session.items[1], text: "part **one**\n\nmore text\n\n" }] };
      await render(view());
      assert.equal(document.querySelector(".agent-body"), body, "streaming growth reuses the block DOM");
      session = { ...session, running: false, items: [session.items[0], { ...session.items[1], text: "part **one**\n\nmore text done\n\n" }] };
      await render(view());
      assert.equal(document.querySelector(".agent-body"), body, "turn end never remounts the message");
      const second = document.createElement("div");
      document.body.appendChild(second);
      const root2 = createRoot(second);
      await act(async () => root2.render(view()));
      assert.equal(body.innerHTML.replace(/>\s+</g, "><"), second.querySelector(".agent-body").innerHTML.replace(/>\s+</g, "><"),
        "the committed stream equals a fresh full render");
      await act(async () => root2.unmount());
      second.remove();
    } finally {
      for (const [name, descriptor] of Object.entries(savedGlobals)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
    }
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.close();
    for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});

test("previewable gates file links to types the preview backend accepts", async () => {
  const { previewable, fileName } = await import("../../web/src/filePreview.js");
  for (const ok of ["/r/a.html", "/r/b.HTM", "report.json", "img.PNG", "x.css", "y.sh", "z.TSX", "g.go", "s.sql", "n.jsonl", "c.cpp", "h.yaml", "w.rs", "d.pdf", "t.svg", "/report/README", "./license", "NOTICE", "Dockerfile", "docs/guide.markdown"])
    assert.equal(previewable(ok), true, ok);
  for (const no of ["/mnt/x/backend-sdk-77fe3ed.tar.gz", "a.zip", "b.exe", "Makefile", "LICENSE.md.gz", "/dir/", ".hidden", "report."])
    assert.equal(previewable(no), false, no);
  assert.equal(fileName("/a/b/backend-sdk-77fe3ed.tar.gz"), "backend-sdk-77fe3ed.tar.gz");
  assert.equal(fileName("/dir/"), "");
});

test("non-previewable file links download through the session raw route with inline status", async () => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/?token=dl-test-token", pretendToBeVisual: true });
  const clicks = [], fetches = [];
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "navigator", "URL", "Blob", "AbortController"].map((k) => [k, dom.window[k]]).filter(([, v]) => v !== undefined)),
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  let headStatus = 200, headLength = "10";
  globals.fetch = async (url, options = {}) => {
    fetches.push({ url, options });
    if (options.method === "HEAD") return { ok: headStatus < 400, status: headStatus, headers: { get: (name) => name === "content-length" ? headLength : null } };
    return { ok: true, status: 200, headers: { get: () => null }, blob: async () => new globals.Blob(["x"]) };
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  const anchorClicks = [];
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function () { anchorClicks.push({ href: this.getAttribute("href"), download: this.getAttribute("download") }); };
  let vite, root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
    const { MarkdownBody, FilePreviewContext, ImgSessionCtx } = await vite.ssrLoadModule("/src/components/Markdown.jsx");
    root = createRoot(document.getElementById("root"));
    const opened = [];
    const view = (text) => React.createElement(FilePreviewContext.Provider, { value: (link) => opened.push(link) },
      React.createElement(ImgSessionCtx.Provider, { value: "sess-dl" }, React.createElement(MarkdownBody, { text })));
    const render = (text) => act(async () => root.render(view(text)));

    await render("[bundle](/mnt/data3/out/backend-sdk-77fe3ed.tar.gz) and [page](/mnt/data3/out/index.html)");
    const dl = document.querySelector('a[download="backend-sdk-77fe3ed.tar.gz"]');
    assert.ok(dl, "archive link renders a download anchor");
    assert.match(dl.getAttribute("href"), /^\/api\/sessions\/sess-dl\/raw\?path=%2Fmnt%2Fdata3%2Fout%2Fbackend-sdk-77fe3ed\.tar\.gz&token=dl-test-token$/);
    const page = [...document.querySelectorAll("a")].find((a) => a.textContent === "page");
    assert.equal(page.getAttribute("download"), null);
    assert.equal(page.dataset.filePreview, "true", "previewable links keep the preview behavior");
    await act(async () => page.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0], { path: "/mnt/data3/out/index.html" });

    headStatus = 404;
    await act(async () => dl.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(anchorClicks.length, 0, "a missing file never clicks a download anchor");
    assert.equal(document.querySelector(".md-download-status[role='alert']").textContent, "文件不存在或已被移动");

    headStatus = 200;
    await act(async () => dl.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(anchorClicks.length, 1);
    assert.equal(anchorClicks[0].download, "backend-sdk-77fe3ed.tar.gz");
    assert.match(anchorClicks[0].href, /^\/api\/sessions\/sess-dl\/raw\?path=/);

    globalThis.window.DevinNative = { saveBlob() {} };
    headLength = String(50 * 1024 * 1024);
    fetches.length = 0;
    await act(async () => dl.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(anchorClicks.length, 1, "oversized in-app downloads are refused before fetching");
    assert.ok(fetches.every((call) => call.options.method === "HEAD"), "no GET after the size refusal");
    assert.equal(document.querySelector(".md-download-status[role='alert']").textContent, "文件过大，App 内最多下载 40 MiB，请在浏览器中下载");
    delete globalThis.window.DevinNative;
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
    dom.window.close();
    for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});

test("file preview downloads originals, renews expired tickets and opens external links in a tab", async () => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const fetches = [];
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "navigator", "URL", "Blob", "AbortController", "crypto", "TextDecoder"].map((k) => [k, dom.window[k]]).filter(([, v]) => v !== undefined)),
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  let metaCount = 0, failReads = 0, openStatus = 200, fileKind = "markdown", fileText = "# report\n\n[sub](sub.bin) and [ext](https://example.com/x)\n";
  globals.fetch = async (url, options = {}) => {
    fetches.push({ url, options });
    if (options.method === "HEAD") return { ok: true, status: 200, headers: { get: (name) => name === "content-length" ? "10" : null } };
    if (url.includes("/preview") && !url.includes("/file")) {
      metaCount++;
      if (openStatus !== 200) return { ok: false, status: openStatus, json: async () => ({ error: "暂不支持此文件类型的预览" }) };
      return { ok: true, status: 200, json: async () => ({ ticket: `tk${metaCount}`, kind: fileKind, path: "/r/report.md", name: "report.md", size: 5 }) };
    }
    if (url.includes("/file")) {
      if (failReads-- > 0) return { ok: false, status: 410, json: async () => ({ error: "预览已过期，请刷新重新打开" }) };
      const requested = new URL(url, "http://x").searchParams.get("path");
      const text = requested === "/sub.bin" ? "binary-ish" : fileText;
      return new Response(text, { headers: { "x-preview-kind": requested ? "text" : fileKind, "content-type": "text/plain" } });
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  const anchorClicks = [];
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function () { anchorClicks.push({ href: this.getAttribute("href"), download: this.getAttribute("download") }); };
  let vite, root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
    const { default: FilePreview } = await vite.ssrLoadModule("/src/components/FilePreview.jsx");
    const { environment } = await vite.ssrLoadModule("/src/api.js");
    root = createRoot(document.getElementById("root"));
    const show = (source) => act(async () => root.render(React.createElement(FilePreview, { source, onClose() {} })));

    // 415 at open: error plus a download button that still reaches the raw route.
    openStatus = 415;
    await show({ environment: environment(""), sessionId: "p1", path: "/r/archive.tar.gz" });
    assert.match(document.querySelector(".preview-error").textContent, /暂不支持此文件类型/);
    const dlButton = document.querySelector(".preview-download");
    assert.ok(dlButton, "unsupported types offer a download instead of a dead end");
    await act(async () => dlButton.click());
    assert.equal(anchorClicks.at(-1).download, "archive.tar.gz");
    assert.match(anchorClicks.at(-1).href, /\/api\/sessions\/p1\/raw\?path=%2Fr%2Farchive\.tar\.gz/);

    // Navigated sub-path: header download resolves against the report directory.
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root"));
    openStatus = 200; fileKind = "markdown"; metaCount = 0;
    const baseFetch = fetches.length;
    await show({ environment: environment(""), sessionId: "p1", path: "/r/report.md" });
    const sub = [...document.querySelectorAll(".file-preview-markdown a")].find((a) => a.textContent === "sub");
    await act(async () => sub.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.ok(fetches.slice(baseFetch).some((call) => String(call.url).includes("path=%2Fsub.bin")), "navigating reads the report-relative resource");
    fetches.length = 0; anchorClicks.length = 0;
    await act(async () => document.querySelector('[aria-label="下载原文件"]').click());
    assert.ok(fetches.some((call) => call.options.method === "HEAD" && String(call.url).includes("path=%2Fr%2Fsub.bin")), "header download targets the navigated file");
    assert.equal(anchorClicks.at(-1).download, "sub.bin");

    // External links open in a new tab without preview navigation.
    const ext = [...document.querySelectorAll(".file-preview-markdown a")].find((a) => a.textContent === "ext") ||
      (await act(async () => root.unmount()), root = createRoot(document.getElementById("root")), await show({ environment: environment(""), sessionId: "p1", path: "/r/report.md" }),
       [...document.querySelectorAll(".file-preview-markdown a")].find((a) => a.textContent === "ext"));
    fetches.length = 0;
    assert.equal(ext.getAttribute("target"), "_blank");
    assert.equal(ext.getAttribute("rel"), "noopener noreferrer");
    await act(async () => ext.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.ok(!fetches.some((call) => String(call.url).includes("example.com")), "external links are not fetched by the preview");

    // An expired ticket renews itself once, keeping the displayed path.
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root"));
    metaCount = 0; failReads = 1;
    await show({ environment: environment(""), sessionId: "p1", path: "/r/report.md" });
    assert.equal(metaCount, 2, "the expired ticket re-opens once");
    assert.ok(document.querySelector(".file-preview-markdown"), "the renewed read renders content");
    failReads = 2; metaCount = 0;
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root"));
    await show({ environment: environment(""), sessionId: "p1", path: "/r/report.md" });
    assert.equal(metaCount, 2, "renewal happens once, not in a loop");
    assert.ok(document.querySelector(".preview-error"), "a second failure shows the error");
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
    dom.window.close();
    for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});

test("process panel polls quietly, follows the log tail, confirms stops and arrow-key selects", async () => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "HTMLElement", "KeyboardEvent", "navigator"].map((k) => [k, dom.window[k]]).filter(([, v]) => v !== undefined)),
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  let holdList = null, posts = 0;
  globals.fetch = async (url, options = {}) => {
    if (options.method === "POST") { posts++; return { ok: true, json: async () => ({ process: { id: "p1", status: "killed" } }) }; }
    if (url.endsWith("/output")) return { ok: true, json: async () => ({ id: url.includes("p2") ? "p2" : "p1", text: "line\n".repeat(30), truncated: false }) };
    if (holdList) return await new Promise((resolve) => { holdList = () => resolve(listResponse()); });
    return listResponse();
    function listResponse() {
      return { ok: true, json: async () => ({ available: true, attached: true, limit: 8, processes: [
        { id: "p1", name: "one", command: "sleep 9", cwd: "/tmp", pid: 11, status: "running", startTime: Date.now() - 5000 },
        { id: "p2", name: "two", command: "echo done", cwd: "/tmp", pid: 12, status: "exited", exitCode: 0, startTime: Date.now() - 65000, endTime: Date.now() - 5000 },
      ] }) };
    }
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  let vite, root;
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
    const { default: Panel } = await vite.ssrLoadModule("/src/components/ProcessesPanel.jsx");
    const { EnvironmentContext } = await vite.ssrLoadModule("/src/environmentContext.js");
    const { environment } = await vite.ssrLoadModule("/src/api.js");
    root = createRoot(document.getElementById("root"));
    const render = (summary) => act(async () => root.render(React.createElement(EnvironmentContext.Provider, { value: environment("") },
      React.createElement(Panel, { sessionId: "s", title: "t", environmentName: "local", wsUp: true, summary, onClose() {} }))));
    await render("v1");
    const refresh = () => document.querySelector('[aria-label="刷新任务列表"]');
    assert.equal(refresh().disabled, false, "idle refresh stays enabled");
    assert.ok(document.querySelector(".processes-dot.run"), "running row shows the accent dot");
    assert.ok(document.querySelector(".processes-dot.ok"), "clean exit shows the green dot");
    assert.match(document.querySelector(".processes-row.selected small").textContent, /运行中 · 0:0/, "running rows show elapsed time");
    assert.match(document.querySelector(".processes-detail-head small").textContent, /PID 11 · 运行中 · \d/, "detail head shows start clock and duration");

    // A background read must not disable the refresh button.
    holdList = true;
    await act(async () => root.render(React.createElement(EnvironmentContext.Provider, { value: environment("") },
      React.createElement(Panel, { sessionId: "s", title: "t", environmentName: "local", wsUp: true, summary: "v2", onClose() {} }))));
    await act(async () => {});
    assert.equal(refresh().disabled, false, "the summary-triggered background read stays quiet");
    await act(async () => { holdList(); holdList = null; });

    // Arrow keys move the selection with roving focus.
    const list = document.querySelector(".processes-list");
    await act(async () => list.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    assert.equal(document.querySelector(".processes-row.selected").dataset.processId, "p2");
    assert.equal(document.activeElement.dataset.processId, "p2", "roving focus follows the selection");
    await act(async () => list.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    assert.equal(document.querySelector(".processes-row.selected").dataset.processId, "p1");

    // Scrolling away from the tail pauses following and offers a jump back.
    const pre = document.querySelector(".processes-output");
    for (const [key, value] of [["scrollHeight", 2000], ["clientHeight", 100]]) Object.defineProperty(pre, key, { configurable: true, value });
    pre.scrollTop = 100;
    await act(async () => pre.dispatchEvent(new dom.window.Event("scroll")));
    const jump = document.querySelector(".processes-jump");
    assert.ok(jump, "leaving the tail shows the jump-to-latest button");
    await act(async () => jump.click());
    assert.equal(document.querySelector(".processes-jump"), null);
    assert.equal(pre.scrollTop, 2000, "jumping re-anchors the log at the tail");

    // Stopping requires the confirmation dialog.
    await act(async () => document.querySelector(".processes-detail-head .btn").click());
    const dialog = document.querySelector(".confirm-dialog");
    assert.ok(dialog, "stop opens the confirmation dialog");
    assert.match(dialog.textContent, /one/); assert.match(dialog.textContent, /sleep 9/); assert.match(dialog.textContent, /不会自动重试/);
    await act(async () => [...dialog.querySelectorAll(".modal-actions button")].at(-1).click());
    assert.equal(posts, 1);
    assert.equal(document.querySelector(".confirm-dialog"), null);
  } finally {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.close();
    for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});

test("quick-chat hotkey format and match", () => {
  const ev = (o) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
  assert.equal(formatHotkey(ev({ code: "Space", ctrlKey: true, shiftKey: true })), "Ctrl+Shift+Space");
  assert.equal(formatHotkey(ev({ code: "KeyK", metaKey: true, shiftKey: true })), "Shift+Meta+K");
  assert.equal(formatHotkey(ev({ code: "Digit3", ctrlKey: true, altKey: true })), "Ctrl+Alt+3");
  assert.equal(formatHotkey(ev({ code: "Backquote", ctrlKey: true })), "Ctrl+`");
  assert.equal(formatHotkey(ev({ code: "Backslash", ctrlKey: true, shiftKey: true })), "Ctrl+Shift+\\");
  assert.equal(formatHotkey(ev({ code: "F5", altKey: true })), "Alt+F5");
  assert.equal(formatHotkey(ev({ code: "KeyK", ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })), "Ctrl+Alt+Shift+Meta+K");
  assert.equal(formatHotkey(ev({ code: "ControlLeft", ctrlKey: true })), null, "modifier-only press");
  assert.equal(formatHotkey(ev({ code: "IntlBackslash" })), null, "unknown code");
  assert.ok(matchHotkey(ev({ code: "Space", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+Space"));
  assert.ok(!matchHotkey(ev({ code: "Space", shiftKey: true }), "Ctrl+Shift+Space"));
  assert.ok(!matchHotkey(ev({ code: "Space", ctrlKey: true, shiftKey: true, altKey: true }), "Ctrl+Shift+Space"));
  assert.ok(!matchHotkey(ev({ code: "Space", ctrlKey: true, shiftKey: true }), null));
});

const quickDom = async ({ scratchCap = true, scratchEntries = { value: 0 } } = {}) => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const { default: React, act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const calls = { posts: [], finish: [] };
  const sockets = [];
  const sessionsList = [
    { sessionId: "qs-arch", cwd: "/tmp/qa", scratch: true, state: "free", updatedAt: "2025-01-01T00:00:00Z" },
    { sessionId: "n1", cwd: "/work", state: "free", updatedAt: "2025-01-01T01:00:00Z" },
  ];
  const respond = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
  const globals = {
    ...Object.fromEntries(["window", "document", "location", "history", "sessionStorage", "localStorage", "Event", "MouseEvent", "KeyboardEvent", "HTMLElement", "FileReader", "navigator"].map((k) => [k, dom.window[k]])),
    fetch: async (url, options = {}) => {
      const u = String(url);
      if (u === "/api/agents") return respond({ agents: [{ id: "pi", name: "Pi", caps: {} }] });
      if (u === "/api/state") return respond({ workspaces: ["/tmp"], home: "/tmp", sessions: {}, ...(scratchCap ? { scratch: true } : {}) });
      if (u === "/api/remotes") return respond({ hosts: [], keyConfigured: false });
      if (u === "/api/sessions" && options.method === "POST") {
        const body = JSON.parse(options.body);
        calls.posts.push(body);
        const sid = `qs${calls.posts.length}`;
        sessionsList.unshift({ sessionId: sid, cwd: `/tmp/${sid}`, scratch: true, state: "held", updatedAt: "2025-02-01T00:00:00Z" });
        return respond({ sessionId: sid, modes: null, configOptions: [], cwd: `/tmp/${sid}`, scratch: true });
      }
      if (u === "/api/sessions") return respond({ sessions: [...sessionsList] });
      if (/^\/api\/sessions\/[^/]+\/scratch$/.test(u)) return respond({ dir: "/tmp/qs", exists: true, entries: scratchEntries.value, bytes: scratchEntries.value * 10, truncated: false });
      if (/^\/api\/sessions\/[^/]+\/scratch\/finish$/.test(u)) { calls.finish.push(JSON.parse(options.body)); return respond({ ok: true, archived: true, removed: true }); }
      return respond({});
    },
    WebSocket: class {
      readyState = 1; sent = [];
      constructor() { sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
      send(raw) { this.sent.push(JSON.parse(raw)); }
      close() { this.readyState = 3; }
    },
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  let vite, root;
  const cleanup = async () => {
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    dom.window.close();
    for (const [k, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  };
  try {
    const { createRoot } = await import("react-dom/client");
    vite = await createServer({ root: new URL("../../web/", import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: "custom" });
    root = createRoot(document.getElementById("root"));
    const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
    await act(async () => root.render(React.createElement(App)));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  } catch (e) {
    await cleanup();
    throw e;
  }
  const pressQuick = () => act(async () => {
    window.dispatchEvent(new window.KeyboardEvent("keydown", { code: "Space", ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
  });
  return { dom, act, calls, sockets, sessionsList, pressQuick, cleanup, React, ssrLoad: (path) => vite.ssrLoadModule(path) };
};

test("quick chat: hotkey creates one scratch session, toggles, stays subscribed, detaches, finishes", async () => {
  const scratchEntries = { value: 0 };
  const { act, calls, sockets, pressQuick, cleanup } = await quickDom({ scratchEntries });
  try {
    // Sidebar groups every scratch session into one trailing 临时对话 group with no add button.
    const group = document.querySelector(".ws-group.scratch");
    assert.ok(group, "scratch sessions form a synthetic group");
    assert.equal(group.querySelector(".ws-add"), null, "no workspace add button");
    assert.match(group.textContent, /临时对话/);
    assert.equal([...document.querySelectorAll(".ws-group")].at(-1), group, "scratch group renders last");

    // First hotkey press creates exactly one scratch session for the default agent.
    await pressQuick();
    assert.equal(calls.posts.length, 1);
    assert.deepEqual(calls.posts[0], { scratch: true, agent: "pi" });
    assert.ok(document.querySelector(".quick-panel.open"), "panel opens");
    const dialogEl = document.querySelector(".quick-panel");
    assert.equal(dialogEl.getAttribute("role"), "dialog");
    assert.equal(dialogEl.getAttribute("aria-modal"), "true");
    const backEl = dialogEl.parentElement;
    assert.ok(backEl.matches(".modal-back.quick-back.open"), "dialog is portaled into a modal backdrop");
    assert.equal(backEl.parentElement, document.body, "backdrop mounts at document.body");
    const ta = dialogEl.querySelector("textarea.input-ta");
    assert.ok(ta, "composer is rendered");
    assert.equal(document.activeElement, ta, "composer autofocuses on open");
    // Second press hides it — no new session, still subscribed.
    await pressQuick();
    assert.equal(calls.posts.length, 1, "second press only hides");
    assert.ok(document.querySelector(".quick-panel"), "panel stays mounted while hidden");
    assert.ok(!document.querySelector(".quick-panel.open"), "panel hidden");
    assert.ok(!document.querySelector(".quick-back.open"), "hidden backdrop loses .open");
    assert.ok(document.querySelector(".quick-back").hasAttribute("inert"), "hidden backdrop is inert");
    const sent = sockets.flatMap((s) => s.sent);
    assert.ok(sent.some((m) => m.type === "subscribe" && m.sessionId === "qs1"), "quick session subscribed");
    assert.ok(!sent.some((m) => m.type === "unsubscribe" && m.sessionId === "qs1"), "hidden panel keeps its subscription");

    // Opening the quick session in a pane detaches it from the panel.
    await act(async () => document.querySelector(".ws-group.scratch .ws-focus").click());
    const row = [...document.querySelectorAll(".session-row")].find((el) => el.title === "qs1");
    assert.ok(row, "created scratch session appears in the group");
    await act(async () => row.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    await act(async () => [...document.querySelectorAll(".ctx-item")].find((el) => el.textContent === "打开会话").click());
    assert.equal(document.querySelector(".quick-panel"), null, "opening in a pane detaches the quick session");
    assert.match(document.querySelector(".chat-head .t").textContent, /qs1/);

    // A scratch row click opens it in the panel (replacing sessionId without finishing anything).
    await act(async () => [...document.querySelectorAll(".session-row")].find((el) => el.title === "qs-arch").click());
    assert.ok(document.querySelector(".quick-panel.open"), "scratch row opens in the quick panel");
    assert.equal(calls.finish.length, 0, "replacing the quick session never finishes the previous one");

    // Empty scratch dir → finish deletes without asking.
    scratchEntries.value = 0;
    await act(async () => document.querySelector('.quick-head [aria-label="结束"]').click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    assert.deepEqual(calls.finish, [{ files: "delete" }]);
    assert.equal(document.querySelector(".confirm-dialog"), null, "empty dir asks nothing");
    assert.equal(document.querySelector(".quick-panel"), null, "panel detaches after finish");

    // New quick chat → non-empty dir asks; 取消 sends nothing; 删除文件 finishes.
    await pressQuick();
    assert.equal(calls.posts.length, 2);
    scratchEntries.value = 3;
    await act(async () => document.querySelector('.quick-head [aria-label="结束"]').click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const dialog = document.querySelector(".confirm-dialog");
    assert.ok(dialog, "non-empty dir asks keep/delete/cancel");
    assert.match(dialog.textContent, /中有 3 个文件/);
    await act(async () => [...dialog.querySelectorAll(".modal-actions button")].find((b) => b.textContent === "取消").click());
    assert.equal(calls.finish.length, 1, "取消 sends nothing");
    assert.equal(document.querySelector(".confirm-dialog"), null);
    assert.ok(document.querySelector(".quick-panel"), "panel stays after cancel");
    await act(async () => document.querySelector('.quick-head [aria-label="结束"]').click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await act(async () => [...document.querySelectorAll(".confirm-dialog .modal-actions button")].find((b) => b.textContent === "删除文件").click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    assert.deepEqual(calls.finish.at(-1), { files: "delete" });
    assert.equal(document.querySelector(".quick-panel"), null);
  } finally {
    await cleanup();
  }
});

test("quick chat without backend capability warns and never posts", async () => {
  const { calls, pressQuick, cleanup } = await quickDom({ scratchCap: false });
  try {
    await pressQuick();
    assert.equal(calls.posts.length, 0, "no creation request on an old backend");
    assert.equal(document.querySelector(".quick-panel"), null);
    const warn = document.querySelector(".toast.warn");
    assert.ok(warn, "warning notice shown");
    assert.match(warn.textContent, /重启本机后端/);
  } finally {
    await cleanup();
  }
});

test("quick chat modal: restores and persists size via DialogResize", async () => {
  const { act, pressQuick, cleanup } = await quickDom();
  try {
    localStorage.setItem("dw.quick.size", '{"w":700,"h":500}');
    await pressQuick();
    const panel = document.querySelector(".quick-panel");
    assert.equal(panel.style.width, "700px");
    assert.equal(panel.style.height, "500px");
    panel.getBoundingClientRect = () => ({ width: 700, height: 500, top: 0, left: 0, right: 700, bottom: 500 });
    await act(async () => panel.querySelector(".dialog-resize")
      .dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    assert.equal(panel.style.width, "720px");
    assert.equal(localStorage.getItem("dw.quick.size"), '{"w":720,"h":500}');
    // Corrupt storage on a fresh mount produces no inline size and no throw.
    await act(async () => document.querySelector('.quick-head [aria-label="结束"]').click());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    localStorage.setItem("dw.quick.size", "{nope");
    await pressQuick();
    const panel2 = document.querySelector(".quick-panel");
    assert.equal(panel2.style.width, "", "bad JSON → no inline size");
    assert.equal(panel2.style.height, "");
  } finally {
    await cleanup();
  }
});

test("quick chat modal: Escape hides, prevented Escape does not", async () => {
  const { act, pressQuick, cleanup } = await quickDom();
  try {
    await pressQuick();
    const area = document.querySelector(".quick-panel textarea");
    assert.ok(area, "quick composer textarea exists");
    await act(async () => area.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.ok(!document.querySelector(".quick-back.open"), "Escape hides the dialog");
    await pressQuick();
    const prevent = (e) => e.preventDefault();
    document.addEventListener("keydown", prevent, true);
    try {
      await act(async () => area.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      assert.ok(document.querySelector(".quick-back.open"), "an already-prevented Escape does not hide");
    } finally {
      document.removeEventListener("keydown", prevent, true);
    }
  } finally {
    await cleanup();
  }
});

test("quick chat modal: backdrop click hides unless pinned", async () => {
  const { act, pressQuick, cleanup } = await quickDom();
  try {
    await pressQuick();
    await act(async () => document.querySelector(".quick-back")
      .dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true })));
    assert.ok(!document.querySelector(".quick-back.open"), "outside pointerdown hides unpinned");
    await pressQuick();
    // The layers swallow the first click within 500ms of an outside dismissal.
    await act(async () => { await new Promise((r) => setTimeout(r, 550)); });
    await act(async () => document.querySelector('.quick-head [aria-label="固定快速对话"]').click());
    await act(async () => document.querySelector(".quick-back")
      .dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true })));
    assert.ok(document.querySelector(".quick-back.open"), "pinned keeps the dialog open on outside clicks");
  } finally {
    await cleanup();
  }
});

test("quick chat modal: Ctrl+F opens search only inside the dialog", async () => {
  const { act, pressQuick, cleanup } = await quickDom();
  try {
    // First scratch session goes into a normal pane.
    await pressQuick();
    await act(async () => document.querySelector(".ws-group.scratch .ws-focus").click());
    const row = [...document.querySelectorAll(".session-row")].find((el) => el.title === "qs1");
    assert.ok(row, "created scratch session appears in the group");
    await act(async () => row.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    await act(async () => [...document.querySelectorAll(".ctx-item")].find((el) => el.textContent === "打开会话").click());
    assert.equal(document.querySelector(".quick-panel"), null, "pane open detaches the quick session");
    // A second quick chat opens the modal over the pane.
    await pressQuick();
    assert.ok(document.querySelector(".quick-back.open"));
    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true, bubbles: true })));
    assert.ok(document.querySelector(".quick-panel .ts-search"), "search opens inside the dialog");
    const mainChat = [...document.querySelectorAll(".chat")].find((el) => !el.closest(".quick-panel"));
    assert.ok(mainChat, "a main pane chat exists");
    assert.equal(mainChat.querySelector(".ts-search"), null, "main pane search stays closed under the modal");
  } finally {
    await cleanup();
  }
});

test("readDialogSize tolerates missing and corrupt storage", async () => {
  const { ssrLoad, cleanup } = await quickDom();
  try {
    const { readDialogSize } = await ssrLoad("/src/components/DialogResize.jsx");
    assert.equal(readDialogSize("dw.test.size"), null);
    localStorage.setItem("dw.test.size", "{bad");
    assert.equal(readDialogSize("dw.test.size"), null);
    localStorage.setItem("dw.test.size", '{"w":-3,"h":100}');
    assert.equal(readDialogSize("dw.test.size"), null);
    localStorage.setItem("dw.test.size", '{"w":700,"h":500}');
    assert.deepEqual(readDialogSize("dw.test.size"), { width: 700, height: 500 });
  } finally {
    await cleanup();
  }
});
