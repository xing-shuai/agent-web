// User interface preferences — localStorage-backed, applied to <html>/<body>
// at boot (main.jsx calls applyUi next to applyTheme) and re-applied live on
// every setUi. The "dw-ui" window event lets controls (e.g. the composer hint)
// re-render when a value changes.

const KEYS = {
  sbfs: "dw.fs.sidebar", // 80–130, sidebar font scale %
  tfs: "dw.fs.transcript", // 80–130, transcript font scale %
  colw: "dw.colw", // narrow | std | wide → --colw
  motion: "dw.motion", // "off" disables animation/transitions
  send: "dw.sendKey", // "mod" → Ctrl/Cmd+Enter sends
  hint: "dw.hintPin", // "1" keeps the keybind hint visible
};

const fs = (k) => Math.min(130, Math.max(80, +localStorage.getItem(k) || 100));

export function getUi() {
  localStorage.removeItem("dw.uiScale"); // legacy global-zoom pref
  const colw = localStorage.getItem(KEYS.colw);
  return {
    sbfs: fs(KEYS.sbfs),
    tfs: fs(KEYS.tfs),
    colw: ["narrow", "std", "wide"].includes(colw) ? colw : "std",
    motion: localStorage.getItem(KEYS.motion) === "off" ? "off" : "on",
    send: localStorage.getItem(KEYS.send) === "mod" ? "mod" : "enter",
    hint: localStorage.getItem(KEYS.hint) === "1",
  };
}

export function applyUi() {
  const u = getUi();
  const el = document.documentElement;
  el.style.setProperty("--sbfs", String(u.sbfs / 100));
  el.style.setProperty("--tfs", String(u.tfs / 100));
  el.dataset.colw = u.colw;
  el.dataset.motion = u.motion;
  el.dataset.hint = u.hint ? "pin" : "";
}

// patch values: null/undefined removes the key (back to default)
export function setUi(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) localStorage.removeItem(KEYS[k]);
    else localStorage.setItem(KEYS[k], String(v));
  }
  applyUi();
  window.dispatchEvent(new Event("dw-ui"));
}
