import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import api, { wsClient } from "./api.js";
import { emptySession, applyUpdate, foldEvents } from "./sessionReducer.js";
import Sidebar from "./components/Sidebar.jsx";
import WorkspacePicker from "./components/WorkspacePicker.jsx";
import ChatView from "./components/ChatView.jsx";
import Welcome from "./components/Welcome.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { buildMarkdown, downloadText } from "./export.js";

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
  const [wsUp, setWsUp] = useState(false);
  const [banner, setBanner] = useState(null);
  const [toast, setToast] = useState(null); // {text, kind}
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
                cur = applyUpdate(cur, mm.update);
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
        patchSession(m.sessionId, { running: false });
        refreshSessions();
      }),
      wsClient.on("config_options", (m) => {
        patchSession(m.sessionId, { configOptions: m.configOptions || [] });
      }),
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
    async (cwd) => {
      const dir = cwd || activeWorkspace;
      if (!dir) return setPickerOpen(true);
      try {
        const res = await api.post("/api/sessions", { cwd: dir });
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
        setActiveId(res.sessionId);
        refreshSessions();
      } catch (e) {
        setBanner(`创建会话失败: ${e.message}`);
      }
    },
    [activeWorkspace, refreshSessions]
  );

  const focusWorkspace = useCallback((cwd) => {
    if (cwd) setActiveWorkspace(cwd);
  }, []);

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
      setSessionData((sd) => {
        const s = sd[activeId] || emptySession();
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
    const baseTitle = "Devin Web";
    for (const [id, s] of Object.entries(sessionData)) {
      const prev = prevRunRef.current.get(id);
      prevRunRef.current.set(id, !!s.running);
      if (prev === true && !s.running && document.hidden && notifyEnabled) {
        document.title = "● " + baseTitle;
        if ("Notification" in window && Notification.permission === "granted") {
          try {
            new Notification("Devin 完成了任务", {
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
    async (sid) => {
      try {
        let items = sessionData[sid]?.items;
        let meta = sessionData[sid] || {};
        if (!items?.length) {
          const h = await api.get(`/api/sessions/${sid}/history`);
          items = foldEvents(h.events || []).items;
          if (!items.length) {
            setToast({ text: "该会话没有可导出的内容（需先在 web 中打开过一次）", kind: "warn" });
            return;
          }
        }
        const title = sessionList.find((x) => x.sessionId === sid)?.title || meta.title || sid;
        const md = buildMarkdown(items, { title, sessionId: sid, cwd: meta.cwd });
        downloadText(`${title.replace(/[\\/:*?"<>|]/g, "_")}.md`, md);
        setToast({ text: "已导出 Markdown", kind: "ok" });
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
        onRenameSession={renameSession}
        onReleaseSession={releaseSession}
        onExportSession={exportSession}
        unreadIds={unreadIds}
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
              home={home}
              onSend={sendPrompt}
              onCancel={cancelPrompt}
              onConfig={setConfig}
              onPermission={answerPermission}
              onRetry={retryAttach}
              onRetryPrompt={retryPrompt}
              onRelease={releaseSession}
              onOpenDrawer={() => setDrawerOpen(true)}
              onNewSession={createSession}
              notifyEnabled={notifyEnabled}
              onToggleNotify={toggleNotify}
              onExport={() => exportSession(activeId)}
            />
          </ErrorBoundary>
        ) : (
          <Welcome
            sessions={sessionList}
            activeWorkspace={activeWorkspace}
            home={home}
            wsUp={wsUp}
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
    </div>
  );
}

export function shortPath(p) {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}
