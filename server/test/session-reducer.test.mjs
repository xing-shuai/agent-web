import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySession, applyUpdate, foldEvents } from "../../web/src/sessionReducer.js";

const T = 1000;

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
