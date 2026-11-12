import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLayer } from "../layers.js";
import { AlertTriangle } from "lucide-react";
import { t } from "../i18n.js";

/** Destructive confirmation: focus cancellation, activate only the focused action. */
export default function ConfirmDialog({ title, message, confirmLabel = t("确认"), onConfirm, onCancel }) {
  const panelRef = useRef(null), cancelRef = useRef(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [uncertain, setUncertain] = useState(false);
  const [progress, setProgress] = useState(null);
  const cancel = () => { if (!busy) onCancel(); };
  useLayer({ ref: panelRef, modal: true, onClose: cancel, initialFocus: cancelRef });
  const confirm = async () => {
    if (busy || uncertain) return;
    setBusy(true); setError(null);
    try { await onConfirm({ onProgress: setProgress }); } catch (e) { setError(e.message || t("操作失败，请重试")); setUncertain(!!e.outcomeUnknown); }
    finally { setBusy(false); setProgress(null); }
  };

  return createPortal(
    <div className="modal-back" onClick={cancel}>
      <div ref={panelRef} role="alertdialog" aria-modal="true" aria-label={title} tabIndex={-1} className="modal confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={16} style={{ color: "var(--red)" }} />
            {title}
          </h3>
        </div>
        <p className="confirm-msg">{message}</p>
        {error && <p className="confirm-msg error-line" role="alert">{error}</p>}
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="secondary" disabled={busy} onClick={cancel}>
            {uncertain ? t("关闭") : t("取消")}
          </button>
          <button
            type="button"
            disabled={busy || uncertain}
            onClick={confirm}
            style={{ background: "var(--red)", color: "#fff" }}
          >
            {busy ? progress || t("处理中…") : uncertain ? t("结果待核对") : confirmLabel}
          </button>
        </div>
      </div>
    </div>, document.body
  );
}
