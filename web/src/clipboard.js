export const COPY_FAILED_EVENT = "dw-copy-failed";

function legacyCopy(text, container) {
  const doc = container?.ownerDocument || document, active = doc.activeElement;
  const selection = doc.getSelection();
  const ranges = Array.from({ length: selection?.rangeCount || 0 }, (_, i) => selection.getRangeAt(i).cloneRange());
  let inputSelection;
  try {
    if (typeof active?.selectionStart === "number")
      inputSelection = [active.selectionStart, active.selectionEnd, active.selectionDirection];
  } catch { /* Some input types do not expose a text selection. */ }
  const positions = new Map();
  for (let node of [active, selection?.anchorNode, selection?.focusNode, doc.scrollingElement]) {
    if (node?.nodeType === 3) node = node.parentElement;
    for (; node?.nodeType === 1; node = node.parentElement)
      if (!positions.has(node)) positions.set(node, [node.scrollLeft, node.scrollTop]);
  }
  const field = doc.createElement("textarea");
  field.value = text; field.readOnly = true; field.tabIndex = -1;
  field.inputMode = "none";
  field.setAttribute("data-clipboard-copy", "");
  field.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px";
  // Stay inside an active modal's focus boundary; never change the layer stack.
  const host = container || active?.closest?.('[role="dialog"], [aria-modal="true"], .ctx-menu') || doc.body;
  let failed = false;
  const write = (event) => {
    if (!event.clipboardData) return;
    try {
      // Preserve the exact original, including CRLF and hidden message tails.
      event.clipboardData.setData("text/plain", text);
    } catch { failed = true; }
    event.preventDefault();
  };
  try {
    host.append(field);
    doc.addEventListener("copy", write, true);
    field.focus({ preventScroll: true }); field.select(); field.setSelectionRange(0, field.value.length);
    return doc.execCommand?.("copy") === true && !failed;
  } finally {
    doc.removeEventListener("copy", write, true); field.remove();
    if (active?.isConnected) active.focus?.({ preventScroll: true });
    if (inputSelection && active?.isConnected) active.setSelectionRange(...inputSelection);
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) if (range.startContainer.isConnected && range.endContainer.isConnected) selection.addRange(range);
    }
    for (const [node, [left, top]] of positions) if (node.isConnected) {
      if (node.scrollLeft !== left) node.scrollLeft = left;
      if (node.scrollTop !== top) node.scrollTop = top;
    }
  }
}

/** Called directly from a user action, so HTTP fallback retains its gesture. */
export async function copyText(text, { host = "", container, silent = false, shouldCopy = () => true } = {}) {
  if (!shouldCopy()) return false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* HTTP/WebView/permission fallback, including throwing getters. */ }
  if (!shouldCopy() || (container && !container.isConnected)) return false;
  try { if (legacyCopy(text, container)) return true; }
  catch { /* The legacy API can also be missing, blocked or throw. */ }
  if (!silent) window.dispatchEvent(new window.CustomEvent(COPY_FAILED_EVENT, { detail: { host } }));
  return false;
}
