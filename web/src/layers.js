import { useLayoutEffect, useRef } from "react";

const stack = [];
let installed = false, popping = false, historyUrl = null, historyEntry = null, skipLanding = false, consumeClickUntil = 0;
const marker = "__dwOverlay", anchor = "__dwOverlayAnchor";
const entry = () => ({ url: location.href, kind: history.state?.[marker], anchor: history.state?.[anchor] });
const focusable = 'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])';
const nodes = (layer) => [layer.ref.current, ...(layer.extraRefs || []).map((r) => r.current)].filter(Boolean);
const contains = (layer, target) => target?.nodeType && nodes(layer).some((node) => node.contains(target));
const historyLayers = () => stack.filter((layer) => layer.history !== false);
const visible = (node) => !node.closest('[hidden],[inert],[aria-hidden="true"]') && window.getComputedStyle(node).visibility !== "hidden" && window.getComputedStyle(node).display !== "none";
const controls = (layer) => nodes(layer).flatMap((node) => [...node.querySelectorAll(focusable)]).filter(visible);
const top = () => stack.at(-1);

function focusFirst(layer) {
  const initial = layer.initialFocus;
  const target = typeof initial === "string" ? layer.ref.current?.querySelector(initial) : initial?.current;
  (target || controls(layer)[0] || layer.ref.current)?.focus?.({ preventScroll: true });
}

function fitLayer(layer) {
  if (layer.modal || layer.passive || layer.fit === false) return;
  const root = layer.ref.current;
  const panel = root?.querySelector(".cfg-panel,.usage-panel,.acct-panel") || root;
  if (!panel) return;
  const viewport = window.visualViewport;
  const left = (viewport?.offsetLeft || 0) + 8, top = (viewport?.offsetTop || 0) + 8;
  const width = Math.max(80, (viewport?.width || window.innerWidth) - 16);
  const height = Math.max(80, (viewport?.height || window.innerHeight) - 16);
  panel.style.translate = "none";
  panel.style.maxWidth = `${width}px`; panel.style.maxHeight = `${height}px`;
  panel.style.overflowY = "auto";
  const box = panel.getBoundingClientRect();
  const dx = Math.max(left - box.left, Math.min(0, left + width - box.right));
  const dy = Math.max(top - box.top, Math.min(0, top + height - box.bottom));
  panel.style.translate = `${dx}px ${dy}px`;
}

function ensureHistory() {
  if (!historyLayers().length || history.state?.[marker] === true) return;
  historyUrl = location.href;
  const base = { ...history.state, [anchor]: history.state?.[anchor] || `${Date.now()}-${Math.random()}` };
  const state = { ...base, [marker]: true };
  if (history.state?.[marker] === "closed") history.replaceState(state, "", location.href);
  else {
    history.replaceState(base, "", location.href);
    history.pushState(state, "", location.href);
  }
  historyEntry = entry();
}

function install() {
  if (installed) return;
  installed = true;
  historyEntry = entry();
  window.addEventListener("hashchange", () => { historyEntry = entry(); });
  const viewport = () => {
    const vv = window.visualViewport, style = document.documentElement.style;
    style.setProperty("--vv-top", `${vv?.offsetTop || 0}px`);
    style.setProperty("--vv-left", `${vv?.offsetLeft || 0}px`);
    style.setProperty("--vv-width", `${vv?.width || window.innerWidth}px`);
    style.setProperty("--vv-height", `${vv?.height || window.innerHeight}px`);
    stack.forEach(fitLayer);
  };
  viewport();
  window.addEventListener("resize", viewport);
  window.visualViewport?.addEventListener("resize", viewport);
  window.visualViewport?.addEventListener("scroll", viewport);
  document.addEventListener("keydown", (event) => {
    const layer = top();
    if (!layer || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && layer.escape !== false && (layer.escapeFromOutside !== false || contains(layer, event.target))) {
      event.preventDefault(); event.stopImmediatePropagation(); layer.onClose();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const root = layer.ref.current;
      const menu = root?.matches('[role="menu"]') ? root : root?.querySelector('[role="listbox"]');
      const editing = event.target?.matches?.("input,textarea");
      if (!menu || (editing && ["Home", "End"].includes(event.key))) return;
      const list = [...menu.querySelectorAll("button:not(:disabled)")].filter(visible);
      if (!list.length) return;
      const index = list.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 :
        event.key === "ArrowDown" ? (index + 1) % list.length : (index < 0 ? list.length - 1 : (index + list.length - 1) % list.length);
      event.preventDefault(); event.stopImmediatePropagation();
      list[next].focus({ preventScroll: true }); list[next].scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Tab") {
      const modalIndex = stack.findLastIndex((item) => item.modal);
      if (modalIndex < 0) return;
      const list = stack.slice(modalIndex).flatMap(controls);
      const index = list.indexOf(document.activeElement);
      if (!list.length) { event.preventDefault(); focusFirst(layer); }
      else if (event.shiftKey && index <= 0) { event.preventDefault(); list.at(-1).focus(); }
      else if (!event.shiftKey && (index < 0 || index === list.length - 1)) { event.preventDefault(); list[0].focus(); }
    }
  }, true);
  document.addEventListener("pointerdown", (event) => {
    const layer = top();
    if (!layer || layer.outside === false || contains(layer, event.target) || layer.triggerRef?.current?.contains(event.target)) return;
    layer.restore = !!layer.modal;
    consumeClickUntil = Date.now() + 500;
    event.preventDefault(); event.stopImmediatePropagation();
    layer.onClose();
  }, true);
  document.addEventListener("click", (event) => {
    if (Date.now() > consumeClickUntil) return;
    consumeClickUntil = 0; event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  document.addEventListener("focusin", (event) => {
    const modalIndex = stack.findLastIndex((layer) => layer.modal);
    if (modalIndex >= 0 && !stack.slice(modalIndex).some((layer) => contains(layer, event.target))) focusFirst(top());
  }, true);
  window.addEventListener("popstate", () => {
    const previous = historyEntry, current = entry(), landing = skipLanding;
    historyEntry = current; skipLanding = false;
    const layer = historyLayers().at(-1);
    if (!layer) {
      const sameAnchor = previous?.anchor && previous.anchor === current.anchor && previous.url === current.url;
      if (current.kind) {
        // A stale overlay slot can be reached in either direction. Forward
        // must skip forward rather than trapping navigation on the same page.
        const forward = sameAnchor && !previous.kind;
        skipLanding = !forward;
        if (forward) history.forward(); else history.back();
      } else if (!landing && sameAnchor && previous.kind === "closed") history.back();
      return;
    }
    popping = true;
    layer.onClose();
    setTimeout(() => { popping = false; ensureHistory(); }, 0);
  });
}

/** One stack owns Escape/back, outside dismissal and modal keyboard focus.
 * Passive surfaces keep ordinary input alone; history and Escape opt-outs are explicit. */
export function useLayer({ open = true, ref, onClose, ...options }) {
  const latest = useRef(null);
  latest.current = { ref, onClose, ...options };
  useLayoutEffect(() => {
    if (!open) return;
    install();
    const previousFocus = document.activeElement;
    const layer = { restore: true, get ref() { return latest.current.ref; },
      get onClose() { return latest.current.onClose; } };
    for (const key of Object.keys(options)) Object.defineProperty(layer, key, { get: () => latest.current[key] });
    if (options.passive) stack.unshift(layer);
    else stack.push(layer);
    const surface = ref.current?.closest(".modal-back,.cp-backdrop,.ctx-backdrop,.imgview") || ref.current;
    const previousZ = surface?.style.zIndex;
    if (surface && options.passive !== true) surface.style.zIndex = String(100 + stack.length * 10);
    fitLayer(layer);
    const fitFrame = requestAnimationFrame(() => fitLayer(layer));
    if (options.history !== false) ensureHistory();
    if (options.initialFocus !== false && (options.modal || options.initialFocus)) {
      queueMicrotask(() => { if (top() === layer) focusFirst(layer); });
    }
    return () => {
      cancelAnimationFrame(fitFrame);
      if (surface && options.passive !== true) surface.style.zIndex = previousZ;
      const wasTop = top() === layer;
      stack.splice(stack.indexOf(layer), 1);
      const parent = top();
      queueMicrotask(() => {
        if (wasTop && layer.restore && top() === parent && previousFocus?.isConnected &&
            (!parent?.modal || contains(parent, previousFocus))) previousFocus.focus?.({ preventScroll: true });
        if (!popping && !historyLayers().length && history.state?.[marker] === true && location.href === historyUrl) {
          // Mark, don't asynchronously pop: an in-flight back could otherwise
          // undo a session/workspace navigation initiated by the closing action.
          history.replaceState({ ...history.state, [marker]: "closed" }, "", location.href);
          historyEntry = entry();
        }
      });
    };
  }, [open]);
}

export function hasActiveLayer() {
  return stack.some((layer) => !layer.passive);
}

/** True when a non-passive layer sits above a surface that does NOT contain
 *  `node` — the modal quick chat blocks the main pane's shortcuts while the
 *  chat inside the dialog keeps working. */
export function layerBlocks(node) {
  const layer = stack.findLast((item) => !item.passive);
  return !!layer && !contains(layer, node);
}
