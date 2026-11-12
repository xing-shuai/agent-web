// Bounded sessionData: entries for sessions no pane shows age out of the
// cache; reopening goes through the normal subscribe -> history path.

// Refresh last-seen stamps: current pane keys stay fresh, and a key that just
// left the pane set gets stamped at departure so its idle clock starts at
// close time, not at the last render while still open.
export function stampSeen(lastSeen, prevKeys, currentKeys, now) {
  const current = new Set(currentKeys);
  for (const key of current) lastSeen.set(key, now);
  for (const key of prevKeys) if (!current.has(key)) lastSeen.set(key, now);
  return current;
}
export function evictableKeys({ keys, paneKeys, lastSeen, now, deliveries = [], sessions = {}, idleMs = 300000 }) {
  const panes = new Set(paneKeys);
  const busy = new Set();
  for (const d of deliveries) if (!["completed", "cancelled"].includes(d.phase)) busy.add(`${d.host || ""}\n${d.sessionId}`);
  return [...keys].filter((key) =>
    !panes.has(key) &&
    now - (lastSeen.get(key) || 0) >= idleMs &&
    !busy.has(key) &&
    !sessions[key]?.evicted &&
    !(sessions[key]?.pendingPermissions?.length || sessions[key]?.pendingElicitations?.length));
}
