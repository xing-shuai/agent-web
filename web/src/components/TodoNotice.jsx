import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { useLayer } from "../layers.js";
import { createPortal } from "react-dom";
import { Check, ChevronUp, Circle, ListTodo, Loader2, Pause } from "lucide-react";
import { t } from "../i18n.js";

/** The open list floats over chat; its compact live status docks in the header. */
export default function TodoNotice({ tasks, dockHost, running = false }) {
  const done = tasks.filter((task) => task.status === "completed").length;
  const complete = done === tasks.length;
  const active = tasks.find((task) => task.status === "in_progress");
  const paused = !!active && !running;
  const [disclosure, setDisclosure] = useState({ complete, open: !complete });
  if (disclosure.complete !== complete) setDisclosure({ complete, open: !complete });
  const open = disclosure.complete === complete ? disclosure.open : !complete;
  const rootRef = useRef(null), triggerRef = useRef(null), dockRef = useRef(null);
  const animationRef = useRef(null), restoreFocus = useRef(false);
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  const listId = useId();
  useLayer({ open, ref: rootRef, onClose: () => { restoreFocus.current = true; setDisclosure({ complete, open: false }); },
    history: false, outside: false, passive: true, escapeFromOutside: false, initialFocus: false });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const previous = animationRef.current;
    const current = previous ? root.getBoundingClientRect() : null;
    if (previous) { previous.onfinish = null; previous.cancel(); }
    animationRef.current = null;
    root.style.removeProperty("--todo-body-width");
    if (!present) {
      if (restoreFocus.current) dockRef.current?.focus({ preventScroll: true });
      restoreFocus.current = false;
      return;
    }
    const expanded = root.getBoundingClientRect();
    const dock = dockRef.current?.getBoundingClientRect() || triggerRef.current.getBoundingClientRect();
    const reduced = document.documentElement.dataset.motion === "off" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!open) restoreFocus.current ||= root.contains(document.activeElement);
    if (reduced || !root.animate) {
      if (!open) setPresent(false);
      return;
    }
    // Right-anchored sizing plus translation moves the shell to/from the
    // actual header control; interrupted transitions start at the visible rect.
    root.style.setProperty("--todo-body-width", `${root.clientWidth}px`);
    const frame = (rect) => ({ width: `${rect.width}px`, height: `${rect.height}px`,
      transform: `translate(${rect.right - expanded.right}px, ${rect.top - expanded.top}px)` });
    const animation = root.animate([frame(current || (open ? dock : expanded)), frame(open ? expanded : dock)], {
      duration: open ? 260 : 220, easing: open ? "cubic-bezier(.2,.8,.2,1)" : "cubic-bezier(.4,0,.8,.2)", fill: "forwards",
    });
    animationRef.current = animation;
    animation.onfinish = () => {
      if (animationRef.current !== animation) return;
      if (!open) { setPresent(false); return; }
      animationRef.current = null;
      animation.cancel();
      root.style.removeProperty("--todo-body-width");
    };
  }, [open, present, dockHost]);

  useLayoutEffect(() => () => {
    const animation = animationRef.current;
    if (animation) { animation.onfinish = null; animation.cancel(); }
    animationRef.current = null;
  }, []);

  const label = t("任务列表，{v0}/{v1} 已完成{v2}", { v0: done, v1: tasks.length, v2: active ? paused ? t("，已暂停") : t("，进行中") : "" });
  const icon = complete ? <Check size={14} /> : paused ? <Pause size={14} /> : active ? <Loader2 size={14} className="spin" /> : <ListTodo size={14} />;
  const toggle = () => setDisclosure({ complete, open: !open });
  const dock = (
    <button ref={dockRef} type="button" className={`todo-dock-trigger${complete ? " complete" : ""}`}
      style={{ visibility: present ? "hidden" : undefined }} tabIndex={present ? -1 : 0} aria-hidden={present}
      aria-label={label} title={paused ? label : active?.activeForm || active?.subject || label} aria-expanded={open}
      aria-controls={present ? listId : undefined} onClick={toggle}>
      {icon}<span className="todo-label">Todo</span>
      <span className="todo-progress" role="status">{done}/{tasks.length}{paused && <> · {t("已暂停")}</>}</span>
    </button>
  );

  return <>
    {dockHost && createPortal(dock, dockHost)}
    <aside ref={rootRef} hidden={!present} className={`todo-notice${open ? " open" : present ? " closing" : ""}${complete ? " complete" : ""}`}
      aria-label={t("当前会话任务")} onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation(); restoreFocus.current = true;
          setDisclosure({ complete, open: false });
        }
      }}>
      <button ref={triggerRef} type="button" className="todo-notice-head" aria-label={label}
        title={t("收起到顶栏")} aria-expanded={open} aria-controls={present ? listId : undefined} onClick={toggle}>
        {icon}<span className="todo-label">Todo</span>
        <span className="todo-progress" role="status">{done}/{tasks.length}{complete ? t(" 已完成") : paused ? <> · {t("已暂停")}</> : ""}</span>
        <ChevronUp size={12} className="todo-chevron" />
      </button>
      {present && <ul id={listId} className="todo-entries" aria-label={t("任务列表")} tabIndex={open ? 0 : -1} inert={!open} aria-hidden={!open}>
        {tasks.map((task) => {
          const paused = task.status === "in_progress" && !running;
          return <li key={task.id} className={`todo-entry ${paused ? "paused" : task.status}`} data-status={task.status}>
            <span className="todo-check" role="checkbox" aria-checked={task.status === "completed"} aria-readonly="true"
              aria-label={task.status === "completed" ? t("已完成") : paused ? t("已暂停") : task.status === "in_progress" ? t("进行中") : t("待处理")}>
              {task.status === "completed" ? <Check size={14} /> : paused ? <Pause size={13} /> : task.status === "in_progress" ?
                <Loader2 size={13} className="spin" /> : <Circle size={13} />}
            </span>
            <span title={task.subject}>{task.status === "in_progress" && running && task.activeForm ? task.activeForm : task.subject}
              {paused && <span className="todo-progress"> · {t("已暂停")}</span>}
            </span>
          </li>;
        })}
      </ul>}
    </aside>
  </>;
}
