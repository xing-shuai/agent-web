/** Record a visible text character, plus neighbouring row fallbacks. Keeping a
 * Range preserves the logical reading line even when a side panel rewraps it. */
export function captureTranscriptAnchor(el) {
  if (!el) return [];
  const box = el.getBoundingClientRect();
  const head = el.closest(".chat")?.querySelector(".chat-head");
  const y = box.top + (head?.getBoundingClientRect().height || 56) + 8;
  const rows = [...el.querySelectorAll("[data-ik]")];
  const index = rows.findIndex((node) => node.getBoundingClientRect().bottom > y);
  if (index < 0) return [];
  const row = rows[index];
  const target = [...row.querySelectorAll(".agent-body > *, .msg-bubble, .thought-body, .tool-out, .stream-head, .tool-head, .tg-head, .plan-row")]
    .find((node) => { const r = node.getBoundingClientRect(); return r.height > 0 && r.bottom > y; }) || row;
  const rect = target.getBoundingClientRect();
  const x = Math.min(box.right - 12, rect.left + Math.min(36, rect.width / 3));
  const pointY = Math.max(rect.top + 2, Math.min(y, rect.bottom - 2));
  let range = document.caretRangeFromPoint?.(x, pointY);
  if (!range && document.caretPositionFromPoint) {
    const caret = document.caretPositionFromPoint(x, pointY);
    if (caret) { range = document.createRange(); range.setStart(caret.offsetNode, caret.offset); range.collapse(true); }
  }
  const anchors = [];
  if (range?.startContainer.nodeType === 3 && el.contains(range.startContainer)) {
    range = range.cloneRange();
    if (range.startOffset < range.startContainer.length) range.setEnd(range.startContainer, range.startOffset + 1);
    const r = range.getBoundingClientRect?.();
    if (r?.height) anchors.push({ node: range.startContainer, range, index: range.startOffset, offset: r.top - box.top });
  }
  anchors.push({ node: target, offset: rect.top - box.top });
  for (const node of rows.slice(index, index + 4)) anchors.push({ node, offset: node.getBoundingClientRect().top - box.top });
  return anchors;
}

export function restoreTranscriptAnchor(el, anchors) {
  const top = el.getBoundingClientRect().top;
  for (const anchor of anchors || []) {
    if (!anchor.node.isConnected || !el.contains(anchor.node)) continue;
    const element = anchor.node.nodeType === 1 ? anchor.node : anchor.node.parentElement;
    if (element?.closest('[inert], [aria-hidden="true"]')) continue;
    if (element?.closest('details:not([open])') && !element.closest("summary")) continue;
    if (anchor.range) {
      const index = Math.min(anchor.index, anchor.node.length);
      anchor.range.setStart(anchor.node, index);
      anchor.range.setEnd(anchor.node, Math.min(index + 1, anchor.node.length));
    }
    const rect = anchor.range?.getBoundingClientRect?.() || anchor.node.getBoundingClientRect?.();
    if (!rect?.height || (!anchor.range && anchor.offset < 0 && rect.height < -anchor.offset)) continue;
    const delta = rect.top - top - anchor.offset;
    if (Math.abs(delta) > .5) el.scrollTop += delta;
    return true;
  }
  return false;
}
