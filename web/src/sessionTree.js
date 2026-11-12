const ROOT = "__session_root__";
const MESSAGE_KINDS = new Set(["user", "assistant", "compaction", "branch_summary", "custom_message"]);

/** Project hidden entries out of the native tree without losing ancestry.
 * Only forks add indentation: a long linear conversation stays flat.
 * All walks are iterative, including malformed/orphan/cyclic input. */
export function sessionTreeRows(entries, leafId, filter = "user") {
  const raw = new Map(entries.map((node) => [node.id, node]));
  const shown = new Map(entries.filter((node) => filter === "all" || (filter === "user" ? node.kind === "user" : MESSAGE_KINDS.has(node.kind)))
    .map((node) => [node.id, { ...node, children: [] }]));
  const root = { id: ROOT, children: [] }, nearest = new Map();
  shown.set(ROOT, root);
  const visibleAncestor = (id) => {
    const path = [], seen = new Set();
    while (id && !shown.has(id) && !nearest.has(id) && raw.has(id) && !seen.has(id)) {
      seen.add(id); path.push(id); id = raw.get(id).parentId;
    }
    const result = shown.has(id) ? id : nearest.get(id) || ROOT;
    for (const key of path) nearest.set(key, result);
    return result;
  };
  for (const node of shown.values()) if (node !== root) {
    const parent = shown.get(visibleAncestor(node.parentId));
    (parent === node ? root : parent).children.push(node.id);
  }
  // A sibling branch can contain no visible messages yet. Still mark the
  // native fork instead of making the other branch look like linear history.
  const rawChildren = new Map(), forkEdges = new Map(), forkCache = new Map();
  for (const node of raw.values()) {
    const parent = node.parentId || ROOT;
    if (!rawChildren.has(parent)) rawChildren.set(parent, []);
    rawChildren.get(parent).push(node.id);
  }
  for (const children of rawChildren.values()) if (children.length > 1) children.forEach((id, index) => forkEdges.set(id, index + 1));
  const nativeForks = (start) => {
    const path = [], seen = new Set();
    let id = start, info = { count: 0, index: null };
    while (raw.has(id) && !seen.has(id)) {
      if (forkCache.has(id)) { info = forkCache.get(id); break; }
      seen.add(id); path.push(id);
      id = raw.get(id).parentId;
      if (shown.has(id)) break;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const index = forkEdges.get(path[i]);
      info = { count: info.count + (index ? 1 : 0), index: index || info.index };
      forkCache.set(path[i], info);
    }
    return info;
  };
  const active = new Set();
  for (let id = leafId; raw.has(id) && !active.has(id); id = raw.get(id).parentId) active.add(id);
  const rows = [], visited = new Set([ROOT]);
  const visit = (start, parent) => {
    const stack = [{ id: start, parent }];
    while (stack.length) {
      const { id, parent } = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      const node = shown.get(id);
      node.parent = parent === ROOT ? null : parent;
      node.active = active.has(id); rows.push(node);
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ id: node.children[i], parent: id });
    }
  };
  for (const id of root.children) visit(id, ROOT);
  for (const node of shown.values()) if (!visited.has(node.id)) visit(node.id, ROOT);
  // Rebuild actual child lists after cycle repair; no phantom fork markers.
  root.children = [];
  for (const row of rows) row.children = [];
  for (const row of rows) shown.get(row.parent || ROOT).children.push(row.id);
  for (const parent of [root, ...rows]) parent.children.forEach((id, index) => {
    const child = shown.get(id);
    const native = nativeForks(id);
    child.forks = native.count || (parent.children.length > 1 ? 1 : 0);
    child.branchStart = child.forks > 0;
    child.branchIndex = child.branchStart ? native.index || index + 1 : null;
  });
  const current = visibleAncestor(leafId);
  for (const row of rows) {
    row.depth = (row.parent ? shown.get(row.parent).depth : 0) + row.forks;
    row.current = row.id === current;
  }
  shown.delete(ROOT);
  return { rows, byId: shown, current: current === ROOT ? null : current,
    nearest: (id) => { const visible = visibleAncestor(id); return visible === ROOT ? null : visible; } };
}
