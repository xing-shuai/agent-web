import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLayer, layerBlocks } from "../layers.js";
import { useEnvironment } from "../environmentContext.js";
import useCopyText from "../hooks/useCopyText.js";
import DialogResize, { DialogMaximize, readDialogSize } from "./DialogResize.jsx";
import { Check, Columns2, MessageSquareDashed, Pin, PinOff, Plus, X } from "lucide-react";
import { t } from "../i18n.js";

const fmtBytes = (n) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

/** Three-action finish confirm — ConfirmDialog styling, focus lands on 取消. */
function FinishDialog({ info, busy, onKeep, onDelete, onCancel }) {
  const panelRef = useRef(null), cancelRef = useRef(null);
  useLayer({ ref: panelRef, modal: true, onClose: onCancel, initialFocus: cancelRef });
  return createPortal(
    <div className="modal-back" onClick={busy ? undefined : onCancel}>
      <div ref={panelRef} role="alertdialog" aria-modal="true" aria-label={t("结束快速对话")} tabIndex={-1} className="modal confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{t("结束快速对话")}</h3></div>
        <p className="confirm-msg">{t("目录 {v0} 中有 {v1} 个文件（{v2}）", { v0: info.dir, v1: info.entries, v2: fmtBytes(info.bytes) })}</p>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="secondary" disabled={busy} onClick={onCancel}>{t("取消")}</button>
          <button type="button" className="secondary" disabled={busy} onClick={onKeep}>{t("保留文件")}</button>
          <button type="button" disabled={busy} onClick={onDelete} style={{ background: "var(--red)", color: "#fff" }}>
            {busy ? t("正在结束…") : t("删除文件")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Local-only quick chat as a centered modal: a scratch session that keeps its
 *  subscription while hidden (visibility, never unmounted). Children are the
 *  PaneChat content. */
export default function QuickChat({ open, sessionId, session, agentName, children, onHide, onOpenInPane, onFinished, notify }) {
  const env = useEnvironment();
  const panelRef = useRef(null);
  const [storedSize] = useState(() => readDialogSize("dw.quick.size"));
  const [pinned, setPinned] = useState(() => localStorage.getItem("dw.quick.pinned") === "1");
  const [finishInfo, setFinishInfo] = useState(null);
  const [finishing, setFinishing] = useState(false);
  const thenNewRef = useRef(false);
  const { copied, copy } = useCopyText();
  useEffect(() => { try { localStorage.setItem("dw.quick.pinned", pinned ? "1" : "0"); } catch {} }, [pinned]);

  // layers' capture-phase Escape is off so it can't steal Escape from the
  // composer's @-mention/slash menus or transcript search; handled below.
  useLayer({ open, ref: panelRef, modal: true, outside: !pinned, escape: false, onClose: onHide, initialFocus: ".quick-body textarea" });

  // Autofocus the composer on open (desktop only — focusing pops the IME on
  // touch). Retry briefly: the composer can mount after the layer's one-shot
  // initialFocus while history is still loading. Don't steal focus if the
  // user already moved it inside the chat body or a layer above opened.
  useEffect(() => {
    if (!open || window.matchMedia?.("(pointer: coarse)")?.matches) return;
    let raf = 0;
    const deadline = performance.now() + 2000;
    const tryFocus = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const ta = panel.querySelector("textarea.input-ta");
      const ownFocus = document.activeElement;
      const userMoved = panel.querySelector(".quick-body")?.contains(ownFocus) && ownFocus !== ta;
      if (ta && !ta.disabled && !userMoved && !layerBlocks(panel)) { ta.focus({ preventScroll: true }); return; }
      if (!userMoved && performance.now() < deadline) raf = requestAnimationFrame(tryFocus);
    };
    raf = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(raf);
  }, [open, sessionId]);

  const doFinish = useCallback(async (files) => {
    setFinishing(true);
    try {
      await env.api.post(`/api/sessions/${encodeURIComponent(sessionId)}/scratch/finish`, { files });
      setFinishInfo(null);
      onFinished(thenNewRef.current);
      return true;
    } catch (e) {
      notify({ host: "", kind: "error", text: e.message || t("操作失败，请重试") });
      return false;
    } finally {
      setFinishing(false);
    }
  }, [env, sessionId, onFinished, notify]);

  // Zero-entry dirs finish silently; otherwise ask keep/delete/cancel.
  const finishFlow = useCallback(async (thenNew) => {
    thenNewRef.current = thenNew;
    try {
      const info = await env.api.get(`/api/sessions/${encodeURIComponent(sessionId)}/scratch`);
      if (!info.entries) await doFinish("delete");
      else setFinishInfo(info);
    } catch (e) {
      notify({ host: "", kind: "error", text: e.message || t("操作失败，请重试") });
    }
  }, [env, sessionId, doFinish, notify]);

  const onKeyDown = (e) => {
    if (e.key !== "Escape" || !open) return;
    if (e.defaultPrevented || e.isComposing) return;
    // ChatView's own handler closes transcript search — don't hide under it.
    if (panelRef.current?.querySelector(".ts-search")) return;
    if (layerBlocks(panelRef.current)) return; // a layer above owns Escape
    e.stopPropagation();
    onHide();
  };

  const busy = !!(session?.running || session?.queue?.length || session?.pendingPermissions?.length || session?.pendingElicitations?.length);
  const busyTitle = t("会话仍在运行或有待处理项，完成或停止后才能结束");

  return createPortal(
    <div className={"modal-back quick-back" + (open ? " open" : "")} inert={!open} aria-hidden={!open}>
      <section
        ref={panelRef}
        className={"quick-panel" + (open ? " open" : "") + (pinned ? " pinned" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={t("快速对话")}
        style={storedSize ? { width: storedSize.width, height: storedSize.height } : undefined}
        onKeyDown={onKeyDown}
      >
        <header className="quick-head">
          <span className="quick-title"><MessageSquareDashed size={15} />{t("快速对话")}</span>
          {agentName && <span className="quick-agent">{agentName}</span>}
          {session?.cwd && (
            <button type="button" className="quick-dir" title={t("点击复制路径")} onClick={() => copy(session.cwd)}>
              {copied ? t("已复制") : session.cwd}
            </button>
          )}
          <span className="quick-spacer" />
          <button type="button" className="icon-ghost" title={busy ? busyTitle : t("结束此对话并开始新对话")} aria-label={t("新对话")} disabled={busy || finishing} onClick={() => finishFlow(true)}><Plus size={15} /></button>
          <button type="button" className="icon-ghost" title={t("在窗格中打开")} aria-label={t("在窗格中打开")} onClick={onOpenInPane}><Columns2 size={15} /></button>
          <button type="button" className="icon-ghost" title={busy ? busyTitle : t("结束并归档此快速对话")} aria-label={t("结束")} disabled={busy || finishing} onClick={() => finishFlow(false)}><Check size={15} /></button>
          <DialogMaximize target={panelRef} storageKey="dw.dialogMax.quick" />
          <button type="button" className={"icon-ghost" + (pinned ? " on" : "")} aria-pressed={pinned} title={pinned ? t("取消固定：点击外部自动收起") : t("固定：点击外部仍保持打开")} aria-label={pinned ? t("取消固定快速对话") : t("固定快速对话")} onClick={() => setPinned((v) => !v)}>{pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>
          <button type="button" className="icon-ghost" title={t("关闭")} aria-label={t("关闭快速对话")} onClick={onHide}><X size={15} /></button>
        </header>
        <div className="quick-body">{children}</div>
        {finishInfo && (
          <FinishDialog
            info={finishInfo}
            busy={finishing}
            onKeep={() => doFinish("keep")}
            onDelete={() => doFinish("delete")}
            onCancel={() => setFinishInfo(null)}
          />
        )}
        <DialogResize target={panelRef} storageKey="dw.quick.size" />
      </section>
    </div>,
    document.body
  );
}
