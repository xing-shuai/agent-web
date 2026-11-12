import React, { useContext, useId, useLayoutEffect, useRef, useState } from "react";
import { Brain, Check, ChevronRight, Layers, Loader2, X } from "lucide-react";
import { toolIcon, toolPresentation } from "./ToolCall.jsx";
import { TranscriptSearch } from "../transcriptSearch.js";
import { t } from "../i18n.js";
import Disclosure from "./Disclosure.jsx";

/** Opt-in live block: manual toggles last until the lifecycle changes. */
export default function StreamBlock({ item, active, children }) {
  const [disclosure, setDisclosure] = useState({ active, open: active });
  // Reset before paint, including when a manually opened live block finishes.
  if (disclosure.active !== active) setDisclosure({ active, open: active });
  const search = useContext(TranscriptSearch);
  const searchOpen = search.keys.has(item.key);
  const open = searchOpen || (disclosure.active === active ? disclosure.open : active);
  const bodyId = useId();
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const stickRef = useRef(true);
  const isTool = item.kind === "tool";
  const isGroup = item.kind === "toolgroup";
  const tools = isGroup ? item.items.filter((it) => it.kind === "tool") : [];
  const Icon = isGroup ? Layers : isTool ? toolIcon(item) : Brain;
  const presentation = isTool ? toolPresentation(item) : null;
  const title = isGroup ? t("思考与工具调用") : isTool ? presentation.label : t("思考过程");
  const preview = isGroup ? t("{v0} 次工具调用 · {v1} 段思考", { v0: tools.length, v1: item.items.length - tools.length }) :
    isTool ? presentation.summary : (item.text || "").replace(/\s+/g, " ").trim().slice(0, 140);
  const failed = isGroup ? tools.some((it) => it.status === "failed") : isTool && item.status === "failed";

  useLayoutEffect(() => {
    if (!open) return;
    stickRef.current = true;
  }, [open]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !open || !active || searchOpen) return;
    const pin = () => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    };
    pin();
    // Also follow late image loads and markdown reflow, not just text deltas.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(pin);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [item, open, active, searchOpen]);

  const pauseForDisclosure = (event) => {
    if (event.target.closest?.("summary, .stream-head, .tool-head, .tg-head") || ["PageUp", "Home", "ArrowUp"].includes(event.key)) stickRef.current = false;
  };

  return (
    <section data-search-key={item.key} className={`stream-block${isGroup ? " stream-root" : ""}${open ? " open" : ""}${active ? " live" : ""}${searchOpen ? " search-open" : ""}`}>
      <button
        className="stream-head"
        aria-expanded={open}
        aria-controls={bodyId}
        title={presentation?.internal}
        onClick={() => { if (!searchOpen) setDisclosure({ active, open: !open }); }}
      >
        <Icon size={14} />
        <span className="stream-title">{title}</span>
        <span className="stream-preview">{preview}</span>
        {(active || failed || isTool) && <span className={`stream-status${failed ? " failed" : ""}`} title={active ? t("进行中") : failed ? t("失败") : t("已结束")}>
          {active ? <Loader2 size={13} className="spin" /> : failed ? <X size={13} /> : <Check size={13} />}
        </span>}
        <ChevronRight size={13} className="stream-chev" />
      </button>
      <Disclosure className="stream-reveal" clipClassName="stream-clip" id={bodyId} open={open} instant={searchOpen}>
          <div
            className="stream-scroll"
            ref={scrollRef}
            onPointerDown={pauseForDisclosure}
            onKeyDown={pauseForDisclosure}
            onWheel={(event) => { if (event.deltaY < 0) stickRef.current = false; }}
            onTouchStart={() => { stickRef.current = false; }}
            onScroll={(e) => {
              if (e.target !== e.currentTarget) return;
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            <div className="stream-content" ref={contentRef}>{children}</div>
          </div>
      </Disclosure>
    </section>
  );
}
