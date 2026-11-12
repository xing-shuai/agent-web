const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Buffer cells, not UTF-16 offsets: wide glyphs must stay intact. */
export function terminalCellAt(terminal, rect, x, y, boundary = false, end = false) {
  const buffer = terminal.buffer.active;
  const col = (x - rect.left) / (rect.width / terminal.cols);
  let px = clamp(boundary ? Math.round(col) : Math.floor(col), 0, terminal.cols - (boundary ? 0 : 1));
  const py = clamp(buffer.viewportY + Math.floor((y - rect.top) / (rect.height / terminal.rows)), 0, buffer.length - 1);
  if (buffer.getLine(py)?.getCell(px)?.getWidth() === 0) px += end ? 1 : -1;
  return { x: clamp(px, 0, terminal.cols), y: py };
}

export function terminalWordRange(terminal, point) {
  const line = terminal.buffer.active.getLine(point.y);
  const word = (x) => {
    const cell = line?.getCell(x);
    return cell && (cell.getWidth() === 0 || /\S/u.test(cell.getChars()));
  };
  if (!word(point.x)) return null;
  let start = point.x, end = point.x + 1;
  while (start > 0 && word(start - 1)) start--;
  while (end < terminal.cols && word(end)) end++;
  return { start: { x: start, y: point.y }, end: { x: end, y: point.y } };
}

export function terminalSelectionSpan(cols, start, end) {
  const first = start.y * cols + start.x;
  return { column: start.x, row: start.y, length: Math.max(1, end.y * cols + end.x - first) };
}

/** Own only touch gestures over the grid. No gesture is translated into PTY
 * input, including while an application has enabled mouse tracking. */
export function installTerminalTouch(terminal, host, { onSelection, onReview, onNoHistory }) {
  let gesture = null, holdTimer, momentum = 0, frame = 0, edgeFrame = 0;
  let touchSelection = false, pin = null, disposed = false, lastTouch = -Infinity, resizing = false;
  let previousCols = terminal.cols;
  const screen = () => host.querySelector(".xterm-screen");
  const rect = () => screen()?.getBoundingClientRect();
  const stopMomentum = () => { cancelAnimationFrame(momentum); momentum = 0; };
  const stopGesture = () => { clearTimeout(holdTimer); cancelAnimationFrame(edgeFrame); gesture = null; };
  const unpin = () => { pin?.dispose(); pin = null; };
  const bookmark = () => {
    unpin();
    const b = terminal.buffer.active;
    if (touchSelection && b.type === "normal") pin = terminal.registerMarker(b.viewportY - b.baseY - b.cursorY);
  };
  const visualEdge = (position, end) => end && position.x === 0 && position.y > 0
    ? { x: terminal.cols, y: position.y - 1 } : position;
  const sync = () => {
    frame = 0;
    if (disposed) return;
    const b = terminal.buffer.active;
    onReview(b.viewportY < b.baseY);
    const range = touchSelection && terminal.getSelectionPosition();
    const box = rect(), outer = host.getBoundingClientRect();
    if (!range || !box?.height) { onSelection(null); return; }
    const edge = (position, end) => {
      const p = visualEdge(position, end), row = p.y - b.viewportY;
      return row < 0 || row >= terminal.rows ? null : {
        left: clamp(box.left - outer.left + p.x * box.width / terminal.cols, 18, outer.width - 18),
        top: clamp(box.top - outer.top + (row + 1) * box.height / terminal.rows - 4, 0, outer.height - 38),
      };
    };
    onSelection({ start: edge(range.start, false), end: edge(range.end, true) });
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
  const clear = () => {
    stopGesture(); stopMomentum(); unpin(); touchSelection = false;
    terminal.clearSelection(); onSelection(null); schedule();
  };
  const scrollPixels = (pixels) => {
    const box = rect();
    if (!box?.height) return;
    const lines = Math.trunc(pixels / (box.height / terminal.rows));
    if (lines) { terminal.scrollLines(lines); bookmark(); schedule(); }
    return pixels - lines * box.height / terminal.rows;
  };
  const beginHandle = (handle, touch) => {
    const range = terminal.getSelectionPosition(), box = rect();
    if (!range || !box) return;
    const edge = visualEdge(range[handle], handle === "end");
    gesture = { mode: handle, x: touch.clientX, y: touch.clientY,
      offsetX: touch.clientX - (box.left + edge.x * box.width / terminal.cols),
      offsetY: touch.clientY - (box.top + (edge.y - terminal.buffer.active.viewportY + .5) * box.height / terminal.rows) };
  };
  const drag = () => {
    if (!gesture || !["start", "end"].includes(gesture.mode)) return;
    const range = terminal.getSelectionPosition(), box = rect();
    if (!range || !box) { stopGesture(); return; }
    const { mode, x, y, offsetX, offsetY } = gesture;
    const point = terminalCellAt(terminal, box, x - offsetX, y - offsetY, true, mode === "end");
    const cols = terminal.cols;
    const first = range.start.y * cols + range.start.x, last = range.end.y * cols + range.end.x;
    const candidate = point.y * cols + point.x;
    const start = mode === "start" ? Math.min(candidate, last - 1) : first;
    const end = mode === "end" ? Math.max(candidate, first + 1) : last;
    terminal.select(start % cols, Math.floor(start / cols), end - start);
    schedule();
  };
  const autoScroll = () => {
    edgeFrame = 0;
    if (!gesture || !["start", "end"].includes(gesture.mode)) return;
    const box = rect();
    if (!box) return;
    const y = gesture.y - gesture.offsetY;
    const direction = y < box.top + 16 ? -1 : y > box.bottom - 16 ? 1 : 0;
    if (direction) { terminal.scrollLines(direction); bookmark(); drag(); }
    edgeFrame = requestAnimationFrame(autoScroll);
  };
  const consume = (event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
  const touchStart = (event) => {
    if (event.target.closest?.(".terminal-selection-actions")) return;
    if (!event.target.closest?.(".xterm-screen, [data-terminal-handle]")) return;
    lastTouch = performance.now();
    consume(event); stopMomentum(); stopGesture();
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    const handle = event.target.closest?.("[data-terminal-handle]")?.dataset.terminalHandle;
    if (handle) { beginHandle(handle, touch); edgeFrame = requestAnimationFrame(autoScroll); return; }
    gesture = { mode: "pending", startX: touch.clientX, startY: touch.clientY,
      x: touch.clientX, y: touch.clientY, time: performance.now(), velocity: 0, remainder: 0 };
    holdTimer = setTimeout(() => {
      if (gesture?.mode !== "pending") return;
      const box = rect();
      if (!box?.height) return;
      const range = terminalWordRange(terminal, terminalCellAt(terminal, box, gesture.x, gesture.y));
      if (!range) { gesture.mode = "held"; return; }
      touchSelection = true; bookmark();
      const span = terminalSelectionSpan(terminal.cols, range.start, range.end);
      terminal.select(span.column, span.row, span.length);
      beginHandle("end", { clientX: gesture.x, clientY: gesture.y });
      edgeFrame = requestAnimationFrame(autoScroll); schedule();
    }, 450);
  };
  const touchMove = (event) => {
    if (!gesture) return;
    consume(event);
    if (event.touches.length !== 1) { stopGesture(); return; }
    const touch = event.touches[0], now = performance.now();
    if (["start", "end"].includes(gesture.mode)) { gesture.x = touch.clientX; gesture.y = touch.clientY; drag(); return; }
    if (gesture.mode === "held") return;
    if (gesture.mode === "pending" && Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY) > 8) {
      clearTimeout(holdTimer); gesture.mode = "scroll";
      if (terminal.buffer.active.type === "alternate") onNoHistory?.();
    }
    if (gesture.mode === "scroll") {
      const dy = gesture.y - touch.clientY;
      gesture.velocity = clamp(dy / Math.max(1, now - gesture.time), -2.5, 2.5);
      gesture.remainder = scrollPixels(gesture.remainder + dy) || 0;
    }
    gesture.x = touch.clientX; gesture.y = touch.clientY; gesture.time = now;
  };
  const touchEnd = (event) => {
    if (!gesture) return;
    lastTouch = performance.now();
    consume(event);
    const ended = gesture;
    stopGesture();
    if (ended.mode === "pending") {
      if (touchSelection) clear();
      else if (terminal.buffer.active.viewportY === terminal.buffer.active.baseY) terminal.focus();
    } else if (ended.mode === "scroll" && !touchSelection && performance.now() - ended.time < 100) {
      let velocity = ended.velocity, remainder = ended.remainder;
      const coast = () => {
        velocity *= .9;
        const before = terminal.buffer.active.viewportY;
        remainder = scrollPixels(remainder + velocity * 16) || 0;
        if (Math.abs(velocity) > .03 && (before !== terminal.buffer.active.viewportY || Math.abs(remainder) > .1)) momentum = requestAnimationFrame(coast);
      };
      momentum = requestAnimationFrame(coast);
    }
  };
  const touchCancel = (event) => { if (gesture) consume(event); stopGesture(); stopMomentum(); };
  const contextMenu = (event) => { if (performance.now() - lastTouch < 1500) consume(event); };
  // Capture on the stable host, not a rendered glyph/handle that may move or
  // disappear as new output is painted during a drag.
  let pointerId = null;
  const pointerTouch = (event) => ({ target: event.target, touches: [event], cancelable: event.cancelable,
    preventDefault: () => event.preventDefault(), stopImmediatePropagation: () => event.stopImmediatePropagation() });
  const pointerStart = (event) => {
    if (event.pointerType === "mouse") return;
    if (pointerId != null && event.pointerId !== pointerId) { stopGesture(); stopMomentum(); pointerId = null; return; }
    touchStart(pointerTouch(event));
    if (gesture) { pointerId = event.pointerId; host.setPointerCapture?.(pointerId); }
  };
  const pointerEnd = (event) => {
    if (event.pointerId !== pointerId) return;
    touchEnd(pointerTouch(event)); pointerId = null;
    if (host.hasPointerCapture?.(event.pointerId)) host.releasePointerCapture(event.pointerId);
  };
  const nativeTouch = (event) => {
    if (event.target.closest?.(".xterm-screen, [data-terminal-handle]")) consume(event);
  };
  const gridClick = (event) => {
    if (performance.now() - lastTouch < 1500 && event.target.closest?.(".xterm-screen, [data-terminal-handle]")) consume(event);
  };
  const listeners = typeof PointerEvent === "function" ? {
    pointerdown: pointerStart,
    pointermove: (event) => { if (event.pointerId === pointerId) touchMove(pointerTouch(event)); },
    pointerup: pointerEnd,
    pointercancel: (event) => { if (event.pointerId === pointerId) { touchCancel(pointerTouch(event)); pointerId = null; } },
    lostpointercapture: (event) => { if (event.pointerId === pointerId) { stopGesture(); pointerId = null; } },
    touchstart: nativeTouch, touchmove: nativeTouch, touchend: nativeTouch, contextmenu: contextMenu, click: gridClick,
  } : { touchstart: touchStart, touchmove: touchMove, touchend: touchEnd, touchcancel: touchCancel, contextmenu: contextMenu, click: gridClick };
  for (const [name, handler] of Object.entries(listeners)) host.addEventListener(name, handler, { capture: true, passive: false });
  const subscriptions = [
    terminal.onScroll(schedule),
    terminal.onSelectionChange(() => {
      if (!resizing && !terminal.hasSelection()) { touchSelection = false; unpin(); }
      schedule();
    }),
    terminal.onWriteParsed(() => {
      if (touchSelection && pin) {
        if (pin.isDisposed) clear();
        else terminal.scrollToLine(pin.line);
      }
      schedule();
    }),
    terminal.onResize(({ cols }) => {
      if (cols !== previousCols) clear(); // Width reflow invalidates cell endpoints.
      previousCols = cols; schedule();
    }),
    terminal.buffer.onBufferChange(clear),
  ];
  schedule();
  return {
    clear,
    fit(resize) {
      const range = touchSelection && terminal.getSelectionPosition();
      const cols = terminal.cols, oldLine = pin?.line;
      resizing = true;
      try { resize(); } finally { resizing = false; }
      if (range) {
        if (cols !== terminal.cols || !pin || pin.isDisposed || oldLine == null) clear();
        else {
          const shift = pin.line - oldLine;
          const span = terminalSelectionSpan(cols, { ...range.start, y: range.start.y + shift }, { ...range.end, y: range.end.y + shift });
          terminal.select(span.column, span.row, span.length);
          terminal.scrollToLine(pin.line);
        }
      }
      schedule();
    },
    dispose() {
      disposed = true; stopGesture(); stopMomentum(); unpin(); cancelAnimationFrame(frame);
      for (const subscription of subscriptions) subscription.dispose();
      for (const [name, handler] of Object.entries(listeners)) host.removeEventListener(name, handler, true);
    },
  };
}
