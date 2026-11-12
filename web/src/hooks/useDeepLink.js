import { useEffect, useRef } from "react";

// ---------- deep links ----------
// #/session/<id> opens that session once the list has loaded; navigating
// back/forward via hash changes re-applies the link. The ?remote param is
// the focused pane's host — links on another host open on that host.
export default function useDeepLink({ envs, focusedHost, activeId, panes, activeRef, updateLayout, openSession, openWorkspace, clearSessions, sessionsOf, sessionListLoadedRef, setDrawerOpen }) {
  useEffect(() => {
    const onHash = () => {
      const host = new URLSearchParams(location.search).get("remote") || "";
      const workspace = location.hash.match(/^#\/workspace\/(.+)$/);
      if (workspace) {
        try {
          const cwd = decodeURIComponent(workspace[1]);
          if (activeRef.current.id || activeRef.current.cwd !== cwd || activeRef.current.host !== host) openWorkspace(host, cwd);
        } catch {}
        return;
      }
      const m = location.hash.match(/^#\/session\/(.+)$/);
      if (!m) {
        if (!location.hash && activeRef.current.id) {
          updateLayout({ type: "assign", sessionId: null }); setDrawerOpen(false);
        }
        return;
      }
      let sid;
      try { sid = decodeURIComponent(m[1]); } catch { return; }
      if (host === activeRef.current.host) {
        const sess = sessionsOf(host).find((s) => s.sessionId === sid);
        if (sess && activeRef.current.id !== sid) openSession(host, sess);
      } else openSession(host, { sessionId: sid });
    };
    window.addEventListener("hashchange", onHash);
    onHash();
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envs, openSession, openWorkspace]);

  // Wait for the list before discarding a missing session link. On refresh,
  // activeId starts empty even for a valid link that the effect above restores.
  useEffect(() => {
    const env = envs[focusedHost];
    if (activeId || !env || env.loading || !location.hash.startsWith("#/session/")) return;
    const linked = location.hash.slice("#/session/".length);
    if (!env.sessions.some((s) => encodeURIComponent(s.sessionId) === linked))
      history.replaceState(null, "", location.pathname + location.search);
  }, [activeId, envs, focusedHost]);

  const restoredSessionsRef = useRef(null);
  if (!restoredSessionsRef.current) {
    restoredSessionsRef.current = new Map();
    for (const pane of panes) if (pane.sessionId) {
      const list = restoredSessionsRef.current.get(pane.host || "") || [];
      list.push(pane.sessionId);
      restoredSessionsRef.current.set(pane.host || "", list);
    }
  }
  useEffect(() => {
    if (!restoredSessionsRef.current.size) return;
    for (const [host, ids] of restoredSessionsRef.current) {
      const env = envs[host];
      if (!env || env.loading || !sessionListLoadedRef.current.has(host)) continue;
      const missing = ids.filter((sid) => !env.sessions.some((item) => item.sessionId === sid));
      restoredSessionsRef.current.delete(host);
      if (missing.length) clearSessions(host, missing);
    }
  }, [envs, clearSessions, sessionListLoadedRef]);
}
