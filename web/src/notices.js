// Notice stack: errors pin until closed, the rest auto-dismiss. Identical
// (host, kind, text) repeats bump a counter instead of stacking; an explicit
// id replaces the same-id item (e.g. conn:<host> down -> back again).
export const MAX_NOTICES = 4;

export function noticesReducer(state, action) {
  if (action.type === "notify") {
    const n = action.notice;
    if (n.id) {
      const i = state.findIndex((x) => x.id === n.id);
      if (i >= 0) {
        const items = [...state];
        items[i] = { ...n, count: 1, at: Date.now() };
        return items;
      }
    } else {
      const dup = state.findIndex((x) => x.host === n.host && x.kind === n.kind && x.text === n.text);
      if (dup >= 0) {
        const items = [...state];
        items[dup] = { ...items[dup], count: items[dup].count + 1, at: Date.now() };
        return items;
      }
    }
    const items = [...state, { ...n, count: 1, at: Date.now() }];
    while (items.length > MAX_NOTICES) {
      const drop = items.findIndex((x) => !x.sticky);
      items.splice(drop < 0 ? 0 : drop, 1);
    }
    return items;
  }
  if (action.type === "dismiss") return state.filter((x) => x.id !== action.id);
  if (action.type === "dismissWhere") return state.filter((x) => !action.pred(x));
  return state;
}
