import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Columns2, Rows2, X } from "lucide-react";
import { layoutGeometry, minimumLayout, paneLeaves, sessionKey, hostHue } from "../splitLayout.js";
import { GripVertical } from "lucide-react";
import { t } from "../i18n.js";

const PANE_DRAG = "application/x-dw-pane";
const position = (rect) => Object.fromEntries(Object.entries(rect).map(([key, value]) => [`--pane-${key}`, `${value}px`]));
export default function SplitWorkspace({ layout, onAction, titles, hostNames, paneStatus = {}, renderPane, onTerminalBounds }) {
  const [dropTarget, setDropTarget] = useState(null), [resizing, setResizing] = useState(false);
  const pendingRatio = useRef(null), ratioFrame = useRef(0), actionRef = useRef(onAction);
  actionRef.current = onAction;
  const flushRatio = () => {
    cancelAnimationFrame(ratioFrame.current); ratioFrame.current = 0;
    const action = pendingRatio.current; pendingRatio.current = null;
    if (action) actionRef.current(action);
  };
  useEffect(() => () => { cancelAnimationFrame(ratioFrame.current); pendingRatio.current = null; document.body.classList.remove("layout-resizing"); }, []);
  const canvas = useRef(null), drag = useRef(null);
  const viewport = useRef(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const minimum = useMemo(() => minimumLayout(layout.root), [layout.root]);
  const geometry = useMemo(() => layoutGeometry(layout.root, Math.max(size.width, minimum.width), Math.max(size.height, minimum.height)), [layout.root, size, minimum]);
  const panes = paneLeaves(layout.root);
  useEffect(() => {
    const measure = () => {
      const element = canvas.current;
      if (element) setSize((previous) => previous.width === element.clientWidth && previous.height === element.clientHeight ? previous : { width: element.clientWidth, height: element.clientHeight });
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(canvas.current);
    return () => { observer.disconnect(); document.body.classList.remove("layout-resizing"); };
  }, []);
  const stop = () => { flushRatio(); drag.current = null; setResizing(false); document.body.classList.remove("layout-resizing"); };
  // Observe each pane whose terminal is open: nested splits and scrolling can
  // place a title bar anywhere, not just at the top of the browser window.
  useLayoutEffect(() => {
    if (!onTerminalBounds) return;
    const container = viewport.current;
    const nodes = [...canvas.current.querySelectorAll(".chat-pane")].filter((node) =>
      paneLeaves(layout.root).find((pane) => pane.id === node.dataset.paneId)?.terminal);
    if (!nodes.length) return;
    const measure = () => {
      const base = container.closest(".workspace-body").getBoundingClientRect();
      const next = {};
      for (const pane of nodes) {
        const p = pane.getBoundingClientRect(), v = container.getBoundingClientRect();
        const head = pane.querySelector(".chat-head,.welcome-header")?.getBoundingClientRect();
        const left = Math.max(p.left, v.left), top = Math.max(p.top, v.top, head?.bottom || p.top);
        next[pane.dataset.paneId] = { left: left - base.left, top: top - base.top,
          width: Math.max(0, Math.min(p.right, v.right) - left), height: Math.max(0, Math.min(p.bottom, v.bottom) - top) };
      }
      onTerminalBounds((previous) => previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    for (const pane of nodes) for (const node of [pane, container, pane.querySelector(".chat-head,.welcome-header")]) if (node) observer?.observe(node);
    for (const pane of nodes) pane.querySelector(".welcome")?.addEventListener("scroll", measure, { passive: true });
    container.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); container.removeEventListener("scroll", measure); window.removeEventListener("resize", measure); };
  }, [layout.focusedId, layout.root, onTerminalBounds]);
  const multiHost = new Set(panes.map((pane) => pane.host || "")).size > 1;
  const statusLabel = { attention: t("待确认"), done: t("已完成") };
  const labelOf = (pane, index) => {
    const title = titles[sessionKey(pane.host, pane.sessionId)] || t("选择会话的窗格");
    const base = multiHost ? `${index + 1}. ${hostNames?.[pane.host || ""] || t("本机")} · ${title}` : title;
    const mark = statusLabel[paneStatus[pane.id]];
    return mark ? `${base} · ${mark}` : base;
  };
  const switchLabel = (pane, index) => `${index + 1}. ${multiHost ? `${hostNames?.[pane.host || ""] || t("本机")} · ` : ""}${titles[sessionKey(pane.host, pane.sessionId)] || t("选择会话")}${statusLabel[paneStatus[pane.id]] ? ` · ${statusLabel[paneStatus[pane.id]]}` : ""}`;
  return <section className={`conversation-pane${panes.length > 1 ? " has-pane-switcher" : ""}`} aria-label={t("聊天工作区")}>
    <div className="split-viewport" ref={viewport}><div className="split-canvas" ref={canvas} style={{ "--layout-min-width": `${minimum.width}px`, "--layout-min-height": `${minimum.height}px` }}>
      {geometry.panes.map((pane, index) => <section key={pane.id} className={`chat-pane${pane.id === layout.focusedId ? " focused" : ""}${panes.length > 1 ? " multiple" : ""}${paneStatus[pane.id] ? ` pane-${paneStatus[pane.id]}` : ""}${multiHost && pane.host ? " host-tinted" : ""}`} data-pane-id={pane.id} data-session-id={pane.sessionId || ""} data-host={pane.host || ""}
        style={{ ...position(pane.rect), ...(multiHost && pane.host ? { "--pane-host-hue": hostHue(pane.host) } : {}) }}
        aria-label={labelOf(pane, index)}
        onPointerDownCapture={() => pane.id !== layout.focusedId && onAction({ type: "focus", paneId: pane.id })}
        onFocusCapture={() => pane.id !== layout.focusedId && onAction({ type: "focus", paneId: pane.id })}
        onDragOver={(e) => { if (e.dataTransfer.types.includes(PANE_DRAG)) { e.preventDefault(); setDropTarget(pane.id); } }}
        onDragLeave={(e) => { if (e.dataTransfer.types.includes(PANE_DRAG) && dropTarget === pane.id) setDropTarget(null); }}
        onDrop={(e) => {
          const from = e.dataTransfer.getData?.(PANE_DRAG);
          if (!from) return;
          e.preventDefault(); setDropTarget(null);
          onAction({ type: "swap", a: from, b: pane.id });
        }}>
        {dropTarget === pane.id && <div className="chat-drop" aria-hidden="true">{t("交换到此处")}</div>}
        <button type="button" className="icon-ghost split-desktop pane-drag" title={t("拖动以交换窗格位置")} aria-label={t("拖动以交换窗格位置")} draggable
          onDragStart={(e) => { e.dataTransfer.setData(PANE_DRAG, pane.id); e.dataTransfer.effectAllowed = "move"; }}><GripVertical size={13} /></button>
        {renderPane(pane, pane.id === layout.focusedId)}
      </section>)}
      {geometry.dividers.map((divider) => <div key={divider.id} className={`split-divider ${divider.axis}`} title={t("拖拽调整大小，双击均分")} onDoubleClick={() => onAction({ type: "ratio", id: divider.id, ratio: 0.5 })} style={position(divider.rect)} role="separator" tabIndex={0}
        aria-label={divider.axis === "row" ? t("调整左右窗格比例") : t("调整上下窗格比例")} aria-orientation={divider.axis === "row" ? "vertical" : "horizontal"}
        aria-valuenow={Math.round(divider.ratio * 100)} aria-valuemin={Math.round(divider.minRatio * 100)} aria-valuemax={Math.round(divider.maxRatio * 100)}
        onKeyDown={(event) => {
          const keys = divider.axis === "row" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
          if (!keys.includes(event.key) && !["Home", "End"].includes(event.key)) return;
          event.preventDefault();
          onAction({ type: "ratio", id: divider.id, ratio: event.key === "Home" ? divider.minRatio : event.key === "End" ? divider.maxRatio : divider.ratio + (event.key === keys[0] ? -.03 : .03) });
        }}
        onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = divider; setResizing(true); document.body.classList.add("layout-resizing"); }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current) return;
          const box = canvas.current.getBoundingClientRect(), row = current.axis === "row";
          const ratio = (row ? event.clientX - box.left - current.parent.left : event.clientY - box.top - current.parent.top) / ((row ? current.parent.width : current.parent.height) - 6);
          pendingRatio.current = { type: "ratio", id: current.id, ratio };
          if (!ratioFrame.current) ratioFrame.current = requestAnimationFrame(flushRatio);
        }} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} />)}
      {resizing && <div className="split-resize-shield" aria-hidden="true" />}
    </div></div>
    <div className={`split-toolbar${panes.length === 1 ? " single-pane" : ""}`}>
      <label className="pane-switcher"><span>{t("窗格")}</span><select aria-label={t("当前聊天窗格")} value={layout.focusedId} onChange={(event) => onAction({ type: "focus", paneId: event.target.value })}>
        {panes.map((pane, index) => <option key={pane.id} value={pane.id}>{switchLabel(pane, index)}</option>)}
      </select></label>
      <span className="split-toolbar-spacer" />
      <button type="button" className="icon-ghost split-desktop" disabled={panes.length >= 256} title={t("左右拆分当前窗格 (Ctrl+\\)")} aria-label={t("左右拆分当前窗格")} onClick={() => onAction({ type: "split", axis: "row" })}><Columns2 size={15} /></button>
      <button type="button" className="icon-ghost split-desktop" disabled={panes.length >= 256} title={t("上下拆分当前窗格 (Ctrl+Shift+\\)")} aria-label={t("上下拆分当前窗格")} onClick={() => onAction({ type: "split", axis: "column" })}><Rows2 size={15} /></button>
      {panes.length > 1 && <button type="button" className="icon-ghost" title={t("关闭当前窗格（任务继续运行, Alt+Shift+W）")} aria-label={t("关闭当前窗格")} onClick={() => onAction({ type: "close" })}><X size={15} /></button>}
    </div>
  </section>;
}
