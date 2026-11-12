/**
 * Adapted from pi-open-tui 0.4.3 extensions/open-tui/telemetry.ts.
 * https://github.com/OldSuns/pi-open-tui
 * Tracker semantics retained; adds clock-relative live snapshots and an ACP fallback.
 * Source: cc-my-pi-xs/extensions/statusline/model-info/telemetry.ts (local adaptation).
 *
 * MIT License
 *
 * Copyright (c) 2026 pi-open-tui contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
function finiteOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
const STALL_THRESHOLD_MS = 1e3;
const LIVE_TPS_WINDOW_MS = 2e3;
const CJK_CHARS = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
function isAssistantMessage(message) {
  return message.role === "assistant";
}
function estimateDeltaTokens(delta) {
  const cjk = delta.match(CJK_CHARS)?.length ?? 0;
  return cjk + (delta.length - cjk) / 4;
}
function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
class TurnTelemetryTracker {
  now;
  turn;
  agentStartMs = null;
  agentTurns = [];
  lastLiveTps = null;
  constructor(now = () => performance.now()) {
    this.now = now;
  }
  /**
   * Estimated output rate of the streaming message over the trailing window.
   * Between messages of a run (tools, TTFT) the last rate is kept as `stale`.
   */
  getLiveTps() {
    const tps = this.windowTps();
    if (tps !== null) return { tps, stale: false };
    return this.lastLiveTps === null ? null : { tps: this.lastLiveTps, stale: true };
  }
  windowTps() {
    const samples = this.turn?.currentMessage?.samples;
    if (!samples || samples.length < 2) return null;
    const first = samples[0];
    const now = this.now();
    if (now - samples.at(-1).ms >= LIVE_TPS_WINDOW_MS) return 0;
    const elapsedMs = now - first.ms;
    if (elapsedMs <= 0) return null;
    return round((samples.at(-1).tokens - first.tokens) / (elapsedMs / 1e3), 1);
  }
  // Clock-relative data lets browsers animate stalls without sharing clocks.
  liveSnapshot() {
    const live = this.getLiveTps();
    if (!live || live.stale) return live;
    const samples = this.turn.currentMessage.samples;
    const now = this.now();
    return { ...live, tokens: samples.at(-1).tokens - samples[0].tokens,
      elapsedMs: now - samples[0].ms, idleMs: now - samples.at(-1).ms };
  }
  handle(event) {
    switch (event.type) {
      case "agent_start":
        if (this.agentStartMs === null) {
          this.agentStartMs = this.now();
          this.agentTurns = [];
          this.lastLiveTps = null;
        }
        return;
      case "agent_settled":
        return this.endAgent();
      case "turn_start":
        this.startTurn();
        return;
      case "message_start":
        this.startMessage(event.message);
        return;
      case "message_update":
        this.updateMessage(event);
        return;
      case "message_end":
        this.endMessage(event.message);
        return;
      case "tool_execution_start":
        return;
      case "turn_end":
        return this.endTurnAndCollect();
    }
  }
  startTurn() {
    this.turn = {
      startMs: this.now(),
      firstTokenMs: null,
      currentMessage: null,
      messages: [],
      generationMs: 0,
      stallMs: 0,
      stallCount: 0
    };
  }
  startMessage(message) {
    if (!this.turn || !isAssistantMessage(message)) return;
    const now = this.now();
    this.turn.currentMessage = {
      lastUpdateMs: now,
      firstOutputMs: null,
      inStall: false,
      estimatedTokens: 0,
      samples: []
    };
  }
  updateMessage(event) {
    const turn = this.turn;
    const current = turn?.currentMessage;
    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type !== "text_delta" && streamEvent.type !== "thinking_delta" && streamEvent.type !== "toolcall_delta") return;
    if (streamEvent.delta.length === 0) return;
    const message = event.message;
    if (!turn || !current || !isAssistantMessage(message)) return;
    const now = this.now();
    current.estimatedTokens += estimateDeltaTokens(streamEvent.delta);
    const samples = current.samples;
    samples.push({ ms: now, tokens: current.estimatedTokens });
    while (samples.length > 2 && samples[1].ms <= now - LIVE_TPS_WINDOW_MS) samples.shift();
    if (current.firstOutputMs === null) {
      current.firstOutputMs = now;
      turn.firstTokenMs ??= now;
      current.lastUpdateMs = now;
      return;
    }
    const gap = now - current.lastUpdateMs;
    if (gap >= STALL_THRESHOLD_MS) {
      if (!current.inStall) turn.stallCount++;
      current.inStall = true;
      turn.stallMs += gap;
    } else {
      current.inStall = false;
    }
    current.lastUpdateMs = now;
  }
  endMessage(message) {
    const turn = this.turn;
    if (!turn || !isAssistantMessage(message)) return;
    const current = turn.currentMessage;
    if (current) {
      const endMs = this.now();
      turn.generationMs = endMs - turn.startMs;
      if (current.firstOutputMs === null && finiteOrZero(message.usage?.output) > 0) {
        turn.firstTokenMs ??= endMs;
      }
      this.lastLiveTps = this.windowTps() ?? this.lastLiveTps;
      turn.currentMessage = null;
    }
    turn.messages.push(message);
  }
  endTurnAndCollect() {
    const telemetry = this.endTurn();
    if (telemetry && this.agentStartMs !== null) this.agentTurns.push(telemetry);
    return telemetry;
  }
  endTurn() {
    const turn = this.turn;
    this.turn = void 0;
    if (!turn || turn.firstTokenMs === null || turn.messages.length === 0) return;
    const endMs = this.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let totalTokens = 0;
    let costUsd = 0;
    for (const message of turn.messages) {
      inputTokens += finiteOrZero(message.usage?.input) + finiteOrZero(message.usage?.cacheWrite);
      outputTokens += finiteOrZero(message.usage?.output);
      cacheReadTokens += finiteOrZero(message.usage?.cacheRead);
      totalTokens += finiteOrZero(message.usage?.totalTokens);
      costUsd += finiteOrZero(message.usage?.cost?.total);
    }
    const measurementMs = outputTokens > 0 && turn.generationMs > 0 ? turn.generationMs : null;
    const tps = measurementMs === null ? null : round(outputTokens / (measurementMs / 1e3), 1);
    const validCost = Number.isFinite(costUsd) && costUsd > 0;
    const validTokens = Number.isFinite(totalTokens) && totalTokens > 0;
    return {
      tps,
      ttftMs: turn.firstTokenMs - turn.startMs,
      totalMs: endMs - turn.startMs,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      stallMs: turn.stallMs,
      stallCount: turn.stallCount,
      rateUsdPerMTokens: validCost && validTokens ? round(costUsd / (totalTokens / 1e6), 2) : null,
      generationMs: turn.generationMs,
      totalTokens,
      costUsd: validCost ? costUsd : 0,
      measurementMs
    };
  }
  endAgent() {
    const startMs = this.agentStartMs;
    const turns = this.agentTurns;
    this.agentStartMs = null;
    this.agentTurns = [];
    this.lastLiveTps = null;
    if (startMs === null || turns.length === 0) return;
    const outputTokens = turns.reduce((sum, turn) => sum + turn.outputTokens, 0);
    const inputTokens = turns.reduce((sum, turn) => sum + turn.inputTokens, 0);
    const cacheReadTokens = turns.reduce((sum, turn) => sum + turn.cacheReadTokens, 0);
    const totalTokens = turns.reduce((sum, turn) => sum + turn.totalTokens, 0);
    const costUsd = turns.reduce((sum, turn) => sum + turn.costUsd, 0);
    const stallMs = turns.reduce((sum, turn) => sum + turn.stallMs, 0);
    const stallCount = turns.reduce((sum, turn) => sum + turn.stallCount, 0);
    const generationMs = turns.reduce((sum, turn) => sum + turn.generationMs, 0);
    const measurementMs = outputTokens > 0 && generationMs > 0 ? generationMs : null;
    const tps = measurementMs === null ? null : round(outputTokens / (measurementMs / 1e3), 1);
    const validRate = costUsd > 0 && totalTokens > 0;
    return {
      tps,
      ttftMs: turns[0].ttftMs,
      totalMs: this.now() - startMs,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      stallMs,
      stallCount,
      rateUsdPerMTokens: validRate ? round(costUsd / (totalTokens / 1e6), 2) : null,
      generationMs,
      totalTokens,
      costUsd,
      measurementMs
    };
  }
}
export {
  TurnTelemetryTracker,
  estimateDeltaTokens
};

/** Recompute the same trailing-window estimate as open-tui between updates. */
export function liveTpsAt(live, ageMs = 0) {
  if (!live) return null;
  if (live.stale) return live;
  const age = Math.max(0, ageMs);
  if (live.idleMs + age >= LIVE_TPS_WINDOW_MS) return { tps: 0, stale: false };
  const elapsed = live.elapsedMs + age;
  return elapsed > 0 ? { tps: round(live.tokens / (elapsed / 1000), 1), stale: false } : null;
}

/** Older backends/Devin lack SDK lifecycle/usage. Estimate from actual ACP
 * deltas, not React polling of cumulative transcript text or tool results. */
export function advanceStreamRate(previous, update, ms) {
  if (update.sessionUpdate === "user_message_chunk") return null;
  let delta = "", input = previous?.input, toolId = previous?.toolId;
  if (["agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate)) {
    delta = update.content?.type === "text" ? update.content.text || "" : "";
  } else if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
    if (update.status === "in_progress" && previous?.samples?.length) {
      const live = liveTpsAt(previous.live, Math.max(0, ms - previous.at));
      return { ...previous, samples: [], total: 0, live: live ? { ...live, stale: true } : null, at: ms };
    }
    if (update.status !== "pending" || !update.rawInput) return previous;
    const next = typeof update.rawInput.partialArgs === "string" ? update.rawInput.partialArgs : JSON.stringify(update.rawInput);
    const old = toolId === update.toolCallId ? input || "" : "";
    let common = 0;
    while (common < old.length && common < next.length && old[common] === next[common]) common++;
    delta = next.slice(common);
    input = next; toolId = update.toolCallId;
  }
  if (!delta) return previous;
  const total = (previous?.total || 0) + estimateDeltaTokens(delta);
  const samples = [...(previous?.samples || []), { ms, tokens: total }];
  while (samples.length > 2 && samples[1].ms <= ms - LIVE_TPS_WINDOW_MS) samples.shift();
  const live = samples.length < 2 ? (previous?.live?.stale ? previous.live : null) : {
    tokens: total - samples[0].tokens, elapsedMs: ms - samples[0].ms, idleMs: 0, stale: false,
  };
  return { samples, total, live, at: ms, input, toolId };
}
