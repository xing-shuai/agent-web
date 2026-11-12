import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, RotateCw, X } from "lucide-react";
import { environment, initialHost, controlApi } from "./api.js";
import { EnvironmentContext } from "./environmentContext.js";
import { emptySession, foldEvents } from "./sessionReducer.js";
import Sidebar from "./components/Sidebar.jsx";
import SplitWorkspace from "./components/SplitWorkspace.jsx";
import { restoreLayout, layoutReducer, paneLeaves, sessionKey, parseSessionKey, neighborPane, layoutGeometry } from "./splitLayout.js";
import WorkspacePicker from "./components/WorkspacePicker.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import QuickChat from "./components/QuickChat.jsx";
import ChatView from "./components/ChatView.jsx";
import RemoteHosts from "./components/RemoteHosts.jsx";
import Welcome from "./components/Welcome.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { buildMarkdown, buildJson, downloadText } from "./export.js";
import { hydrateHistoryImages } from "./historyImages.js";
import useHostConnections from "./hooks/useHostConnections.js";
import { matchHotkey, hotkeyRecording } from "./hotkeys.js";
import { getUi } from "./ui.js";
import useDeliveries, { readDeliveries } from "./hooks/useDeliveries.js";
import useDeepLink from "./hooks/useDeepLink.js";
import useNotices from "./hooks/useNotices.js";
import { evictableKeys, stampSeen } from "./sessionCache.js";
import { hasActiveLayer } from "./layers.js";
import { t } from "./i18n.js";
import { readDraft, saveDraft, emptyDraft } from "./composerDrafts.js";

const TerminalPanel = React.lazy(() => import("./components/TerminalPanel.jsx"));

const fallbackAgents = [{ id: "devin", name: "Devin", caps: { fork: true, quota: true } }];
const emptyEnv = () => ({ sessions: [], loading: true, workspaces: [], home: "", agents: fallbackAgents, wsUp: false });
const lastWorkspace = (host) => { try { return localStorage.getItem(environment(host).storageKey("devin-web.workspace")) || null; } catch { return null; } };

// Marker membership changes far less often than token updates. Preserve its
// identity so streaming doesn't invalidate the whole sidebar's sort/render.
function useStableSet(value) {
  const previous = useRef(value);
  if (previous.current.size !== value.size || [...value].some((id) => !previous.current.has(id))) previous.current = value;
  return previous.current;
}

// Session-bound handlers stay stable while other panes stream. A layout edit
// must not make every historical Markdown item in every pane render again.
const PaneChat = React.memo(function PaneChat({ sessionId: sid, host, paneId, controller: c, quickMode, ...props }) {
  const key = sessionKey(host, sid);
  const actions = useMemo(() => ({
    onSend: (blocks) => c.sendPrompt(host, sid, blocks), onCancel: () => c.cancelPrompt(host, sid),
    onDequeue: (queueId) => c.dequeuePrompt(host, sid, queueId), onEditQueued: (queue) => c.editQueuedPrompt(host, sid, queue),
    onConsumeInject: (n) => c.setComposerInjects((all) => all[key]?.n === n ? { ...all, [key]: null } : all),
    onNavigateTree: (options) => c.navigateTree(host, sid, options),
    onConsumeSearch: () => c.setSearchRequests((all) => key in all ? { ...all, [key]: null } : all),
    onEditPrompt: (text) => c.injectComposer(host, sid, text), onFork: (index) => c.forkSession(host, sid, paneId, index),
    onConfig: (configId, value) => c.setConfig(host, sid, configId, value), onRetryPrompt: (item) => c.retryPrompt(host, sid, item),
    onRestoreDelivery: (delivery) => {
      if (delivery.sessionId !== sid || (delivery.host || "") !== host) return;
      c.setComposerInjects((all) => ({ ...all, [key]: { blocks: delivery.blocks, append: true, n: `${Date.now()}-${Math.random()}`, sessionId: sid } }));
      if (delivery.phase === "failed") c.updateDelivery(host, sid, delivery.id, { phase: "cancelled" });
    },
    onExport: () => c.exportSession(host, sid), onOpenDrawer: quickMode ? undefined : c.openDrawer, onOpenPalette: c.openPalette,
    onPermission: (requestId, optionId) => c.answerPermission(host, requestId, optionId),
    onElicitation: (requestId, action, content) => c.answerElicitation(host, requestId, action, content),
    onRetry: (retrySid, cwd) => c.retryAttach(host, retrySid, cwd), onRetryDelivery: c.retryDelivery,
    onRelease: () => c.releaseSession(host, sid), onToggleTerminal: quickMode ? undefined : () => c.toggleTerminal(paneId),
  }), [c, sid, host, key, paneId, quickMode]);
  return <ChatView sessionId={sid} {...props} {...actions} />;
});

export default function App() {
  const [remoteHosts, setRemoteHosts] = useState([]);
  const [remoteHostsOpen, setRemoteHostsOpen] = useState(0);
  const [connectBusy, setConnectBusy] = useState(null);
  const remoteHostsRef = useRef([]);
  remoteHostsRef.current = remoteHosts;
  const hostName = useCallback((h) => {
    if (!h) return t("本机");
    const found = remoteHostsRef.current.find((x) => x.id === h);
    return found?.label || found?.hostname || (remoteHostsRef.current.length ? t("未知远程主机") : t("远程主机"));
  }, []);

  const { items: notices, notify, dismiss, dismissWhere } = useNotices();

  const [layout, setLayout] = useState(() => {
    const workspace = location.hash.match(/^#\/workspace\/(.+)$/);
    let hashWorkspace = null, saved = null, defaultHost = "";
    try { if (workspace) hashWorkspace = decodeURIComponent(workspace[1]); } catch {}
    try {
      saved = sessionStorage.getItem("dw.layout");
      if (saved == null && initialHost && sessionStorage.getItem(environment(initialHost).storageKey("dw.layout")) != null) {
        saved = sessionStorage.getItem(environment(initialHost).storageKey("dw.layout"));
        defaultHost = initialHost; // legacy remote document in this tab
      }
    } catch {}
    let cwd = hashWorkspace;
    if (cwd == null) cwd = lastWorkspace(initialHost);
    const restored = restoreLayout(saved, cwd, defaultHost);
    try {
      if (localStorage.getItem("dw.terminalOpen") === "1") {
        localStorage.removeItem("dw.terminalOpen");
        if (!paneLeaves(restored.root).some((pane) => pane.terminal))
          for (const pane of paneLeaves(restored.root)) if (pane.id === restored.focusedId) pane.terminal = true;
      }
    } catch {}
    const focused = paneLeaves(restored.root).find((pane) => pane.id === restored.focusedId) || paneLeaves(restored.root)[0];
    // ?remote=<id> deep-links the focused pane's host.
    if (initialHost !== (focused.host || ""))
      return layoutReducer(restored, { type: "assign", paneId: focused.id, host: initialHost, sessionId: null, cwd: hashWorkspace ?? lastWorkspace(initialHost) });
    return restored;
  });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const panes = useMemo(() => paneLeaves(layout.root), [layout.root]);
  const focusedPane = panes.find((pane) => pane.id === layout.focusedId) || panes[0];
  const focusedHost = focusedPane.host || "";
  // Quick chat: one local scratch session as a pseudo-pane. It stays
  // subscribed while hidden, so its agent keeps streaming.
  const [quick, setQuick] = useState(() => {
    try {
      const q = JSON.parse(sessionStorage.getItem("dw.quick"));
      if (q && typeof q.sessionId === "string") return { open: !!q.open, sessionId: q.sessionId };
    } catch {}
    return { open: false, sessionId: null };
  });
  const quickRef = useRef(quick);
  quickRef.current = quick;
  useEffect(() => { try { sessionStorage.setItem("dw.quick", JSON.stringify(quick)); } catch {} }, [quick]);
  const quickKey = quick.sessionId ? sessionKey("", quick.sessionId) : null;
  const hostsInUse = useMemo(() => [...new Set([...(quick.sessionId ? [""] : []), ...panes.map((pane) => pane.host || "")])], [panes, quick.sessionId]);
  const hostsKey = hostsInUse.join("\n");
  const activeId = focusedPane.sessionId;
  const activeKey = activeId ? sessionKey(focusedHost, activeId) : null;

  // Every open pane holds a WS subscription ((host,sid) key -> target).
  // Reconnect restores the entire set, not just the focused session.
  // Replacing/closing a pane releases its subscription without interrupting
  // its backend turn.
  const subscribedRef = useRef(new Map());
  const activeRef = useRef({ id: activeId, key: activeKey, cwd: focusedPane.cwd, host: focusedHost });
  activeRef.current = { id: activeId, key: activeKey, cwd: focusedPane.cwd, host: focusedHost, quickKey: quick.open ? quickKey : null };

  const [sessionData, setSessionData] = useState(() => {
    const restored = {};
    for (const delivery of readDeliveries().values()) {
      const key = sessionKey(delivery.host, delivery.sessionId);
      restored[key] ||= emptySession();
      (restored[key].deliveries ||= []).push(delivery);
    }
    return restored;
  });
  const sessionDataRef = useRef(sessionData);
  sessionDataRef.current = sessionData;
  const [notifyEnabled, setNotifyEnabled] = useState(
    () => localStorage.getItem("devin-web.notify") === "1"
  );
  // Ref mirror so one-shot WS handlers read the latest flag.
  const notifyRef = useRef(false);
  useEffect(() => {
    notifyRef.current = notifyEnabled;
  }, [notifyEnabled]);
  const fireNotify = useCallback((title, body, tag) => {
    if (!notifyRef.current || !document.hidden) return;
    document.title = "● Agent Web";
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(title, { body, tag });
      } catch { /* ignored */ }
    }
  }, []);

  const { deliveryRef, updateDelivery, saveDeliveries } = useDeliveries({ setSessionData, notify });
  const { envs, envsRef, envOf, sessionsOf, agentsByIdOf, agentNameOf, patchEnv, mapEnvSessions, patchSession,
    refreshSessions, sessionListLoadedRef, serverRef, updateQueueRef, wsFor } =
    useHostConnections({ hostsKey, notify, setSessionData, updateDelivery, subscribedRef, deliveryRef, hostName, activeRef, fireNotify, clearSessions });

  const activeWorkspace = focusedPane.cwd || envOf(focusedHost).home || null;
  activeRef.current = { id: activeId, key: activeKey, cwd: activeWorkspace, host: focusedHost, quickKey: quick.open ? quickKey : null };
  const updateLayout = useCallback((action) => {
    const next = layoutReducer(layoutRef.current, action);
    if (next === layoutRef.current) return next;
    layoutRef.current = next;
    const pane = paneLeaves(next.root).find((item) => item.id === next.focusedId);
    const host = pane.host || "";
    activeRef.current = { id: pane.sessionId, key: pane.sessionId ? sessionKey(host, pane.sessionId) : null, cwd: pane.cwd, host };
    setLayout(next);
    if (["focus", "assign", "split", "close", "clear", "host"].includes(action.type)) {
      const params = new URLSearchParams(location.search);
      if (host) params.set("remote", host); else params.delete("remote");
      const search = params.toString() ? `?${params}` : "";
      if (location.search !== search) history.replaceState(null, "", location.pathname + search + location.hash);
      const hash = pane.sessionId ? `#/session/${encodeURIComponent(pane.sessionId)}` : pane.cwd ? `#/workspace/${encodeURIComponent(pane.cwd)}` : "";
      if (location.hash !== hash) location.hash = hash;
    }
    return next;
  }, []);
  function clearSessions(host, ids) {
    updateLayout({ type: "clear", host, ids });
    if (!(host || "") && ids?.includes(quickRef.current.sessionId)) setQuick({ open: false, sessionId: null });
  }
  const layoutSaveWarned = useRef(false);
  useEffect(() => {
    try { sessionStorage.setItem("dw.layout", JSON.stringify(layout)); }
    catch { if (!layoutSaveWarned.current) { layoutSaveWarned.current = true; notify({ kind: "warn", text: t("浏览器无法暂存布局，刷新后可能无法恢复。") }); } }
  }, [layout, notify]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("dw.sidebarCollapsed") === "1");
  useEffect(() => { try { localStorage.setItem("dw.sidebarCollapsed", sidebarCollapsed ? "1" : "0"); } catch {} }, [sidebarCollapsed]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerPaneRef = useRef(null);
  const pickerHostRef = useRef("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalBounds, setTerminalBounds] = useState(null); // paneId -> bounds
  const terminalLoaded = useRef(new Set()); // panes that ever opened a terminal
  useEffect(() => {
    const resize = () => { if (window.innerWidth > 768) setDrawerOpen(false); };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  for (const pane of panes) if (pane.terminal) terminalLoaded.current.add(pane.id);
  for (const paneId of [...terminalLoaded.current]) if (!panes.some((pane) => pane.id === paneId)) terminalLoaded.current.delete(paneId);
  const toggleTerminal = useCallback((paneId) => updateLayout({ type: "terminal", paneId }), [updateLayout]);
  const closeTerminal = useCallback((paneId) => updateLayout({ type: "terminal", paneId, open: false }), [updateLayout]);
  const [agentPref, setAgentPref] = useState(
    () => localStorage.getItem("dw.agent") || null
  );
  const pickAgent = useCallback((id) => {
    localStorage.setItem("dw.agent", id);
    setAgentPref(id);
  }, []);
  const [creating, setCreating] = useState(null); // agent id while session/new in flight

  // A host's last-used workspace, first MRU entry, or home fills its empty panes.
  useEffect(() => {
    for (const pane of panes) {
      if (pane.sessionId || pane.cwd != null) continue;
      const env = envs[pane.host || ""];
      const cwd = lastWorkspace(pane.host || "") || env?.workspaces?.[0] || env?.home;
      if (cwd) updateLayout({ type: "cwd", paneId: pane.id, cwd });
    }
  }, [panes, envs, updateLayout]);

  useEffect(() => {
    if (activeWorkspace) localStorage.setItem(environment(focusedHost).storageKey("devin-web.workspace"), activeWorkspace);
  }, [activeWorkspace, focusedHost]);

  // ---------- actions ----------
  const openWorkspace = useCallback((host, cwd, paneId = layoutRef.current.focusedId) => {
    if (!cwd) return;
    updateLayout({ type: "assign", paneId, host, sessionId: null, cwd });
    setDrawerOpen(false);
  }, [updateLayout]);

  const selectHost = useCallback((pane, id) => {
    const apply = () => updateLayout({ type: "host", paneId: pane.id, host: id, cwd: lastWorkspace(id) });
    if (!id) return apply();
    const h = remoteHostsRef.current.find((x) => x.id === id);
    if (!h || h.state === "connected") return apply();
    const connectable = h.fingerprint && !h.credentialLocked && ["disconnected", "ready", "error"].includes(h.state);
    if (!connectable) { setRemoteHostsOpen((n) => n + 1); return; }
    setConnectBusy(pane.id);
    controlApi.post(`/api/remotes/${id}/connect`)
      .then(async () => {
        const data = await controlApi.get("/api/remotes").catch(() => null);
        if (data?.hosts) setRemoteHosts(data.hosts);
        apply();
      })
      .catch(() => setRemoteHostsOpen((n) => n + 1))
      .finally(() => setConnectBusy(null));
  }, [updateLayout]);

  const selectWorkspace = useCallback(
    async (dir) => {
      const paneId = pickerPaneRef.current || layoutRef.current.focusedId;
      const host = pickerHostRef.current || "";
      try {
        const { workspaces: ws } = await environment(host).api.post("/api/workspaces", { path: dir });
        patchEnv(host, { workspaces: ws });
        openWorkspace(host, dir, paneId);
        setPickerOpen(false);
      } catch (e) {
        notify({ host, kind: "error", text: t("添加工作区失败: {v0}", { v0: e.message }) });
      }
    },
    [openWorkspace, patchEnv, notify]
  );

  const createSession = useCallback(
    async (host, cwd, agent, paneId = layoutRef.current.focusedId) => {
      const pane = paneLeaves(layoutRef.current.root).find((item) => item.id === paneId);
      const dir = cwd || pane?.cwd || envOf(host).home;
      if (!dir) { pickerPaneRef.current = paneId; pickerHostRef.current = host; setPickerOpen(true); return; }
      const agents = envOf(host).agents;
      // Global agent pref only applies when this host's registry offers it.
      const chosen = agent || (agentPref && agents.some((a) => a.id === agentPref) ? agentPref : null) || agents[0]?.id || "devin";
      setCreating(chosen);
      try {
        const res = await environment(host).api.post("/api/sessions", {
          cwd: dir,
          agent: chosen,
        });
        setDrawerOpen(false);
        const key = sessionKey(host, res.sessionId);
        setSessionData((sd) => ({
          ...sd,
          [key]: {
            ...emptySession(),
            modes: res.modes,
            configOptions: res.configOptions || [],
            cwd: dir,
            attached: true,
            historyLoading: false, // a just-created session is known to be empty
            agent: chosen,
          },
        }));
        updateLayout({ type: "assign", paneId, host, sessionId: res.sessionId, cwd: dir, focus: layoutRef.current.focusedId === paneId });
        refreshSessions(host);
      } catch (e) {
        notify({ host, kind: "error", text: t("创建会话失败: {v0}", { v0: e.message }) });
      } finally {
        setCreating(null);
      }
    },
    [agentPref, refreshSessions, updateLayout, notify]
  );

  const focusWorkspace = useCallback((cwd) => {
    if (cwd) updateLayout({ type: "cwd", cwd });
  }, [updateLayout]);

  const openSessionSplit = useCallback((host, sess, cwd, axis) => {
    const sid = sess.sessionId || sess;
    if (host === "" && quickRef.current.sessionId === sid) setQuick({ open: false, sessionId: null });
    const dir = cwd || sess.cwd || sessionDataRef.current[sessionKey(host, sid)]?.cwd || envOf(host).home;
    setDrawerOpen(false);
    updateLayout({ type: "splitOpen", axis, host, sessionId: sid, cwd: dir });
    setSessionData((sd) => ({ ...sd, [sessionKey(host, sid)]: { ...(sd[sessionKey(host, sid)] || emptySession()), cwd: dir,
      title: sess.title || sd[sessionKey(host, sid)]?.title, hasUnread: false } }));
  }, [updateLayout]);

  const pinSession = useCallback(
    async (host, sid, pinned) => {
      try {
        await environment(host).api.post(`/api/sessions/${sid}/pin`, { pinned });
        await refreshSessions(host);
      } catch (e) {
        notify({ host, kind: "error", text: t("置顶失败: {v0}", { v0: e.message }) });
      }
    },
    [refreshSessions, notify]
  );

  const archiveSession = useCallback(
    async (host, sid, archived) => {
      try {
        await environment(host).api.post(`/api/sessions/${sid}/archive`, { archived });
        await refreshSessions(host);
      } catch (e) {
        notify({ host, kind: "error", text: t("归档失败: {v0}", { v0: e.message }) });
      }
    },
    [refreshSessions, notify]
  );

  const openSession = useCallback((host, sess, paneId = layoutRef.current.focusedId) => {
    const sid = sess.sessionId || sess;
    if (host === "" && quickRef.current.sessionId === sid) setQuick({ open: false, sessionId: null });
    const pane = paneLeaves(layoutRef.current.root).find((item) => item.id === paneId);
    const key = sessionKey(host, sid);
    const cwd = sess.cwd || sessionDataRef.current[key]?.cwd || pane?.cwd || envOf(host).home;
    setDrawerOpen(false);
    updateLayout({ type: "assign", paneId, host, sessionId: sid, cwd });
    setSessionData((sd) => ({ ...sd, [key]: { ...(sd[key] || emptySession()), cwd,
      title: sess.title || sd[key]?.title, hasUnread: false } }));
  }, [updateLayout]);

  // Open a scratch session into the quick panel; if a pane already shows it,
  // focus that pane instead (no duplicate composers). Never finishes the
  // session the panel held before.
  const openQuickSession = useCallback((sess) => {
    const sid = sess.sessionId || sess;
    const pane = paneLeaves(layoutRef.current.root).find((item) => item.sessionId === sid && !(item.host || ""));
    if (pane) { updateLayout({ type: "focus", paneId: pane.id }); return; }
    const key = sessionKey("", sid);
    setQuick({ open: true, sessionId: sid });
    setSessionData((sd) => ({ ...sd, [key]: { ...(sd[key] || emptySession()), cwd: sess.cwd || sd[key]?.cwd || envOf("").home,
      title: sess.title || sd[key]?.title, hasUnread: false } }));
  }, [updateLayout]);

  // Hotkey / palette / sidebar toggle. Without the backend's scratch
  // capability nothing is created — an old server would misread the flag.
  const quickBusyRef = useRef(false);
  const toggleQuick = useCallback(async () => {
    const env = envOf("");
    if (!env.scratch) { notify({ host: "", kind: "warn", text: t("快速对话需要重启本机后端后可用") }); return; }
    if (quickRef.current.sessionId) { setQuick((q) => ({ ...q, open: !q.open })); return; }
    if (quickBusyRef.current) return;
    const agents = env.agents || [];
    const pref = getUi().quickAgent;
    const agent = (pref && agents.some((a) => a.id === pref) ? pref : null)
      || (agents.some((a) => a.id === "pi") ? "pi" : null) || agents[0]?.id || "pi";
    quickBusyRef.current = true;
    try {
      const res = await environment("").api.post("/api/sessions", { scratch: true, agent });
      const key = sessionKey("", res.sessionId);
      setSessionData((sd) => ({ ...sd, [key]: { ...emptySession(), modes: res.modes,
        configOptions: res.configOptions || [], cwd: res.cwd, attached: true,
        historyLoading: false, agent } }));
      setQuick({ open: true, sessionId: res.sessionId });
      refreshSessions("");
    } catch (e) {
      notify({ host: "", kind: "error", text: t("创建会话失败: {v0}", { v0: e.message }) });
    } finally { quickBusyRef.current = false; }
  }, [envOf, refreshSessions, notify]);
  const toggleQuickRef = useRef(toggleQuick);
  toggleQuickRef.current = toggleQuick;

  // Finish endpoint succeeded: detach the panel; 新对话 chains a fresh one.
  const finishQuick = useCallback((thenNew) => {
    setQuick({ open: false, sessionId: null });
    refreshSessions("");
    if (thenNew) void toggleQuickRef.current();
  }, [refreshSessions]);

  // Global capture-phase hotkey — fires even inside xterm/textareas.
  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat || e.isComposing || e.keyCode === 229 || hotkeyRecording.active) return;
      if (matchHotkey(e, getUi().quickKey)) { e.preventDefault(); void toggleQuickRef.current(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Re-render the palette hint / recorder state when UI prefs change.
  const [uiPrefs, setUiPrefs] = useState(getUi);
  useEffect(() => {
    const sync = () => setUiPrefs(getUi());
    window.addEventListener("dw-ui", sync);
    return () => window.removeEventListener("dw-ui", sync);
  }, []);

  // Every open pane owns a subscription, including panes hidden on mobile.
  // Closing/replacing a view only unsubscribes; it never cancels a turn.
  useEffect(() => {
    const desired = new Map(panes.filter((pane) => pane.sessionId).map((pane) =>
      [sessionKey(pane.host, pane.sessionId), { host: pane.host || "", sid: pane.sessionId, cwd: pane.cwd || envOf(pane.host || "").home }]));
    if (quickKey) desired.set(quickKey, { host: "", sid: quick.sessionId,
      cwd: sessionDataRef.current[quickKey]?.cwd || envOf("").home });
    for (const [key, sub] of subscribedRef.current) if (!desired.has(key)) {
      subscribedRef.current.delete(key);
      wsFor(sub.host)?.send({ type: "unsubscribe", sessionId: sub.sid });
    }
    for (const [key, sub] of desired) if (!subscribedRef.current.has(key)) {
      subscribedRef.current.set(key, sub);
      wsFor(sub.host)?.send({ type: "subscribe", sessionId: sub.sid, cwd: sub.cwd,
        historyToken: sessionDataRef.current[key]?.historyToken || null,
        historyBaseToken: sessionDataRef.current[key]?.historyBase?.token || null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes, envs, quickKey]);
  useEffect(() => {
    if (activeKey) setSessionData((all) => all[activeKey]?.hasUnread ? { ...all, [activeKey]: { ...all[activeKey], hasUnread: false } } : all);
  }, [activeKey]);
  useEffect(() => {
    if (quickKey && quick.open) setSessionData((all) => all[quickKey]?.hasUnread ? { ...all, [quickKey]: { ...all[quickKey], hasUnread: false } } : all);
  }, [quickKey, quick.open]);

  useDeepLink({ envs, focusedHost, activeId, panes, activeRef, updateLayout, openSession, openWorkspace,
    clearSessions, sessionsOf, sessionListLoadedRef, setDrawerOpen });

  // List refresh → backfill titles into open sessionData. A session opened
  // before its title existed (e.g. pi: title lands on first prompt) would
  // otherwise show its raw id in the header forever.
  useEffect(() => {
    setSessionData((sd) => {
      let next = sd;
      for (const [host, env] of Object.entries(envs)) {
        for (const it of env.sessions || []) {
          const key = sessionKey(host, it.sessionId);
          const cur = next[key];
          if (cur && it.title && cur.title !== it.title) {
            if (next === sd) next = { ...sd };
            next[key] = { ...cur, title: it.title };
          }
        }
      }
      return next;
    });
  }, [envs]);

  const sendPrompt = useCallback(
    (host, sessionId, blocks, { reuseId } = {}) => {
      const ws = wsFor(host);
      if (!sessionId || !ws?.open) { notify({ host, kind: "warn", text: t("连接不可用，内容已保留，请重连后发送。") }); return false; }
      if (!reuseId && deliveryRef.current.size >= 50) { notify({ host, kind: "error", text: t("请先处理待确认或失败的消息。") }); return false; }
      const id = reuseId || globalThis.crypto?.randomUUID?.() || `p${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const key = sessionKey(host, sessionId);
      const server = serverRef.current.get(host) || { ack: false, instanceId: null, dedupMs: 0 };
      const old = deliveryRef.current.get(id);
      const current = sessionDataRef.current[key] || emptySession();
      if (old && (old.sessionId !== sessionId || (old.host || "") !== host)) return false;
      const cwd = old?.cwd || current.cwd || paneLeaves(layoutRef.current.root).find((pane) => pane.sessionId === sessionId && (pane.host || "") === host)?.cwd;
      const delivery = { ...old, id, host, sessionId, cwd, blocks, text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
        at: old?.at || Date.now(), sentAt: Date.now(), phase: "sending", error: null,
        instanceId: old?.instanceId || server.instanceId, accepted: old?.accepted || false,
        wasRunning: old?.wasRunning ?? current.running };
      if (!ws.send({ type: "prompt", sessionId, cwd, blocks, requestId: id })) {
        notify({ host, kind: "warn", text: t("发送未成功，输入内容已保留。") }); return false;
      }
      deliveryRef.current.set(id, delivery);
      if (!saveDeliveries(deliveryRef.current)) notify({ host, kind: "warn", text: t("浏览器暂存空间不足，待确认消息仅保留在本页；请勿刷新。") });
      setSessionData((all) => {
        const session = all[key] || emptySession();
        const existing = session.items.some((item) => item.deliveryId === id);
        return { ...all, [key]: { ...session, running: true,
          deliveries: [...(session.deliveries || []).filter((d) => d.id !== id), delivery],
          ...(!session.running && !existing ? { lastTurn: null, streamRate: null,
            telemetry: session.telemetry ? { live: null, final: null } : null,
            items: [...session.items, { key: `opt-${id}`, kind: "user", text: delivery.text,
              images: blocks.filter((b) => b.type === "image").map((b) => `data:${b.mimeType};base64,${b.data}`),
              optimistic: true, deliveryId: id, _blocks: blocks }] } : {}),
        } };
      });
      return id;
    }, [wsFor, notify, deliveryRef, saveDeliveries]
  );

  const retryDelivery = useCallback((delivery) => {
    const host = delivery.host || "";
    const server = serverRef.current.get(host) || {};
    const safeRepeat = server.ack && delivery.instanceId === server.instanceId &&
      Date.now() - delivery.at < server.dedupMs;
    if (delivery.phase !== "failed" && !safeRepeat) {
      updateDelivery(host, delivery.sessionId, delivery.id, { phase: "uncertain", error: t("服务已变化或缺少去重确认，不能安全重发。请先检查会话，再恢复编辑。") });
      return;
    }
    const sent = sendPrompt(host, delivery.sessionId, delivery.blocks, { reuseId: delivery.phase === "failed" ? undefined : delivery.id });
    if (sent && sent !== delivery.id) updateDelivery(host, delivery.sessionId, delivery.id, { phase: "cancelled" });
  }, [sendPrompt, updateDelivery]);

  // A failed optimistic bubble → drop it and re-send the stored blocks.
  const retryPrompt = useCallback(
    (host, sid, item) => {
      if (sid) {
        const key = sessionKey(host, sid);
        setSessionData((sd) => {
          const s = sd[key];
          if (!s) return sd;
          return { ...sd, [key]: { ...s, items: s.items.filter((x) => x !== item) } };
        });
      }
      if (item._blocks?.length) sendPrompt(host, sid, item._blocks);
    },
    [sendPrompt]
  );

  // Every controller send returns false when its pane's socket is offline;
  // nothing is replayed on reconnect — the caller retries explicitly.
  const sendOr = useCallback((host, msg) => {
    const ok = wsFor(host)?.send(msg) || false;
    if (!ok) notify({ host, kind: "warn", text: t("连接不可用，操作未发送，请重连后重试") });
    return ok;
  }, [wsFor, notify]);

  const cancelPrompt = useCallback((host, sessionId) => {
    return sessionId ? sendOr(host, { type: "cancel", sessionId }) : false;
  }, [sendOr]);
  const dequeuePrompt = useCallback((host, sessionId, queueId) => {
    return sessionId ? sendOr(host, { type: "queue_remove", sessionId, queueId }) : false;
  }, [sendOr]);

  const [forkBusy, setForkBusy] = useState({});
  const forkRequests = useRef(new Set());
  const forkSession = useCallback(async (host, sid, paneId, stepIndex) => {
    const key = sessionKey(host, sid);
    if (!sid || forkRequests.current.has(key)) return;
    forkRequests.current.add(key); setForkBusy((busy) => ({ ...busy, [key]: true }));
    try {
      const cwd = sessionDataRef.current[key]?.cwd || paneLeaves(layoutRef.current.root).find((pane) => pane.id === paneId)?.cwd;
      const result = await environment(host).api.post(`/api/sessions/${sid}/fork`, { stepIndex, cwd });
      await refreshSessions(host);
      if (result?.sessionId) updateLayout({ type: "assign", paneId, host, sessionId: result.sessionId, cwd, focus: layoutRef.current.focusedId === paneId });
    } catch (error) { notify({ host, kind: "error", text: t("分叉失败: {v0}", { v0: error.message }) }); }
    finally { forkRequests.current.delete(key); setForkBusy((busy) => ({ ...busy, [key]: false })); }
  }, [refreshSessions, updateLayout, notify]);

  // Injections are session-bound, so focusing another pane cannot discard or
  // redirect an edit while a menu/async delivery response is in flight.
  const [composerInjects, setComposerInjects] = useState({});
  // Content-search handoff: sidebar hit → open pane's transcript search prefilled.
  const [searchRequests, setSearchRequests] = useState({});
  const injectComposer = useCallback((host, sid, text) => {
    setComposerInjects((all) => ({ ...all, [sessionKey(host, sid)]: { text: text || "", n: `${Date.now()}-${Math.random()}`, sessionId: sid } }));
  }, []);
  const treeRequests = useRef(new Set());
  const [treeBusy, setTreeBusy] = useState({});
  const navigateTree = useCallback(async (host, sid, options) => {
    const key = sessionKey(host, sid), env = environment(host), before = readDraft(sid, env);
    if (!wsFor(host)?.open) throw new Error(t("连接不可用，操作未发送，请重连后重试"));
    if (treeRequests.current.has(key)) throw new Error(t("会话树正在切换，请等待完成"));
    if ((before.text || before.images.length || before.files.length || before.refs.size) && !options.replaceDraft)
      throw new Error(t("请先确认替换当前草稿"));
    treeRequests.current.add(key); setTreeBusy((all) => ({ ...all, [key]: true }));
    const instanceId = serverRef.current.get(host)?.instanceId || null;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 180000);
    try {
      const result = await env.api.post(`/api/sessions/${encodeURIComponent(sid)}/tree/navigate`, {
        targetId: options.targetId, version: options.version, summarize: options.summarize,
      }, { signal: controller.signal });
      if (typeof result?.cancelled !== "boolean" || (!result.cancelled &&
          (typeof result.editorText !== "string" || !result.leafId || typeof result.leafId !== "string" || !/^[a-f0-9]{64}$/.test(result.version || "") || !Number.isSafeInteger(result.historyGen) || result.historyGen < 1)))
        throw new Error(t("切换结果未确认，请刷新会话树核对；不会自动重试。"));
      if (!result.cancelled) {
        setSessionData((all) => {
          const current = all[key];
          if (!current || (current.gen ?? -1) >= result.historyGen || (serverRef.current.get(host)?.instanceId || null) !== instanceId) return all;
          return { ...all, [key]: { ...current, historyLoading: true, treeHistory: { gen: result.historyGen, instanceId, connectionId: wsFor(host)?.connectionId } } };
        });
        // Survives closing/switching the pane while the request is pending;
        // never redirects the response to whichever pane is now focused.
        if (readDraft(sid, env) === before) {
          const warning = saveDraft({ ...emptyDraft(sid), text: result.editorText || "" }, env);
          if (warning) notify({ host, kind: "warn", text: warning });
          setComposerInjects((all) => ({ ...all, [key]: { sessionId: sid, text: result.editorText || "", replaceDraft: true, n: `${Date.now()}-${Math.random()}` } }));
        } else notify({ host, kind: "warn", text: t("分支已切换，但草稿已变更，未覆盖；请从节点预览复制原文。") });
        notify({ host, kind: "ok", text: t("已切换会话分支，旧分支保留；未回滚文件。") });
      }
      return result;
    } catch (error) {
      // A closed HTTP channel is not evidence of rollback. No automatic
      // resend, even after reconnect; refresh is strictly read-only.
      if (!error.status || error.outcomeUnknown || error.status >= 500)
        error = new Error(t("切换结果未确认，请刷新会话树核对；不会自动重试。"));
      notify({ host, kind: "error", text: error.message });
      throw error;
    } finally {
      clearTimeout(timer); treeRequests.current.delete(key);
      setTreeBusy((all) => { const next = { ...all }; delete next[key]; return next; });
    }
  }, [wsFor, notify, serverRef]);
  const editQueuedPrompt = useCallback((host, sid, queue) => {
    if (!sid || !queue?.id) return;
    // Only pull the text back into the composer when the dequeue actually
    // left the wire — otherwise the prompt would exist in both places.
    if (!dequeuePrompt(host, sid, queue.id)) return;
    injectComposer(host, sid, queue.text);
  }, [dequeuePrompt, injectComposer]);
  const setConfig = useCallback((host, sessionId, configId, value) => {
    return sessionId ? sendOr(host, { type: "set_config_option", sessionId, configId, value }) : false;
  }, [sendOr]);

  const answerPermission = useCallback((host, requestId, optionId) => {
    return sendOr(host, {
      type: "permission_response",
      requestId,
      optionId,
      cancelled: optionId == null,
    });
  }, [sendOr]);

  const answerElicitation = useCallback((host, requestId, action, content) => {
    return sendOr(host, { type: "elicitation_response", requestId, action, content });
  }, [sendOr]);

  const deleteSession = useCallback(
    async (host, sid, options) => {
      try {
        await environment(host).deleteSessionsVerified([sid], options);
        mapEnvSessions(host, (list) => list.filter((s) => s.sessionId !== sid));
        clearSessions(host, [sid]);
      } catch (e) {
        notify({ host, kind: "error", text: t("{v0}: {v1}", { v0: e.outcomeUnknown ? t("删除结果待核对") : t("删除会话失败"), v1: e.message }) });
        throw e;
      }
    },
    [mapEnvSessions, notify]
  );

  const deleteSessions = useCallback(
    async (host, ids, options) => {
      const set = new Set(ids);
      try {
        await environment(host).deleteSessionsVerified(ids, options);
        mapEnvSessions(host, (list) => list.filter((s) => !set.has(s.sessionId)));
        setSessionData((sd) => {
          const n = { ...sd };
          for (const id of ids) delete n[sessionKey(host, id)];
          return n;
        });
        clearSessions(host, ids);
      } catch (e) {
        if (e.deletedIds?.length) {
          const confirmed = new Set(e.deletedIds);
          mapEnvSessions(host, (list) => list.filter((session) => !confirmed.has(session.sessionId)));
          clearSessions(host, e.deletedIds);
        }
        notify({ host, kind: "error", text: t("{v0}: {v1}", { v0: e.outcomeUnknown ? t("批量删除结果待核对") : t("批量删除失败"), v1: e.message }) });
        throw e;
      }
    },
    [mapEnvSessions, notify]
  );

  const renameSession = useCallback(
    async (host, sid, title) => {
      try {
        await environment(host).api.post(`/api/sessions/${sid}/rename`, { title });
        patchSession(sessionKey(host, sid), { title });
        refreshSessions(host);
      } catch (e) {
        notify({ host, kind: "error", text: t("重命名失败: {v0}", { v0: e.message }) });
      }
    },
    [patchSession, refreshSessions, notify]
  );

  const releaseSession = useCallback(
    async (host, sid) => {
      try {
        await environment(host).api.post(`/api/sessions/${sid}/close`);
        patchSession(sessionKey(host, sid), { attached: false });
        refreshSessions(host);
      } catch (e) {
        notify({ host, kind: "error", text: t("释放失败: {v0}", { v0: e.message }) });
      }
    },
    [patchSession, refreshSessions, notify]
  );

  const retryAttach = useCallback(
    (host, sid, cwd) => {
      const key = sessionKey(host, sid);
      const sent = sendOr(host, { type: "subscribe", sessionId: sid, cwd });
      if (!sent) return false;
      patchSession(key, { lockError: null, lockCode: null });
      subscribedRef.current.set(key, { host, sid, cwd });
      return true;
    },
    [patchSession, sendOr]
  );

  // ---------- reconnect notice (tracks the focused pane's socket) ----------
  const wsUp = envs[focusedHost]?.wsUp || false;
  const wasUpRef = useRef(false);
  const everUpRef = useRef(false);
  const trackedHostRef = useRef(focusedHost);
  useEffect(() => {
    if (trackedHostRef.current !== focusedHost) {
      // Focus moved to another environment: resync silently, never toast.
      trackedHostRef.current = focusedHost;
      wasUpRef.current = wsUp;
      if (wsUp) everUpRef.current = true;
      return;
    }
    if (!wsUp && wasUpRef.current) {
      notify({ host: focusedHost, kind: "warn", sticky: true, id: `conn:${focusedHost}`, text: t("连接已断开，正在重连…") });
    } else if (wsUp && !wasUpRef.current && everUpRef.current) {
      notify({ host: focusedHost, kind: "ok", id: `conn:${focusedHost}`, text: t("连接已恢复") });
    }
    if (wsUp) everUpRef.current = true;
    wasUpRef.current = wsUp;
  }, [wsUp, focusedHost, notify]);

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
    for (const [key, s] of Object.entries(sessionData)) {
      const prev = prevRunRef.current.get(key);
      prevRunRef.current.set(key, !!s.running);
      if (prev === true && !s.running && document.hidden && notifyEnabled) {
        const { host, sessionId } = parseSessionKey(key);
        document.title = "● " + baseTitle;
        if ("Notification" in window && Notification.permission === "granted") {
          try {
            new Notification(t("{v0} 完成了任务", { v0: agentNameOf(host, sessionId) }), {
              body: sessionsOf(host).find((x) => x.sessionId === sessionId)?.title || s.title || sessionId,
              tag: "devin-done-" + key,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionData, notifyEnabled, envs]);

  // ---------- export transcript ----------
  const exportSession = useCallback(
    async (host, sid, fmt = "md") => {
      try {
        const key = sessionKey(host, sid);
        let items = sessionDataRef.current[key]?.items;
        let meta = sessionDataRef.current[key] || {};
        if (!items?.length) {
          const h = await environment(host).api.get(`/api/sessions/${sid}/history`);
          items = foldEvents(h.events || []).items;
          if (!items.length) {
            notify({ host, kind: "warn", text: t("该会话没有可导出的内容") });
            return;
          }
        }
        // Cached transcripts may carry deferred binary fields. Fail explicitly
        // rather than exporting placeholders or a partial raw tool result.
        items = await hydrateHistoryImages(items, environment(host).api);
        const title = sessionsOf(host).find((x) => x.sessionId === sid)?.title || meta.title || sid;
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
            buildMarkdown(items, { title, sessionId: sid, cwd: meta.cwd, agent: agentNameOf(host, sid) })
          );
        }
        notify({ host, kind: "ok", text: t("已导出 {v0}", { v0: fmt === "json" ? "JSON" : "Markdown" }) });
      } catch (e) {
        notify({ host, kind: "error", text: t("导出失败: {v0}", { v0: e.message }) });
      }
    },
    [notify]
  );

  const paneController = useMemo(() => ({ sendPrompt, cancelPrompt, dequeuePrompt, editQueuedPrompt, setComposerInjects, setSearchRequests,
    injectComposer, navigateTree, forkSession, setConfig, retryPrompt, updateDelivery, exportSession, answerPermission, answerElicitation,
    retryAttach, retryDelivery, releaseSession, toggleTerminal, openDrawer: () => setDrawerOpen(true), openPalette: () => setPaletteOpen(true) }),
  [sendPrompt, cancelPrompt, dequeuePrompt, editQueuedPrompt, injectComposer, navigateTree, forkSession, setConfig, retryPrompt, updateDelivery,
    exportSession, answerPermission, answerElicitation, retryAttach, retryDelivery, releaseSession, toggleTerminal]);

  const session = activeKey ? sessionData[activeKey] || emptySession() : null;
  const focusedEnv = envs[focusedHost] || emptyEnv();
  // Sessions that received new content while not active — sidebar badge set,
  // filtered to the focused pane's host and exposed as raw session ids.
  const unreadIds = useStableSet(useMemo(
    () =>
      new Set(
        Object.entries(sessionData)
          .filter(([key, s]) => s.hasUnread && parseSessionKey(key).host === focusedHost)
          .map(([key]) => parseSessionKey(key).sessionId)
      ),
    [sessionData, focusedHost]
  ));

  const attentionIds = useStableSet(useMemo(() => new Set(Object.entries(sessionData)
    .filter(([key, s]) => (s.pendingPermissions?.length || s.pendingElicitations?.length) && parseSessionKey(key).host === focusedHost)
    .map(([key]) => parseSessionKey(key).sessionId)), [sessionData, focusedHost]));

  // Pane markers: attention while a card awaits input in that pane, done
  // once a turn finished while it was unfocused (cleared on focus).
  const [donePanes, setDonePanes] = useState(() => new Set());
  const paneRunRef = useRef(new Map());
  useEffect(() => {
    setDonePanes((done) => {
      let next = done;
      for (const pane of panes) {
        const key = pane.sessionId && sessionKey(pane.host, pane.sessionId);
        const running = key ? !!sessionData[key]?.running : false;
        const was = paneRunRef.current.get(key);
        paneRunRef.current.set(key, running);
        if (was === true && !running && pane.id !== layout.focusedId) {
          if (next === done) next = new Set(done);
          next.add(pane.id);
        }
        if (pane.id === layout.focusedId && next.has(pane.id)) {
          if (next === done) next = new Set(done);
          next.delete(pane.id);
        }
      }
      return next;
    });
  }, [sessionData, panes, layout.focusedId]);
  const paneStatus = useMemo(() => {
    const map = {};
    for (const pane of panes) {
      if (!pane.sessionId) continue;
      const s = sessionData[sessionKey(pane.host, pane.sessionId)];
      map[pane.id] = (s?.pendingPermissions?.length || s?.pendingElicitations?.length) ? "attention"
        : pane.id !== layout.focusedId && donePanes.has(pane.id) ? "done" : null;
    }
    return map;
  }, [panes, sessionData, layout.focusedId, donePanes]);

  const openPicker = useCallback((pane) => {
    pickerPaneRef.current = pane?.id || layoutRef.current.focusedId;
    pickerHostRef.current = pane?.host || "";
    setDrawerOpen(false);
    setPickerOpen(true);
  }, []);

  // ---------- command palette (Cmd/Ctrl+K) ----------
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.code === "Backquote") {
        e.preventDefault();
        toggleTerminal(layoutRef.current.focusedId);
        return;
      }
      if (e.target.closest?.(".terminal-panel")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.isComposing || hasActiveLayer()) return;
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === "Backslash") {
        e.preventDefault();
        updateLayout({ type: "split", axis: e.shiftKey ? "column" : "row" });
        return;
      }
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (e.code === "KeyW") {
          e.preventDefault();
          updateLayout({ type: "close" });
          return;
        }
        const dir = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[e.key];
        if (dir) {
          const geo = layoutGeometry(layoutRef.current.root, document.querySelector(".split-canvas")?.clientWidth || window.innerWidth, document.querySelector(".split-canvas")?.clientHeight || window.innerHeight);
          const next = neighborPane(geo.panes, layoutRef.current.focusedId, dir);
          if (next) { e.preventDefault(); updateLayout({ type: "focus", paneId: next }); }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTerminal, updateLayout]);

  // A Files drop outside a chat pane would navigate the browser and lose the
  // page; suppress it without touching text/link drags.
  useEffect(() => {
    const guard = (e) => {
      if (e.dataTransfer?.types?.includes("Files") && !e.target.closest?.(".chat")) e.preventDefault();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => { window.removeEventListener("dragover", guard); window.removeEventListener("drop", guard); };
  }, []);

  const paletteActions = useMemo(
    () => [
      ...(focusedEnv.agents.length > 1
        ? focusedEnv.agents.map((a) => ({
            id: `new-${a.id}`,
            title: t("新建 {v0} 会话", { v0: a.name }),
            run: () => createSession(focusedHost, undefined, a.id),
          }))
        : [{ id: "new", title: t("新建会话"), run: () => createSession(focusedHost) }]),
      {
        id: "focus",
        title: t("聚焦输入框"),
        run: () => document.querySelector(".chat-pane.focused .input-ta")?.focus(),
      },
      ...(activeId
        ? [
            { id: "export", title: t("导出当前会话 (Markdown)"), run: () => exportSession(focusedHost, activeId) },
            {
              id: "notify",
              title: notifyEnabled ? t("关闭完成通知") : t("开启完成通知"),
              run: () => toggleNotify(),
            },
          ]
        : []),
      { id: "drawer", title: t("打开会话列表"), run: () => { setSidebarCollapsed(false); setDrawerOpen(window.innerWidth <= 768); } },
      { id: "split-row", title: t("左右拆分当前窗格"), run: () => updateLayout({ type: "split", axis: "row" }) },
      { id: "split-column", title: t("上下拆分当前窗格"), run: () => updateLayout({ type: "split", axis: "column" }) },
      { id: "close-pane", title: t("关闭当前窗格"), run: () => updateLayout({ type: "close" }) },
      ...["left", "right", "up", "down"].map((dir) => ({ id: `pane-${dir}`, title: t("聚焦{v0}侧窗格", { v0: { left: t("左"), right: t("右"), up: t("上"), down: t("下") }[dir] }),
        run: () => {
          const geo = layoutGeometry(layoutRef.current.root, document.querySelector(".split-canvas")?.clientWidth || window.innerWidth, document.querySelector(".split-canvas")?.clientHeight || window.innerHeight);
          const next = neighborPane(geo.panes, layoutRef.current.focusedId, dir);
          if (next) updateLayout({ type: "focus", paneId: next });
        } })),
      { id: "quick", title: t("快速对话"), hint: uiPrefs.quickKey, run: () => void toggleQuickRef.current() },
      { id: "terminal", title: focusedPane.terminal ? t("收起终端") : t("打开工作区终端"), run: () => toggleTerminal(focusedPane.id) },
    ],
    [createSession, focusedEnv, focusedHost, exportSession, activeId, notifyEnabled, toggleNotify, focusedPane, toggleTerminal, uiPrefs]
  );

  const titles = useMemo(() => {
    const map = {};
    for (const [host, env] of Object.entries(envs))
      for (const item of env.sessions || []) map[sessionKey(host, item.sessionId)] = item.title || item.sessionId;
    return map;
  }, [envs]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hostNames = useMemo(() => Object.fromEntries(hostsInUse.map((h) => [h, hostName(h)])), [hostsInUse, remoteHosts]);

  // ---------- bounded session cache ----------
  // Transcripts for sessions no pane shows age out; an unread badge survives.
  const lastSeenRef = useRef(new Map());
  const prevPaneKeysRef = useRef(new Set());
  useEffect(() => {
    prevPaneKeysRef.current = stampSeen(lastSeenRef.current, prevPaneKeysRef.current,
      [...panes.filter((pane) => pane.sessionId).map((pane) => sessionKey(pane.host, pane.sessionId)),
        ...(quickKey ? [quickKey] : [])], Date.now());
  }, [panes, quickKey]);
  useEffect(() => {
    const sweep = () => {
      const now = Date.now();
      const paneKeys = panes.filter((pane) => pane.sessionId).map((pane) => sessionKey(pane.host, pane.sessionId));
      if (quickKey) paneKeys.push(quickKey);
      for (const key of evictableKeys({ keys: Object.keys(sessionDataRef.current), paneKeys, lastSeen: lastSeenRef.current, now,
        deliveries: [...deliveryRef.current.values()], sessions: sessionDataRef.current })) {
        const old = sessionDataRef.current[key];
        if (treeRequests.current.has(key)) continue;
        setSessionData((sd) => {
          if (!sd[key]) return sd;
          const n = { ...sd };
          delete n[key];
          if (old?.hasUnread) n[key] = { ...emptySession(), hasUnread: true, title: old.title, evicted: true };
          return n;
        });
        updateQueueRef.current.delete(key);
        lastSeenRef.current.delete(key);
        prevRunRef.current.delete(key);
        forkRequests.current.delete(key);
        setForkBusy((busy) => key in busy ? { ...busy, [key]: false } : busy);
        setComposerInjects((all) => key in all ? { ...all, [key]: null } : all);
      }
    };
    const timer = setInterval(sweep, 60000);
    return () => clearInterval(timer);
  }, [panes, updateQueueRef, deliveryRef]);

  const usageProvider = session?.configOptions?.find((c) => c.category === "model" || /model/i.test(c.id || ""))?.currentValue?.split("/")[0] || null;
  const sidebarAgents = agentsByIdOf(focusedHost);
  const localAgents = [...(agentsByIdOf("") || new Map()).values()];
  const quickDot = (() => {
    const s = quickKey ? sessionData[quickKey] : null;
    if (!s) return null;
    if (s.pendingPermissions?.length || s.pendingElicitations?.length) return "attention";
    if (s.running) return "running";
    return !quick.open && s.hasUnread ? "unread" : null;
  })();
  const remoteInUse = hostsInUse.some(Boolean);
  const sidebar = useMemo(() => (
    <EnvironmentContext.Provider value={environment(focusedHost)} key={focusedHost}>
        <Sidebar
          environmentControl={<RemoteHosts currentHost={focusedHost} wsUp={wsUp} poll={remoteInUse}
            onEnter={(id) => updateLayout({ type: "assign", paneId: layoutRef.current.focusedId, host: id, sessionId: null, cwd: lastWorkspace(id) })}
            onHosts={setRemoteHosts} openRequest={remoteHostsOpen} />}
          sessions={focusedEnv.sessions}
          loading={focusedEnv.loading}
          activeId={activeId}
          activeWorkspace={activeWorkspace}
          home={focusedEnv.home}
          collapsedSidebar={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
          wsUp={wsUp}
          drawerOpen={drawerOpen}
          onCloseDrawer={() => setDrawerOpen(false)}
          onPickWorkspace={() => openPicker()}
          onFocusWorkspace={focusWorkspace}
          onOpenWorkspace={(cwd) => openWorkspace(focusedHost, cwd)}
          onNewSession={(cwd, agent) => createSession(focusedHost, cwd, agent)}
          onOpenSession={(sess) => openSession(focusedHost, sess)}
          onSearchOpen={(hit, q) => {
            openSession(focusedHost, hit);
            setSearchRequests((all) => ({ ...all, [sessionKey(focusedHost, hit.sessionId)]: { q, n: `${Date.now()}` } }));
          }}
          onOpenSessionSplit={(sess, cwd, axis) => openSessionSplit(focusedHost, sess, cwd, axis)}
          onDeleteSession={(sid, options) => deleteSession(focusedHost, sid, options)}
          onDeleteSessions={(ids, options) => deleteSessions(focusedHost, ids, options)}
          onRenameSession={(sid, title) => renameSession(focusedHost, sid, title)}
          onReleaseSession={(sid) => releaseSession(focusedHost, sid)}
          onExportSession={(sid, fmt) => exportSession(focusedHost, sid, fmt)}
          onPinSession={(sid, pinned) => pinSession(focusedHost, sid, pinned)}
          onArchiveSession={(sid, archived) => archiveSession(focusedHost, sid, archived)}
          unreadIds={unreadIds}
          attentionIds={attentionIds}
          agentsById={sidebarAgents}
          onOpenQuick={openQuickSession}
          onToggleQuick={toggleQuick}
          quickDot={quickDot}
          quickSessionId={quick.sessionId}
          localAgents={localAgents}
          usageAgent={activeId ? focusedEnv.sessions.find((s) => s.sessionId === activeId)?.agent : null}
          usageProvider={usageProvider}
          onPickAgent={pickAgent}
          creating={creating}
          notifyEnabled={notifyEnabled}
          onToggleNotify={toggleNotify}
        />
      </EnvironmentContext.Provider>
  ), [focusedHost, wsUp, remoteInUse, remoteHostsOpen, focusedEnv, activeId, activeWorkspace, sidebarCollapsed,
    drawerOpen, openPicker, focusWorkspace, openWorkspace, createSession, openSession, openSessionSplit, deleteSession,
    deleteSessions, renameSession, releaseSession, exportSession, pinSession, archiveSession, unreadIds, attentionIds,
    sidebarAgents, usageProvider, pickAgent, creating, notifyEnabled, toggleNotify, updateLayout,
    openQuickSession, toggleQuick, quickDot, quick.sessionId]);
  const openPaletteSession = useCallback((sid) => openSession(focusedHost, sid), [focusedHost, openSession]);

  return (
    <div className="app">
      {drawerOpen && <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} />}
      {sidebar}
      <main className="main">
        {notices.length > 0 && <div className="notice-stack">
          {notices.map((n) => <div key={n.id} className={n.kind === "error" ? "banner" : `toast ${n.kind === "ok" ? "ok" : n.kind === "warn" ? "warn" : ""}`} role="status">
            {n.kind === "error" && <AlertCircle size={15} />}
            {n.host && <span className="notice-host">{hostName(n.host)}</span>}
            <span className="banner-msg">{n.text}</span>
            {n.count > 1 && <span className="notice-count">×{n.count}</span>}
            {n.reload && <button className="icon-ghost" onClick={() => location.reload()} title={t("刷新页面")}>
              <RotateCw size={14} />
            </button>}
            <button className="icon-ghost" onClick={() => dismiss(n.id)} title={t("关闭")}>
              <X size={14} />
            </button>
          </div>)}
        </div>}
        <div className="workspace-body">
        <SplitWorkspace onTerminalBounds={setTerminalBounds} layout={layout} onAction={updateLayout} titles={titles} hostNames={hostNames} paneStatus={paneStatus} renderPane={(pane, focused) => {
          const host = pane.host || "";
          const sid = pane.sessionId, key = sid ? sessionKey(host, sid) : null;
          const paneEnv = envs[host] || emptyEnv();
          const data = sid ? sessionData[key] || emptySession() : null;
          const agent = paneEnv.sessions.find((item) => item.sessionId === sid)?.agent || data?.agent || "devin";
          const content = data ? <ErrorBoundary resetKey={key}>
            <PaneChat key={sid} host={host} paneId={pane.id} sessionId={sid} controller={paneController} session={data} focused={focused} wsUp={paneEnv.wsUp}
              agentName={agentsByIdOf(host).get(agent)?.name || "Devin"} environmentName={hostName(host)} remote={!!host} home={paneEnv.home}
              composerInject={composerInjects[key]} searchRequest={searchRequests[key]} canFork={!!agentsByIdOf(host).get(agent)?.caps?.fork}
              canTree={agent === "pi"} canProcesses={!!agentsByIdOf(host).get(agent)?.caps?.processes} treeBusy={!!treeBusy[key] || !!(data.treeHistory && data.historyLoading)} forkBusy={!!forkBusy[key]} terminalOpen={!!pane.terminal} />
          </ErrorBoundary> : <Welcome host={host} hosts={remoteHosts} busy={connectBusy === pane.id} onSelectHost={(id) => selectHost(pane, id)}
            environmentName={host ? hostName(host) : null} sessions={paneEnv.sessions} loading={paneEnv.loading}
            activeWorkspace={pane.cwd || paneEnv.home} home={paneEnv.home} wsUp={paneEnv.wsUp} creating={creating} agents={paneEnv.agents} agentPref={agentPref}
            onPickAgent={pickAgent} onNewSession={(cwd, agent) => createSession(host, cwd, agent, pane.id)}
            onOpenWorkspace={(cwd) => openWorkspace(host, cwd, pane.id)} onOpenSession={(sess) => openSession(host, sess, pane.id)}
            onPickWorkspace={() => openPicker(pane)} onOpenDrawer={() => setDrawerOpen(true)} onToggleTerminal={() => toggleTerminal(pane.id)} terminalOpen={!!pane.terminal} />;
          return <EnvironmentContext.Provider value={environment(host)}>{content}</EnvironmentContext.Provider>;
        }} />
        {[...terminalLoaded.current].map((paneId) => {
          const pane = panes.find((item) => item.id === paneId);
          // Mobile shows a single pane at a time, hence only its terminal.
          if (!pane || (window.innerWidth <= 768 && paneId !== layout.focusedId)) return null;
          const host = pane.host || "";
          const cwd = pane.cwd || envOf(host).home;
          const open = !!pane.terminal;
          const bounds = terminalBounds?.[paneId];
          const fallback = open ? <div className="terminal-frame open" style={bounds ? {
            "--terminal-left": `${bounds.left}px`, "--terminal-top": `${bounds.top}px`,
            "--terminal-pane-width": `${bounds.width}px`, "--terminal-pane-height": `${bounds.height}px`,
          } : {}}><aside className="terminal-panel terminal-loading">{t("正在加载终端…")}<button onClick={() => closeTerminal(paneId)}>{t("收起")}</button></aside></div> : null;
          return <ErrorBoundary key={paneId} resetKey={`${paneId}\n${host}\n${cwd}`}>
            <React.Suspense fallback={fallback}>
              <TerminalPanel open={open} bounds={bounds} environment={environment(host)} environmentName={host ? hostName(host) : null} cwd={cwd} onClose={() => closeTerminal(paneId)} />
            </React.Suspense>
          </ErrorBoundary>;
        })}
        {quick.sessionId && (() => {
          const qEnv = envs[""] || emptyEnv();
          const qData = sessionData[quickKey] || emptySession();
          const qAgent = qEnv.sessions.find((item) => item.sessionId === quick.sessionId)?.agent || qData.agent || "pi";
          return (
            <EnvironmentContext.Provider value={environment("")}>
              <QuickChat open={quick.open} sessionId={quick.sessionId} session={qData}
                agentName={agentsByIdOf("").get(qAgent)?.name || qAgent}
                onHide={() => setQuick((q) => ({ ...q, open: false }))}
                onOpenInPane={() => openSession("", { sessionId: quick.sessionId, cwd: qData.cwd })}
                onFinished={finishQuick}
                notify={notify}>
                <ErrorBoundary resetKey={quickKey}>
                  <PaneChat host="" paneId="quick" quickMode sessionId={quick.sessionId} controller={paneController}
                    session={qData} focused={quick.open} wsUp={qEnv.wsUp}
                    agentName={agentsByIdOf("").get(qAgent)?.name || qAgent} environmentName={hostName("")} home={qEnv.home}
                    composerInject={composerInjects[quickKey]} searchRequest={searchRequests[quickKey]}
                    canFork={false} canTree={qAgent === "pi"} canProcesses={!!agentsByIdOf("").get(qAgent)?.caps?.processes}
                    treeBusy={!!treeBusy[quickKey] || !!(qData.treeHistory && qData.historyLoading)} forkBusy={!!forkBusy[quickKey]} />
                </ErrorBoundary>
              </QuickChat>
            </EnvironmentContext.Provider>
          );
        })()}
        </div>
      </main>
      {pickerOpen && (
        <EnvironmentContext.Provider value={environment(pickerHostRef.current || "")}>
          <WorkspacePicker
            initial={activeWorkspace || focusedEnv.home}
            onClose={() => setPickerOpen(false)}
            onSelect={selectWorkspace}
          />
        </EnvironmentContext.Provider>
      )}
      <EnvironmentContext.Provider value={environment(focusedHost)}>
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          sessions={focusedEnv.sessions}
          actions={paletteActions}
          onOpenSession={openPaletteSession}
        />
      </EnvironmentContext.Provider>
    </div>
  );
}
