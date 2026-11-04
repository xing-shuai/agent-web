import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import api, { wsClient } from "./api.js";
import { emptySession, applyUpdate, foldEvents } from "./sessionReducer.js";
import Sidebar from "./components/Sidebar.jsx";
import WorkspacePicker from "./components/WorkspacePicker.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import ChatView from "./components/ChatView.jsx";
import Welcome from "./components/Welcome.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { buildMarkdown, buildJson, downloadText } from "./export.js";

export default function App() {
  const [workspaces, setWorkspaces] = useState([]);
  const [home, setHome] = useState("");
  const [activeWorkspace, setActiveWorkspace] = useState(
    () => localStorage.getItem("devin-web.workspace") || null
  );
  const [sessionList, setSessionList] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [sessionData, setSessionData] = useState({}); // id -> session state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [wsUp, setWsUp] = useState(false);
  // Agent registry from the backend; fallback keeps the UI working when the
  // endpoint is unreachable (older server / transient error).
  const [agents, setAgents] = useState([
    { id: "devin", name: "Devin", caps: { fork: true, quota: true } },
  ]);
  const [agentPref, setAgentPref] = useState(
    () => localStorage.getItem("dw.agent") || null
  );
  const [banner, setBanner] = useState(null);
  const [toast, setToast] = useState(null); // {text, kind}
  const [creating, setCreating] = useState(null); // agent id while session/new in flight
  const [notifyEnabled, setNotifyEnabled] = useState(
    () => localStorage.getItem("devin-web.notify") === "1"
  );
  const activeRef = useRef({ id: null, cwd: null });
  activeRef.current = { id: activeId, cwd: activeWorkspace };
  // Every session we hold a WS subscription for (id -> cwd). Switching away
  // unsubscribes; reconnect resubscribes the whole set, not just the active
  // one — otherwise background sessions silently stop mirroring.
  const subscribedRef = useRef(new Map());
  // rAF-batched session_update queue (sessionId -> pending messages).
  const updateQueueRef = useRef(new Map());
  const updateFlushRef = useRef(0);

  const patchSession = useCallback((id, patch) => {
    setSessionData((m) => ({ ...m, [id]: { ...(m[id] || emptySession()), ...patch } }));
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const { sessions } = await api.get(`/api/sessions`);
      setSessionList(Array.isArray(sessions) ? sessions : []);
    } catch (e) {
      setBanner(`获取会话列表失败: ${e.message}`);
    }
  }, []);

  // ---------- boot ----------
  useEffect(() => {
    api
      .get("/api/agents")
      .then((r) => {
        if (Array.isArray(r?.agents) && r.agents.length) setAgents(r.agents);
      })
      .catch(() => {});
    api
      .get("/api/state")
      .then((s) => {
        setWorkspaces(s.workspaces || []);
        setHome(s.home || "");
        if (!activeWorkspace) {
          const ws = s.workspaces?.[0] || s.home;
          if (ws) setActiveWorkspace(ws);
        }
      })
      .catch((e) => setBanner(`后端连接失败: ${e.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeWorkspace) localStorage.setItem("devin-web.workspace", activeWorkspace);
  }, [activeWorkspace]);

  // Agent preference: default to the first registered agent; reset when the
  // stored choice disappears from the registry.
  useEffect(() => {
    if (!agents.length) return;
    if (!agentPref || !agents.some((a) => a.id === agentPref)) {
      setAgentPref(agents[0].id);
      return;
    }
    localStorage.setItem("dw.agent", agentPref);
  }, [agents, agentPref]);

  const pickAgent = useCallback((id) => {
    localStorage.setItem("dw.agent", id);
    setAgentPref(id);
  }, []);

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const agentsByIdRef = useRef(agentsById);
  useEffect(() => {
    agentsByIdRef.current = agentsById;
  }, [agentsById]);
  // Display name for a session's agent (pre-multi-agent rows default devin).
  const agentNameOf = (sid) =>
    agentsByIdRef.current.get(
      sessionListRef.current.find((x) => x.sessionId === sid)?.agent || "devin"
    )?.name || "Devin";
  // The active session's agent (default devin for pre-multi-agent records).
  const activeAgent = sessionList.find((s) => s.sessionId === activeId)?.agent || "devin";
  const activeCaps = agentsById.get(activeAgent)?.caps || { fork: true, quota: true };

  // Global session list: load once, refresh after prompt/delete, and poll
  // silently so CLI-side changes (new/renamed/deleted sessions) show up.
  useEffect(() => {
    refreshSessions();
    const tick = () => {
      if (document.visibilityState === "visible") refreshSessions();
    };
    const t = setInterval(tick, 15000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refreshSessions]);

  // ---------- ws wiring ----------
  useEffect(() => {
    wsClient.onStatus = setWsUp;
    const offs = [
      wsClient.on("history", (m) => {
        setSessionData((sd) => {
          const prev = sd[m.sessionId];
          // Attach success replies + broadcasts can deliver the same transcript
          // twice — an identical re-fold would replay every entry animation.
          // Fingerprint by event timestamps: (gen, length) alone can't tell
          // rebuilt content apart — injects patch events in place without
          // changing the count, and gen restarts at 1 after a server reboot.
          const evs = m.events || [];
          const fp = `${m.gen}:${evs.length}:${evs[0]?.t || 0}:${evs[evs.length - 1]?.t || 0}`;
          if (prev && prev.fp === fp) return sd;
          const folded = foldEvents(evs);
          return {
            ...sd,
            [m.sessionId]: {
              ...(prev || emptySession()),
              ...folded,
              gen: m.gen ?? -1,
              eventsLen: evs.length,
              fp,
              configOptions: folded.configOptions.length
                ? folded.configOptions
                : (m.configOptions?.length ? m.configOptions : sd[m.sessionId]?.configOptions || []),
              modes: folded.modes || m.modes || sd[m.sessionId]?.modes,
              cwd: folded.cwd || sd[m.sessionId]?.cwd,
              // Command list comes from a session-level update the mirror
              // can't produce — fall back to the hub's per-workspace cache
              // shipped on the history envelope.
              commands:
                folded.commands?.length || !m.availableCommands
                  ? folded.commands
                  : m.availableCommands,
              // usage_update shares the mirror blind spot — use the hub's
              // last cached sample when the event stream has none.
              usage:
                folded.usage ||
                (m.usage?.size
                  ? {
                      used: m.usage.used,
                      size: m.usage.size,
                      input: m.usage._meta?.["cognition.ai/inputTokens"],
                      output: m.usage._meta?.["cognition.ai/outputTokens"],
                      cached: m.usage._meta?.["cognition.ai/cachedReadTokens"],
                    }
                  : folded.usage),
              stats: m.stats ?? sd[m.sessionId]?.stats ?? null,
              queue: m.queue || sd[m.sessionId]?.queue || [],
              attached: m.attached,
              running: m.state === "working",
            },
          };
        });
      }),
      wsClient.on("session_update", (m) => {
        if (m.update?.sessionUpdate === "session_info_update") refreshSessions();
        // Coalesce token-frequent updates into one setState per animation
        // frame — a streaming reply otherwise re-renders per chunk.
        let arr = updateQueueRef.current.get(m.sessionId);
        if (!arr) updateQueueRef.current.set(m.sessionId, (arr = []));
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
                // New content in a non-active session → unread marker.
                next[sid] =
                  sid !== activeRef.current.id && !cur.hasUnread
                    ? { ...cur, hasUnread: true }
                    : cur;
              }
            }
            return next;
          });
        });
      }),
      wsClient.on("permission_request", (m) => {
        // A tool call is waiting for a human decision — notify when hidden.
        fireNotify(
          `${agentNameOf(m.sessionId)} 等待权限确认`,
          sessionListRef.current.find((x) => x.sessionId === m.sessionId)?.title || m.sessionId,
          "devin-perm-" + m.requestId
        );
        setSessionData((sd) => {
          const s = sd[m.sessionId] || emptySession();
          if (s.pendingPermissions.some((p) => p.requestId === m.requestId)) return sd;
          return {
            ...sd,
            [m.sessionId]: {
              ...s,
              pendingPermissions: [
                ...s.pendingPermissions,
                { requestId: m.requestId, toolCall: m.toolCall, options: m.options || [] },
              ],
            },
          };
        });
      }),
      wsClient.on("permission_resolved", (m) => {
        setSessionData((sd) => {
          const s = sd[m.sessionId];
          if (!s) return sd;
          return {
            ...sd,
            [m.sessionId]: {
              ...s,
              pendingPermissions: s.pendingPermissions.filter((p) => p.requestId !== m.requestId),
            },
          };
        });
      }),
      wsClient.on("prompt_result", (m) => {
        // A queued prompt still has a turn in flight — running stays true.
        if (!m.queued) patchSession(m.sessionId, { running: false });
        refreshSessions();
      }),
      wsClient.on("queue_update", (m) => {
        setSessionData((sd) => {
          const s = sd[m.sessionId];
          if (!s) return sd;
          return { ...sd, [m.sessionId]: { ...s, queue: m.queue || [] } };
        });
      }),
      wsClient.on("config_options", (m) => {
        patchSession(m.sessionId, { configOptions: m.configOptions || [] });
      }),
      wsClient.on("sessions_changed", () => refreshSessions()),
      wsClient.on("session_attached", (m) =>
        patchSession(m.sessionId, { attached: true, lockError: null, lockCode: null })
      ),
      wsClient.on("session_detached", (m) => patchSession(m.sessionId, { attached: false })),
      wsClient.on("session_state", (m) => {
        patchSession(m.sessionId, { running: m.state === "working" });
        setSessionList((l) =>
          l.map((s) => (s.sessionId === m.sessionId ? { ...s, state: m.state } : s))
        );
      }),
      wsClient.on("session_stats", (m) => patchSession(m.sessionId, { stats: m.stats })),
      wsClient.on("attach_error", (m) =>
        patchSession(m.sessionId, {
          attached: false,
          running: false,
          lockError: m.error,
          lockCode: m.code ?? null,
          lockPid: m.lockHolderPid ?? null,
        })
      ),
      wsClient.on("agent_notification", (m) => {
        const sid = m.sessionId || activeRef.current.id;
        if (!sid) return;
        if (m.method?.endsWith("agent_stopped")) {
          patchSession(sid, { running: false, lastTurn: m.params?.stats || null });
        } else if (m.method?.endsWith("turn_stats")) {
          patchSession(sid, { running: false });
        }
      }),
      wsClient.on("session_deleted", (m) => {
        setSessionList((l) => l.filter((s) => s.sessionId !== m.sessionId));
        setSessionData((sd) => {
          const n = { ...sd };
          delete n[m.sessionId];
          return n;
        });
        if (activeRef.current.id === m.sessionId) setActiveId(null);
        subscribedRef.current.delete(m.sessionId);
      }),
      wsClient.on("error", (m) => {
        setBanner(`${m.op || "ws"} 错误: ${m.error}`);
        if (m.op === "prompt" && m.sessionId) {
          // Flag the unsent optimistic bubble so it doesn't look delivered.
          setSessionData((sd) => {
            const s = sd[m.sessionId];
            if (!s) return sd;
            const items = [...s.items];
            for (let i = items.length - 1; i >= 0; i--) {
              if (items[i].optimistic && !items[i].failed) {
                items[i] = { ...items[i], failed: true };
                break;
              }
            }
            return { ...sd, [m.sessionId]: { ...s, items, running: false } };
          });
        }
      }),
      wsClient.on("agent_detached", () => setBanner("devin acp 进程已退出，将在下次操作时重启")),
    ];
    wsClient.onOpen = () => {
      wsClient.send({ type: "watch" });
      refreshSessions();
      // Resubscribe every session this client had open — a reconnect would
      // otherwise leave non-active sessions silently un-mirrored.
      for (const [sid, cwd] of subscribedRef.current)
        wsClient.send({ type: "subscribe", sessionId: sid, cwd });
      const { id, cwd } = activeRef.current;
      if (id && !subscribedRef.current.has(id)) {
        subscribedRef.current.set(id, cwd);
        wsClient.send({ type: "subscribe", sessionId: id, cwd });
      }
    };
    // The socket may have opened before this effect ran — sync status and
    // run the open hook now, otherwise `watch` is never sent.
    setWsUp(wsClient.open);
    if (wsClient.open) wsClient.onOpen();
    return () => offs.forEach((off) => typeof off === "function" && off());
  }, [patchSession, refreshSessions]);

  // ---------- actions ----------
  // Esc closes the drawer on mobile.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e) => e.key === "Escape" && setDrawerOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const selectWorkspace = useCallback(
    async (dir) => {
      try {
        const { workspaces: ws } = await api.post("/api/workspaces", { path: dir });
        setWorkspaces(ws);
        setActiveWorkspace(dir);
        setActiveId(null);
        setPickerOpen(false);
      } catch (e) {
        setBanner(`添加工作区失败: ${e.message}`);
      }
    },
    []
  );

  const createSession = useCallback(
    async (cwd, agent) => {
      const dir = cwd || activeWorkspace;
      if (!dir) return setPickerOpen(true);
      setCreating(agent || agentPref || "devin");
      try {
        const res = await api.post("/api/sessions", {
          cwd: dir,
          agent: agent || agentPref,
        });
        setDrawerOpen(false);
        setSessionData((sd) => ({
          ...sd,
          [res.sessionId]: {
            ...emptySession(),
            modes: res.modes,
            configOptions: res.configOptions || [],
            cwd: dir,
            attached: true,
          },
        }));
        setActiveWorkspace(dir);
        // New sessions must be subscribed here — openSession isn't involved,
        // and updates broadcast only to s.subscribers: without this the fresh
        // chat shows the optimistic bubble then goes silent.
        const prev = activeRef.current.id;
        if (prev && prev !== res.sessionId) {
          subscribedRef.current.delete(prev);
          wsClient.send({ type: "unsubscribe", sessionId: prev });
        }
        subscribedRef.current.set(res.sessionId, dir);
        setActiveId(res.sessionId);
        location.hash = `#/session/${encodeURIComponent(res.sessionId)}`;
        wsClient.send({ type: "subscribe", sessionId: res.sessionId, cwd: dir });
        refreshSessions();
      } catch (e) {
        setBanner(`创建会话失败: ${e.message}`);
      } finally {
        setCreating(null);
      }
    },
    [activeWorkspace, agentPref, refreshSessions]
  );

  const focusWorkspace = useCallback((cwd) => {
    if (cwd) setActiveWorkspace(cwd);
  }, []);

  const pinSession = useCallback(
    async (sid, pinned) => {
      try {
        await api.post(`/api/sessions/${sid}/pin`, { pinned });
        await refreshSessions();
      } catch (e) {
        setBanner(`置顶失败: ${e.message}`);
      }
    },
    [refreshSessions]
  );

  const archiveSession = useCallback(
    async (sid, archived) => {
      try {
        await api.post(`/api/sessions/${sid}/archive`, { archived });
        await refreshSessions();
      } catch (e) {
        setBanner(`归档失败: ${e.message}`);
      }
    },
    [refreshSessions]
  );

  const openSession = useCallback(
    (sess) => {
      const sid = sess.sessionId || sess;
      const cwd = sess.cwd || activeWorkspace;
      setDrawerOpen(false);
      setActiveId(sid);
      // Deep-link: keep the hash in sync so a reload lands on this session.
      const h = `#/session/${encodeURIComponent(sid)}`;
      if (location.hash !== h) location.hash = h;
      setSessionData((sd) => ({
        ...sd,
        [sid]: {
          ...(sd[sid] || emptySession()),
          cwd,
          title: sess.title || sd[sid]?.title,
          hasUnread: false,
        },
      }));
      const prev = activeRef.current.id;
      if (prev && prev !== sid) {
        subscribedRef.current.delete(prev);
        wsClient.send({ type: "unsubscribe", sessionId: prev });
      }
      subscribedRef.current.set(sid, cwd);
      wsClient.send({ type: "subscribe", sessionId: sid, cwd });
    },
    [activeWorkspace]
  );

  // ---------- deep links ----------
  // #/session/<id> opens that session once the list has loaded; navigating
  // back/forward via hash changes re-applies the link.
  useEffect(() => {
    const onHash = () => {
      const m = location.hash.match(/^#\/session\/(.+)$/);
      if (!m) return;
      const sid = decodeURIComponent(m[1]);
      const sess = sessionList.find((s) => s.sessionId === sid);
      if (sess && activeRef.current.id !== sid) openSession(sess);
    };
    window.addEventListener("hashchange", onHash);
    onHash();
    return () => window.removeEventListener("hashchange", onHash);
  }, [sessionList, openSession]);

  // No active session → drop a stale session link from the address bar.
  useEffect(() => {
    if (!activeId && location.hash.startsWith("#/session/"))
      history.replaceState(null, "", location.pathname + location.search);
  }, [activeId]);

  const sendPrompt = useCallback(
    (blocks) => {
      if (!activeId) return;
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const images = blocks
        .filter((b) => b.type === "image")
        .map((b) => `data:${b.mimeType};base64,${b.data}`);
      // Devin doesn't echo user_message_chunk live — render it optimistically.
      // If an echo does arrive, the reducer replaces the optimistic item.
      // While a turn runs the prompt lands in the server queue instead —
      // the queued chip (not a fake transcript entry) is its visible form.
      setSessionData((sd) => {
        const s = sd[activeId] || emptySession();
        if (s.running)
          return { ...sd, [activeId]: { ...s, running: true } };
        return {
          ...sd,
          [activeId]: {
            ...s,
            running: true,
            items: [
              ...s.items,
              {
                key: `opt-${Date.now()}`,
                kind: "user",
                text,
                images,
                optimistic: true,
                _blocks: blocks,
              },
            ],
          },
        };
      });
      wsClient.send({ type: "prompt", sessionId: activeId, cwd: activeWorkspace, blocks });
    },
    [activeId, activeWorkspace]
  );

  // A failed optimistic bubble → drop it and re-send the stored blocks.
  const retryPrompt = useCallback(
    (item) => {
      const sid = activeRef.current.id;
      if (sid) {
        setSessionData((sd) => {
          const s = sd[sid];
          if (!s) return sd;
          return { ...sd, [sid]: { ...s, items: s.items.filter((x) => x !== item) } };
        });
      }
      if (item._blocks?.length) sendPrompt(item._blocks);
    },
    [sendPrompt]
  );

  const cancelPrompt = useCallback(() => {
    if (activeId) wsClient.send({ type: "cancel", sessionId: activeId });
  }, [activeId]);

  const dequeuePrompt = useCallback((queueId) => {
    if (activeId) wsClient.send({ type: "queue_remove", sessionId: activeId, queueId });
  }, [activeId]);

  // Fork the session at the Nth user message → opens the new fork session.
  const [forkBusy, setForkBusy] = useState(false);
  const forkSession = useCallback(
    async (stepIndex) => {
      if (!activeId || forkBusy) return;
      setForkBusy(true);
      try {
        const r = await api.post(`/api/sessions/${activeId}/fork`, {
          stepIndex,
          cwd: activeWorkspace,
        });
        await refreshSessions();
        if (r?.sessionId) location.hash = `#/session/${r.sessionId}`;
      } catch (e) {
        alert(`分叉失败: ${e.message}`);
      } finally {
        setForkBusy(false);
      }
    },
    [activeId, activeWorkspace, forkBusy, refreshSessions]
  );

  // "编辑" = remove the queued prompt and pull its text back into the
  // composer — the user edits then sends normally.
  const [composerInject, setComposerInject] = useState(null);
  const injectComposer = useCallback((text) => {
    setComposerInject({ text: text || "", n: Date.now() });
  }, []);
  const editQueuedPrompt = useCallback(
    (q) => {
      if (!activeId || !q?.id) return;
      wsClient.send({ type: "queue_remove", sessionId: activeId, queueId: q.id });
      setComposerInject({ text: q.text || "", n: Date.now() });
    },
    [activeId]
  );

  const setConfig = useCallback(
    (configId, value) => {
      if (activeId)
        wsClient.send({ type: "set_config_option", sessionId: activeId, configId, value });
    },
    [activeId]
  );

  const answerPermission = useCallback((requestId, optionId) => {
    wsClient.send({
      type: "permission_response",
      requestId,
      optionId,
      cancelled: optionId == null,
    });
  }, []);

  const deleteSession = useCallback(
    async (sid) => {
      try {
        await api.del(`/api/sessions/${sid}`);
        setSessionList((l) => l.filter((s) => s.sessionId !== sid));
        if (activeRef.current.id === sid) setActiveId(null);
      } catch (e) {
        setBanner(`删除会话失败: ${e.message}`);
      }
    },
    []
  );

  const deleteSessions = useCallback(
    async (ids) => {
      const set = new Set(ids);
      try {
        await api.post("/api/sessions/batch-delete", { ids });
        setSessionList((l) => l.filter((s) => !set.has(s.sessionId)));
        setSessionData((sd) => {
          const n = { ...sd };
          for (const id of ids) delete n[id];
          return n;
        });
        if (set.has(activeRef.current.id)) setActiveId(null);
      } catch (e) {
        setBanner(`批量删除失败: ${e.message}`);
      }
    },
    []
  );

  const renameSession = useCallback(
    async (sid, title) => {
      try {
        await api.post(`/api/sessions/${sid}/rename`, { title });
        patchSession(sid, { title });
        refreshSessions();
      } catch (e) {
        setBanner(`重命名失败: ${e.message}`);
      }
    },
    [patchSession, refreshSessions]
  );

  const releaseSession = useCallback(
    async (sid) => {
      try {
        await api.post(`/api/sessions/${sid}/close`);
        patchSession(sid, { attached: false });
        refreshSessions();
      } catch (e) {
        setBanner(`释放失败: ${e.message}`);
      }
    },
    [patchSession, refreshSessions]
  );

  const retryAttach = useCallback(
    (sid, cwd) => {
      patchSession(sid, { lockError: null, lockCode: null });
      subscribedRef.current.set(sid, cwd);
      wsClient.send({ type: "subscribe", sessionId: sid, cwd });
    },
    [patchSession]
  );

  // ---------- reconnect toast ----------
  const wasUpRef = useRef(false);
  const everUpRef = useRef(false);
  useEffect(() => {
    if (!wsUp && wasUpRef.current) {
      setToast({ text: "连接已断开，正在重连…", kind: "warn", sticky: true });
    } else if (wsUp && !wasUpRef.current && everUpRef.current) {
      setToast({ text: "连接已恢复", kind: "ok" });
    }
    if (wsUp) everUpRef.current = true;
    wasUpRef.current = wsUp;
  }, [wsUp]);
  useEffect(() => {
    if (toast?.sticky && !wsUp) return;
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.sticky ? 0 : 3000);
    return () => clearTimeout(t);
  }, [toast, wsUp]);

  // ---------- turn-end notifications ----------
  // Ref mirror so one-shot WS handlers (registered once) read the latest flag.
  const notifyRef = useRef(false);
  const sessionListRef = useRef([]);
  useEffect(() => {
    notifyRef.current = notifyEnabled;
  }, [notifyEnabled]);
  useEffect(() => {
    sessionListRef.current = sessionList;
  }, [sessionList]);
  const fireNotify = useCallback((title, body, tag) => {
    if (!notifyRef.current || !document.hidden) return;
    document.title = "● Agent Web";
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(title, { body, tag });
      } catch { /* ignored */ }
    }
  }, []);

  const toggleNotify = useCallback(async () => {
    if (notifyEnabled) {
      localStorage.setItem("devin-web.notify", "0");
      setNotifyEnabled(false);
      return;
    }
    if ("Notification" in window && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch { /* ignored */ }
    }
    localStorage.setItem("devin-web.notify", "1");
    setNotifyEnabled(true);
  }, [notifyEnabled]);

  // Watch every known session for running → idle transitions while the tab
  // is hidden: flash the title and (when granted) fire a system notification.
  const prevRunRef = useRef(new Map());
  useEffect(() => {
    const baseTitle = "Agent Web";
    for (const [id, s] of Object.entries(sessionData)) {
      const prev = prevRunRef.current.get(id);
      prevRunRef.current.set(id, !!s.running);
      if (prev === true && !s.running && document.hidden && notifyEnabled) {
        document.title = "● " + baseTitle;
        if ("Notification" in window && Notification.permission === "granted") {
          try {
            new Notification(`${agentNameOf(id)} 完成了任务`, {
              body: sessionList.find((x) => x.sessionId === id)?.title || s.title || id,
              tag: "devin-done-" + id,
            });
          } catch { /* ignored */ }
        }
      }
    }
    const onVis = () => {
      if (!document.hidden) document.title = baseTitle;
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [sessionData, notifyEnabled, sessionList]);

  // ---------- export transcript ----------
  const exportSession = useCallback(
    async (sid, fmt = "md") => {
      try {
        let items = sessionData[sid]?.items;
        let meta = sessionData[sid] || {};
        if (!items?.length) {
          const h = await api.get(`/api/sessions/${sid}/history`);
          items = foldEvents(h.events || []).items;
          if (!items.length) {
            setToast({ text: "该会话没有可导出的内容", kind: "warn" });
            return;
          }
        }
        const title = sessionList.find((x) => x.sessionId === sid)?.title || meta.title || sid;
        const safe = title.replace(/[\\/:*?"<>|]/g, "_");
        if (fmt === "json") {
          downloadText(
            `${safe}.json`,
            buildJson(items, { title, sessionId: sid, cwd: meta.cwd }),
            "application/json;charset=utf-8"
          );
        } else {
          downloadText(
            `${safe}.md`,
            buildMarkdown(items, { title, sessionId: sid, cwd: meta.cwd, agent: agentNameOf(sid) })
          );
        }
        setToast({ text: `已导出 ${fmt === "json" ? "JSON" : "Markdown"}`, kind: "ok" });
      } catch (e) {
        setBanner(`导出失败: ${e.message}`);
      }
    },
    [sessionData, sessionList]
  );

  const session = activeId ? sessionData[activeId] || emptySession() : null;
  // Sessions that received new content while not active — sidebar badge set.
  const unreadIds = useMemo(
    () =>
      new Set(
        Object.entries(sessionData)
          .filter(([, s]) => s.hasUnread)
          .map(([id]) => id)
      ),
    [sessionData]
  );

  const openPicker = useCallback(() => {
    setDrawerOpen(false);
    setPickerOpen(true);
  }, []);

  // ---------- command palette (Cmd/Ctrl+K) ----------
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const paletteActions = useMemo(
    () => [
      { id: "new", title: "新建会话", run: () => createSession() },
      ...(agents.length > 1
        ? agents.map((a) => ({
            id: `new-${a.id}`,
            title: `新建 ${a.name} 会话`,
            run: () => createSession(undefined, a.id),
          }))
        : []),
      {
        id: "focus",
        title: "聚焦输入框",
        run: () => document.querySelector(".input-ta")?.focus(),
      },
      ...(activeId
        ? [
            { id: "export", title: "导出当前会话 (Markdown)", run: () => exportSession(activeId) },
            {
              id: "notify",
              title: notifyEnabled ? "关闭完成通知" : "开启完成通知",
              run: () => toggleNotify(),
            },
          ]
        : []),
      { id: "drawer", title: "打开会话列表", run: () => setDrawerOpen(true) },
    ],
    [createSession, agents, exportSession, activeId, notifyEnabled, toggleNotify]
  );

  return (
    <div className="app">
      {drawerOpen && <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} />}
      <Sidebar
        sessions={sessionList}
        activeId={activeId}
        activeWorkspace={activeWorkspace}
        home={home}
        wsUp={wsUp}
        drawerOpen={drawerOpen}
        onPickWorkspace={openPicker}
        onFocusWorkspace={focusWorkspace}
        onNewSession={createSession}
        onOpenSession={openSession}
        onDeleteSession={deleteSession}
        onDeleteSessions={deleteSessions}
        onRenameSession={renameSession}
        onReleaseSession={releaseSession}
        onExportSession={exportSession}
        onPinSession={pinSession}
        onArchiveSession={archiveSession}
        unreadIds={unreadIds}
        agentsById={agentsById}
        usageAgent={activeId ? sessionList.find((s) => s.sessionId === activeId)?.agent : null}
        usageProvider={session?.configOptions?.find((c) => c.category === "model" || /model/i.test(c.id || ""))?.currentValue?.split("/")[0] || null}
        agentPref={agentPref}
        onPickAgent={pickAgent}
        creating={creating}
        notifyEnabled={notifyEnabled}
        onToggleNotify={toggleNotify}
      />
      {toast && <div className={"toast " + toast.kind}>{toast.text}</div>}
      <main className="main">
        {banner && (
          <div className="banner">
            <AlertCircle size={15} />
            <span className="banner-msg">{banner}</span>
            <button className="icon-ghost" onClick={() => setBanner(null)} title="关闭">
              <X size={14} />
            </button>
          </div>
        )}
        {session ? (
          <ErrorBoundary resetKey={activeId}>
            <ChatView
              key={activeId}
              sessionId={activeId}
              session={session}
              wsUp={wsUp}
              agentName={agentsById.get(activeAgent)?.name || "Devin"}
              home={home}
              onSend={sendPrompt}
              onCancel={cancelPrompt}
              onDequeue={dequeuePrompt}
              onEditQueued={editQueuedPrompt}
              composerInject={composerInject}
              onEditPrompt={injectComposer}
              canFork={!!activeCaps.fork}
              onFork={forkSession}
              forkBusy={forkBusy}
              onConfig={setConfig}
              onPermission={answerPermission}
              onRetry={retryAttach}
              onRetryPrompt={retryPrompt}
              onRelease={releaseSession}
              onOpenDrawer={() => setDrawerOpen(true)}
              onExport={() => exportSession(activeId)}
            />
          </ErrorBoundary>
        ) : (
          <Welcome
            sessions={sessionList}
            activeWorkspace={activeWorkspace}
            home={home}
            wsUp={wsUp}
            creating={creating}
            agents={agents}
            agentPref={agentPref}
            onPickAgent={pickAgent}
            onNewSession={createSession}
            onPickWorkspace={openPicker}
            onOpenDrawer={() => setDrawerOpen(true)}
          />
        )}
      </main>
      {pickerOpen && (
        <WorkspacePicker
          initial={activeWorkspace || home}
          onClose={() => setPickerOpen(false)}
          onSelect={selectWorkspace}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={sessionList}
        actions={paletteActions}
        onOpenSession={openSession}
      />
    </div>
  );
}
