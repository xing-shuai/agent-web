import { useCallback, useEffect, useRef, useState } from "react";
import { environment } from "../api.js";
import { emptySession, applyUpdate, foldEvents, historyUsage, historySnapshot, foldHistoryDelta } from "../sessionReducer.js";
import { sessionKey } from "../splitLayout.js";
import { t } from "../i18n.js";

const fallbackAgents = [{ id: "devin", name: "Devin", caps: { fork: true, quota: true } }];
const emptyEnv = () => ({ sessions: [], loading: true, workspaces: [], home: "", agents: fallbackAgents, wsUp: false });

// ---------- per-host wiring ----------
// Each in-use host gets REST bootstrap, a session list and a socket. The
// lazy env.ws getter is only touched while the host stays in use; leaving
// use drops this host's subscription intents and releases the client.
export default function useHostConnections({ hostsKey, notify, setSessionData, updateDelivery, subscribedRef, deliveryRef, hostName, activeRef, fireNotify, clearSessions }) {
  const [envs, setEnvs] = useState({});
  const envsRef = useRef(envs);
  envsRef.current = envs;
  const envOf = (host) => envsRef.current[host || ""] || emptyEnv();
  const sessionsOf = (host) => envOf(host).sessions;
  const agentMaps = useRef(new Map());
  const agentsByIdOf = useCallback((host) => {
    const agents = (envsRef.current[host || ""] || emptyEnv()).agents;
    const cached = agentMaps.current.get(host || "");
    if (cached?.agents === agents) return cached.map;
    const map = new Map(agents.map((agent) => [agent.id, agent]));
    agentMaps.current.set(host || "", { agents, map });
    return map;
  }, []);
  const patchEnv = useCallback((host, patch) =>
    setEnvs((all) => ({ ...all, [host]: { ...(all[host] || emptyEnv()), ...patch } })), []);
  const mapEnvSessions = useCallback((host, fn) =>
    setEnvs((all) => ({ ...all, [host]: { ...(all[host] || emptyEnv()), sessions: fn(all[host]?.sessions || []) } })), []);
  // Display name for a session's agent (pre-multi-agent rows default devin).
  const agentNameOf = (host, sid) =>
    agentsByIdOf(host).get(sessionsOf(host).find((x) => x.sessionId === sid)?.agent || "devin")?.name || "Devin";

  const sessionListRequestRef = useRef(new Map()); // host -> last request id
  const sessionListLoadedRef = useRef(new Set()); // hosts whose list arrived
  const serverRef = useRef(new Map()); // host -> {ack, instanceId, dedupMs}
  // rAF-batched session_update queue (sessionKey -> pending messages).
  const updateQueueRef = useRef(new Map());
  const updateFlushRef = useRef(0);

  const patchSession = useCallback((key, patch) => {
    setSessionData((m) => ({ ...m, [key]: { ...(m[key] || emptySession()), ...patch } }));
  }, [setSessionData]);

  const refreshSessions = useCallback(async (host) => {
    const request = (sessionListRequestRef.current.get(host) || 0) + 1;
    sessionListRequestRef.current.set(host, request);
    // The initial loading state clears once; background polling keeps the
    // current list (including an empty/search result) visually stable.
    try {
      const { sessions } = await environment(host).api.get(`/api/sessions`);
      if (request === sessionListRequestRef.current.get(host)) {
        sessionListLoadedRef.current.add(host);
        patchEnv(host, { sessions: Array.isArray(sessions) ? sessions : [] });
      }
    } catch (e) {
      if (request === sessionListRequestRef.current.get(host)) notify({ host, kind: "error", text: t("获取会话列表失败: {v0}", { v0: e.message }) });
    } finally {
      if (request === sessionListRequestRef.current.get(host)) patchEnv(host, { loading: false });
    }
  }, [patchEnv, notify]);

  const wiredHostsRef = useRef(new Map()); // host -> cleanup
  // Only wired hosts have a socket; touching .ws elsewhere would lazily
  // reopen a released one. Every outbound send goes through wsFor.
  const wsFor = useCallback((host) =>
    wiredHostsRef.current.has(host || "") ? environment(host || "").ws : null, []);

  function wireHost(host) {
    const env = environment(host);
    const note = (text, opts = {}) => notify({ host, kind: "error", ...opts, text });
    let disposed = false;
    env.api.get("/api/agents")
      .then((r) => { if (!disposed && Array.isArray(r?.agents) && r.agents.length) patchEnv(host, { agents: r.agents }); })
      .catch(() => {});
    env.api.get("/api/state")
      .then((s) => { if (!disposed) patchEnv(host, { workspaces: s.workspaces || [], home: s.home || "", scratch: !!s.scratch }); })
      .catch((e) => { if (!disposed) note(t("后端连接失败: {v0}", { v0: e.message }), { reload: true }); });
    refreshSessions(host);
    const tick = () => { if (document.visibilityState === "visible") refreshSessions(host); };
    const timer = setInterval(tick, 60000);
    document.addEventListener("visibilitychange", tick);
    const ws = env.ws;
    ws.onStatus = (connected) => {
      patchEnv(host, { wsUp: connected });
      if (!connected) for (const delivery of deliveryRef.current.values()) {
        if ((delivery.host || "") === host && ["sending", "receiving"].includes(delivery.phase))
          updateDelivery(host, delivery.sessionId, delivery.id, { phase: "uncertain", error: t("连接中断，暂时无法确认消息是否被接收。") });
      }
    };
    const onHello = (m) => {
      serverRef.current.set(host, { ack: !!m.caps?.promptAck, instanceId: m.instanceId || null, dedupMs: m.caps?.dedupMs || 0 });
      if (serverRef.current.get(host).ack) for (const delivery of deliveryRef.current.values())
        if ((delivery.host || "") === host) ws.send({ type: "prompt_status", sessionId: delivery.sessionId, requestId: delivery.id });
      if (!m.build) return;
      const own = [...document.scripts]
        .map((s) => s.src.match(/assets\/index-([^.]+)\.js/)?.[1])
        .find(Boolean);
      if (own && m.build !== own && sessionStorage.getItem("dw.reloaded") !== m.build) {
        sessionStorage.setItem("dw.reloaded", m.build);
        location.reload();
      }
    };
    const offs = [
      // Server redeployed the frontend while we were running — reload to
      // the new bundle. sessionStorage guards against a reload loop if a
      // sticky cache keeps serving the old index.html.
      ws.on("hello", onHello),
      ws.on("history", (m) => {
        const key = sessionKey(host, m.sessionId);
        // WebSocket ordering: earlier queued deltas are already represented
        // by this snapshot. Reapplying them on the next rAF duplicates text.
        updateQueueRef.current.delete(key);
        setSessionData((sd) => {
          const prev = sd[key];
          const base = prev?.historyBase;
          if (m.delta && (!base || base.token !== m.historyBaseToken || base.gen !== m.gen || base.length !== m.historyBaseLength ||
              prev.treeHistory || m.historyLength !== base.length + (m.events?.length || 0))) {
            queueMicrotask(() => ws.requestHistory?.(m.sessionId));
            return prev ? { ...sd, [key]: { ...prev, historyLoading: true, historyToken: null, historyBase: null } } : sd;
          }
          if (m.unchanged && (!m.historyToken || !prev || prev.historyToken !== m.historyToken)) {
            // A UI cache can be evicted independently of the socket. Never
            // fabricate ready/empty history from a transport-only validator.
            queueMicrotask(() => ws.requestHistory?.(m.sessionId));
            return sd;
          }
          // Attach success replies + broadcasts can deliver the same transcript
          // twice — an identical re-fold would replay every entry animation.
          // Fingerprint by event timestamps: (gen, length) alone can't tell
          // rebuilt content apart — injects patch events in place without
          // changing the count, and gen restarts at 1 after a server reboot.
          const evs = m.events || [];
          const fp = m.historyToken || `${m.gen}:${m.revision ?? ""}:${evs.length}:${evs[0]?.t || 0}:${evs[evs.length - 1]?.t || 0}`;
          const treeWaiting = prev?.treeHistory && prev.treeHistory.instanceId === (serverRef.current.get(host)?.instanceId || null) &&
            prev.treeHistory.connectionId === ws.connectionId && (m.gen ?? -1) < prev.treeHistory.gen;
          const same = prev && (m.unchanged || (m.historyToken ? prev.historyToken === m.historyToken : prev.fp === fp && (!prev.treeHistory || treeWaiting)));
          const folded = m.delta ? foldHistoryDelta(base.snapshot, evs) : same ? prev : foldEvents(evs);
          const usage = Object.hasOwn(m, "usage") ? historyUsage(null, m.usage) : historyUsage(folded.usage);
          const resume = (m.historyFormat || m.historyEncoding) === "strings-v2" && m.historyToken
            ? { token: m.historyToken, gen: m.gen, length: m.historyLength, snapshot: historySnapshot(folded) } : null;
          return {
            ...sd,
            [key]: {
              ...(prev || emptySession()),
              ...folded,
              gen: m.gen ?? -1,
              title: m.title || folded.title || prev?.title || sessionsOf(host).find((s) => s.sessionId === m.sessionId)?.title || null,
              deliveries: prev?.deliveries || [],
              eventsLen: m.delta ? m.historyLength : same ? prev.eventsLen : evs.length,
              fp,
              historyToken: m.historyToken || null,
              historyBase: resume,
              pendingPermissions: Array.isArray(m.pendingPermissionIds) ? (prev?.pendingPermissions || []).filter((p) => m.pendingPermissionIds.includes(p.requestId)) : folded.pendingPermissions || [],
              pendingElicitations: Array.isArray(m.pendingElicitationIds) ? (prev?.pendingElicitations || []).filter((p) => m.pendingElicitationIds.includes(p.requestId)) : folded.pendingElicitations || [],
              configOptions: Array.isArray(m.configOptions) ? m.configOptions : folded.configOptions.length
                ? folded.configOptions
                : (m.configOptions?.length ? m.configOptions : prev?.configOptions || []),
              modes: Object.hasOwn(m, "modes") ? m.modes : folded.modes || prev?.modes,
              cwd: folded.cwd || prev?.cwd,
              // Command list comes from a session-level update the mirror
              // can't produce — fall back to the hub's per-workspace cache
              // shipped on the history envelope.
              commands: Array.isArray(m.availableCommands) ? m.availableCommands :
                folded.commands?.length || !m.availableCommands
                  ? folded.commands
                  : m.availableCommands,
              // usage_update shares the mirror blind spot — use the hub's
              // last cached sample when the event stream has none.
              usage,
              stats: m.stats ?? prev?.stats ?? null,
              queue: m.queue || prev?.queue || [],
              attached: m.attached,
              // An HTTP switch can finish ahead of a large WS frame. Older
              // snapshots cannot end its wait; a fresh subscription/worker
              // provides authoritative history even if generations reset.
              historyLoading: !!treeWaiting,
              treeHistory: treeWaiting ? prev.treeHistory : null,
              running: m.state === "working",
              processes: Object.hasOwn(m, "processes") ? m.processes : folded.processes,
            },
          };
        });
      }),
      ws.on("session_update", (m) => {
        const meta = m.update?._meta?.piAcp;
        if (m.update?.sessionUpdate === "session_info_update" && (m.update.title !== undefined || !(meta?.telemetry || meta?.processes || meta?.processNotification))) refreshSessions(host);
        const key = sessionKey(host, m.sessionId);
        // Coalesce token-frequent updates into one setState per animation
        // frame — a streaming reply otherwise re-renders per chunk.
        let arr = updateQueueRef.current.get(key);
        if (!arr) updateQueueRef.current.set(key, (arr = []));
        arr.push(m);
        if (updateFlushRef.current) return;
        updateFlushRef.current = requestAnimationFrame(() => {
          updateFlushRef.current = 0;
          const batches = updateQueueRef.current;
          updateQueueRef.current = new Map();
          setSessionData((sd) => {
            let next = sd;
            for (const [sid, msgs] of batches) {
              const s = next[sid];
              // Updates for sessions we never opened (watch broadcasts) must
              // not materialize entries — that grows sessionData unboundedly.
              if (!s) continue;
              let cur = s;
              for (const mm of msgs) {
                // gen mismatch → the server replaced the transcript; the
                // matching consolidated `history` rebuilds it atomically.
                if (mm.gen !== undefined && cur.gen >= 0 && mm.gen !== cur.gen) continue;
                if (cur.gen < 0 && mm.gen !== undefined) cur = { ...cur, gen: mm.gen };
                cur = applyUpdate(cur, mm.update, mm.t || Date.now());
              }
              if (cur !== s) {
                if (next === sd) next = { ...sd };
                cur = { ...cur, historyToken: null };
                // New content in a non-active session → unread marker.
                next[sid] =
                  sid !== activeRef.current.key && sid !== activeRef.current.quickKey && !cur.hasUnread
                    ? { ...cur, hasUnread: true }
                    : cur;
              }
            }
            return next;
          });
        });
      }),
      ws.on("permission_request", (m) => {
        // A tool call is waiting for a human decision — notify when hidden.
        fireNotify(
          t("{v0} 等待权限确认", { v0: agentNameOf(host, m.sessionId) }),
          sessionsOf(host).find((x) => x.sessionId === m.sessionId)?.title || m.sessionId,
          `devin-perm-${host}-${m.requestId}`
        );
        setSessionData((sd) => {
          const key = sessionKey(host, m.sessionId);
          const s = sd[key] || emptySession();
          if (s.pendingPermissions.some((p) => p.requestId === m.requestId)) return sd;
          return {
            ...sd,
            [key]: {
              ...s,
              pendingPermissions: [
                ...s.pendingPermissions,
                { requestId: m.requestId, toolCall: m.toolCall, options: m.options || [] },
              ],
            },
          };
        });
      }),
      ws.on("elicitation_request", (m) => {
        setSessionData((sd) => {
          const key = sessionKey(host, m.sessionId);
          const s = sd[key] || emptySession();
          if (s.pendingElicitations.some((p) => p.requestId === m.requestId)) return sd;
          return {
            ...sd,
            [key]: {
              ...s,
              pendingElicitations: [
                ...s.pendingElicitations,
                { requestId: m.requestId, message: m.message, schema: m.schema, agent: m.agent },
              ],
            },
          };
        });
      }),
      ws.on("elicitation_resolved", (m) => {
        setSessionData((sd) => {
          const key = sessionKey(host, m.sessionId);
          const s = sd[key];
          if (!s) return sd;
          return {
            ...sd,
            [key]: {
              ...s,
              pendingElicitations: s.pendingElicitations.filter((p) => p.requestId !== m.requestId),
            },
          };
        });
      }),
      ws.on("permission_resolved", (m) => {
        setSessionData((sd) => {
          const key = sessionKey(host, m.sessionId);
          const s = sd[key];
          if (!s) return sd;
          return {
            ...sd,
            [key]: {
              ...s,
              pendingPermissions: s.pendingPermissions.filter((p) => p.requestId !== m.requestId),
            },
          };
        });
      }),
      ws.on("prompt_delivery", (m) => {
        const delivery = deliveryRef.current.get(m.requestId);
        if (!delivery || delivery.sessionId !== m.sessionId || (delivery.host || "") !== host) return;
        if (m.status === "unknown") {
          updateDelivery(host, m.sessionId, m.requestId, { phase: "uncertain", error: t("服务端尚无此消息的确认记录，请核对会话后重试或恢复编辑。") });
        } else updateDelivery(host, m.sessionId, m.requestId, { phase: m.status, accepted: m.accepted ?? delivery.accepted,
          queueId: m.queueId, error: m.error || null });
      }),
      ws.on("prompt_result", (m) => {
        const tracked = m.requestId && deliveryRef.current.get(m.requestId);
        if (tracked && (tracked.host || "") === host)
          updateDelivery(host, m.sessionId, m.requestId, { phase: m.status || (m.queued ? "queued" : "completed"), queueId: m.queueId });
        else if (!m.requestId) {
          const pending = [...deliveryRef.current.values()].filter((d) => (d.host || "") === host && d.sessionId === m.sessionId);
          const delivery = m.queued ? pending.find((d) => d.wasRunning && !d.queueId) || (pending.length === 1 ? pending[0] : null)
            : pending.find((d) => !d.queueId && d.phase !== "failed");
          if (delivery) updateDelivery(host, m.sessionId, delivery.id, { phase: m.queued ? "queued" : "completed", queueId: m.queueId });
          if (!m.queued) patchSession(sessionKey(host, m.sessionId), { running: false });
        }
        refreshSessions(host);
      }),
      ws.on("queue_update", (m) => {
        setSessionData((sd) => {
          const key = sessionKey(host, m.sessionId);
          const s = sd[key];
          if (!s) return sd;
          return { ...sd, [key]: { ...s, queue: m.queue || [] } };
        });
      }),
      ws.on("config_options", (m) => {
        patchSession(sessionKey(host, m.sessionId), { configOptions: m.configOptions || [] });
      }),
      ws.on("sessions_changed", () => refreshSessions(host)),
      ws.on("session_attached", (m) =>
        patchSession(sessionKey(host, m.sessionId), { attached: true, lockError: null, lockCode: null })
      ),
      ws.on("session_detached", (m) => patchSession(sessionKey(host, m.sessionId), { attached: false, processes: null })),
      ws.on("session_state", (m) => {
        patchSession(sessionKey(host, m.sessionId), { running: m.state === "working" });
        mapEnvSessions(host, (list) =>
          list.map((s) => (s.sessionId === m.sessionId ? { ...s, state: m.state } : s))
        );
      }),
      ws.on("session_stats", (m) => patchSession(sessionKey(host, m.sessionId), { stats: m.stats })),
      ws.on("attach_error", (m) =>
        patchSession(sessionKey(host, m.sessionId), {
          attached: false,
          running: false,
          lockError: m.error,
          lockCode: m.code ?? null,
          lockPid: m.lockHolderPid ?? null,
        })
      ),
      ws.on("agent_notification", (m) => {
        const sid = m.sessionId || (host === activeRef.current.host ? activeRef.current.id : null);
        if (!sid) return;
        const key = sessionKey(host, sid);
        if (m.method?.endsWith("agent_stopped")) {
          patchSession(key, { running: false, lastTurn: m.params?.stats || null });
        } else if (m.method?.endsWith("turn_stats")) {
          patchSession(key, { running: false });
        } else if (m.method?.endsWith("turn_stalled")) {
          patchSession(key, { running: false });
          note(t("该会话长时间无响应，请先核对消息状态或重新连接，再决定是否重试"));
        } else if (m.method === "pi/extension_notify") {
          // Transient extension notices (e.g. remote-pi status) → toast,
          // kept out of the transcript.
          const lvl = m.params?.level;
          notify({ host,
            text: m.params?.text ?? "",
            kind: lvl === "error" ? "error" : lvl === "warning" ? "warn" : "info",
          });
        }
      }),
      ws.on("session_deleted", (m) => {
        mapEnvSessions(host, (list) => list.filter((s) => s.sessionId !== m.sessionId));
        const key = sessionKey(host, m.sessionId);
        setSessionData((sd) => {
          const n = { ...sd };
          delete n[key];
          return n;
        });
        clearSessions(host, [m.sessionId]);
        subscribedRef.current.delete(key);
      }),
      ws.on("error", (m) => {
        if (m.op === "prompt" && m.sessionId) {
          const delivery = deliveryRef.current.get(m.requestId) || [...deliveryRef.current.values()].reverse().find((d) => (d.host || "") === host && d.sessionId === m.sessionId && ["sending", "receiving", "uncertain"].includes(d.phase));
          if (delivery) {
            updateDelivery(host, m.sessionId, delivery.id, { phase: "failed", error: m.error });
            if (!delivery.wasRunning) patchSession(sessionKey(host, m.sessionId), { running: false });
            return;
          }
        }
        note(t("{v0} 错误: {v1}", { v0: m.op || "ws", v1: m.error }));
      }),
      ws.on("agent_detached", () => note(t("devin acp 进程已退出，将在下次操作时重启"), { reload: true })),
    ];
    ws.onOpen = () => {
      ws.send({ type: "watch" });
      refreshSessions(host);
      // Resubscribe every session this client had open — a reconnect would
      // otherwise leave non-active sessions silently un-mirrored.
      for (const sub of subscribedRef.current.values())
        if (sub.host === host) ws.send({ type: "subscribe", sessionId: sub.sid, cwd: sub.cwd });
    };
    // The socket may have opened before this effect ran — sync status and
    // run the open hook now, otherwise `watch` is never sent.
    patchEnv(host, { wsUp: ws.open });
    if (ws.open) {
      ws.onOpen();
      if (ws.hello) onHello(ws.hello);
    }
    return () => {
      disposed = true;
      offs.forEach((off) => typeof off === "function" && off());
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      ws.onStatus = null;
      ws.onOpen = null;
      for (const [key, sub] of subscribedRef.current) if (sub.host === host) subscribedRef.current.delete(key);
      env.release();
    };
  }

  useEffect(() => {
    const wanted = new Set(hostsKey.split("\n"));
    for (const host of [...wiredHostsRef.current.keys()]) if (!wanted.has(host)) {
      wiredHostsRef.current.get(host)();
      wiredHostsRef.current.delete(host);
    }
    for (const host of wanted) if (!wiredHostsRef.current.has(host)) wiredHostsRef.current.set(host, wireHost(host));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostsKey]);
  useEffect(() => () => {
    for (const cleanup of wiredHostsRef.current.values()) cleanup();
    wiredHostsRef.current.clear();
  }, []);

  return { envs, envsRef, envOf, sessionsOf, agentsByIdOf, agentNameOf, patchEnv, mapEnvSessions, patchSession,
    refreshSessions, sessionListLoadedRef, serverRef, updateQueueRef, wsFor };
}
