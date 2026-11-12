// A flat set of keyed pane views sits over this tree. Changing the tree must
// never remount unrelated composers, reset their scroll, or cancel their turns.
const id = () => globalThis.crypto?.randomUUID?.() || `pane-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const newPane = (cwd = null, host = "") => ({ id: id(), host, sessionId: null, cwd });
export const paneLeaves = (node) => node.children ? node.children.flatMap(paneLeaves) : [node];
const mapTree = (node, fn) => fn(node.children ? { ...node, children: node.children.map((child) => mapTree(child, fn)) } : node);
export const sessionKey = (host, sessionId) => `${host || ""}\n${sessionId}`;
export const parseSessionKey = (key) => { const cut = key.indexOf("\n"); return { host: cut < 0 ? "" : key.slice(0, cut), sessionId: key.slice(cut + 1) }; };
export const initialLayout = (cwd = null, host = "") => { const root = newPane(cwd, host); return { root, focusedId: root.id }; };
export function restoreLayout(raw, cwd = null, host = "") {
  try {
    const value = JSON.parse(raw);
    const ids = new Set(), sessions = new Set(); let count = 0;
    const validate = (node, depth = 0) => {
      if (!node || depth > 255 || ++count > 511 || typeof node.id !== "string" || !node.id || ids.has(node.id)) throw Error("Invalid layout");
      ids.add(node.id);
      if (node.children) {
        if (!["row", "column"].includes(node.axis) || node.children.length !== 2 || !Number.isFinite(node.ratio)) throw Error("Invalid split");
        return { id: node.id, axis: node.axis, ratio: Math.max(0, Math.min(1, node.ratio)), children: node.children.map((child) => validate(child, depth + 1)) };
      }
      const paneHost = typeof node.host === "string" ? node.host : host;
      const sessionId = typeof node.sessionId === "string" && !sessions.has(sessionKey(paneHost, node.sessionId)) ? node.sessionId : null;
      if (sessionId) sessions.add(sessionKey(paneHost, sessionId));
      return { id: node.id, host: paneHost, sessionId, cwd: typeof node.cwd === "string" ? node.cwd : cwd, ...(node.terminal === true ? { terminal: true } : {}) };
    };
    const root = validate(value.root), panes = paneLeaves(root);
    return { root, focusedId: panes.some((pane) => pane.id === value.focusedId) ? value.focusedId : panes[0].id };
  } catch { return initialLayout(cwd, host); }
}
export function layoutReducer(state, action) {
  const panes = paneLeaves(state.root);
  const target = panes.find((pane) => pane.id === (action.paneId || state.focusedId));
  switch (action.type) {
    case "focus": return target ? { ...state, focusedId: target.id } : state;
    case "assign": {
      if (!target) return state; // A late create/fork response cannot reopen a closed pane.
      const host = action.host === undefined ? target.host : action.host || "";
      const existing = action.sessionId && panes.find((pane) => pane.sessionId === action.sessionId && (pane.host || "") === host);
      if (existing) return action.focus === false ? state : { ...state, focusedId: existing.id };
      return { ...state, focusedId: action.focus === false ? state.focusedId : target.id, root: mapTree(state.root, (node) => node.id === target.id ? { ...node, host, sessionId: action.sessionId || null, cwd: action.cwd ?? node.cwd } : node) };
    }
    case "host": return !target || target.sessionId ? state : { ...state, root: mapTree(state.root, (node) => node.id === target.id ? { ...node, host: action.host || "", cwd: action.cwd ?? null } : node) };
    case "cwd": return !target || target.sessionId ? state : { ...state, root: mapTree(state.root, (node) => node.id === target.id ? { ...node, cwd: action.cwd } : node) };
    case "terminal": {
      if (!target) return state;
      const open = action.open === undefined ? !target.terminal : !!action.open;
      return { ...state, root: mapTree(state.root, (node) => node.id === target.id ? { ...node, terminal: open } : node) };
    }
    case "split": {
      if (!target || !["row", "column"].includes(action.axis) || panes.length >= 256) return state;
      const pane = newPane(target.cwd, target.host);
      return { focusedId: pane.id, root: mapTree(state.root, (node) => node.id === target.id ? { id: id(), axis: action.axis, ratio: .5, children: [node, pane] } : node) };
    }
    case "splitOpen": {
      if (!target || !["row", "column"].includes(action.axis)) return state;
      const host = action.host || "";
      const existing = action.sessionId && panes.find((pane) => pane.sessionId === action.sessionId && (pane.host || "") === host);
      if (existing) return { ...state, focusedId: existing.id };
      if (panes.length >= 256) return state;
      const pane = { id: id(), host, sessionId: action.sessionId || null, cwd: action.cwd ?? target.cwd };
      return { focusedId: pane.id, root: mapTree(state.root, (node) => node.id === target.id ? { id: id(), axis: action.axis, ratio: .5, children: [node, pane] } : node) };
    }
    case "swap": {
      // Swap two leaf positions; leaf ids travel with their content so keyed
      // views keep composers, drafts and scroll mounted.
      if (action.a === action.b || !panes.some((p) => p.id === action.a) || !panes.some((p) => p.id === action.b)) return state;
      const leaves = {};
      for (const pane of panes) leaves[pane.id] = pane;
      const a = leaves[action.a], b = leaves[action.b];
      return { ...state, root: mapTree(state.root, (node) => !node.children ? (node.id === action.a ? b : node.id === action.b ? a : node) : node) };
    }
    case "ratio": if (!Number.isFinite(action.ratio)) return state; return { ...state, root: mapTree(state.root, (node) => node.id === action.id && node.children ? { ...node, ratio: Math.max(0, Math.min(1, action.ratio)) } : node) };
    case "clear": return { ...state, root: mapTree(state.root, (node) => !node.children && (node.host || "") === (action.host || "") && action.ids.includes(node.sessionId) ? { ...node, sessionId: null } : node) };
    case "close": {
      if (!target || panes.length === 1) return state;
      let neighbor;
      const remove = (node) => {
        if (!node.children) return node.id === target.id ? null : node;
        const children = node.children.map(remove).filter(Boolean);
        if (children.length === 1) { neighbor ||= paneLeaves(children[0])[0].id; return children[0]; }
        return { ...node, children };
      };
      const root = remove(state.root);
      return { root, focusedId: state.focusedId === target.id ? neighbor : state.focusedId };
    }
    default: return state;
  }
}
export function minimumLayout(node) {
  if (!node.children) return { width: 280, height: 220 };
  const [a, b] = node.children.map(minimumLayout);
  return node.axis === "row" ? { width: a.width + b.width + 6, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + b.height + 6 };
}
export function layoutGeometry(root, width, height) {
  const panes = [], dividers = [];
  const walk = (node, rect) => {
    if (!node.children) { panes.push({ ...node, rect }); return; }
    const row = node.axis === "row", dimension = row ? "width" : "height";
    const space = rect[dimension] - 6;
    const aMin = minimumLayout(node.children[0])[dimension], bMin = minimumLayout(node.children[1])[dimension];
    const first = Math.max(aMin, Math.min(space - bMin, space * node.ratio));
    const offset = row ? "left" : "top";
    dividers.push({ id: node.id, axis: node.axis, ratio: first / space, minRatio: aMin / space, maxRatio: 1 - bMin / space, parent: rect,
      rect: { ...rect, [offset]: rect[offset] + first, [dimension]: 6 } });
    walk(node.children[0], { ...rect, [dimension]: first });
    walk(node.children[1], { ...rect, [offset]: rect[offset] + first + 6, [dimension]: space - first });
  };
  walk(root, { left: 0, top: 0, width, height });
  return { panes, dividers };
}

// Neighbor in a direction: candidates lie entirely beyond the focused rect's
// edge and overlap on the perpendicular axis; smallest edge distance wins,
// then largest overlap.
export function neighborPane(geometryPanes, focusedId, dir) {
  const r = geometryPanes.find((pane) => pane.id === focusedId)?.rect;
  if (!r) return null;
  const horiz = dir === "left" || dir === "right";
  let best = null;
  for (const pane of geometryPanes) {
    if (pane.id === focusedId) continue;
    const c = pane.rect;
    const dist = dir === "left" ? r.left - (c.left + c.width) : dir === "right" ? c.left - (r.left + r.width)
      : dir === "up" ? r.top - (c.top + c.height) : c.top - (r.top + r.height);
    if (dist < 0) continue;
    const overlap = horiz ? Math.min(r.top + r.height, c.top + c.height) - Math.max(r.top, c.top)
      : Math.min(r.left + r.width, c.left + c.width) - Math.max(r.left, c.left);
    if (overlap <= 0) continue;
    if (!best || dist < best.dist || (dist === best.dist && overlap > best.overlap)) best = { id: pane.id, dist, overlap };
  }
  return best?.id || null;
}

// Stable per-host tint: same remote id always picks the same hue.
export function hostHue(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
