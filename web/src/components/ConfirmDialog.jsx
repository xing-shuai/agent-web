import React, { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

/** Modal confirmation dialog. Esc cancels, Enter confirms. */
export default function ConfirmDialog({ title, message, confirmLabel = "确认", onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel]);

  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={16} style={{ color: "var(--red)" }} />
            {title}
          </h3>
        </div>
        <p className="confirm-msg">{message}</p>
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            取消
          </button>
          <button
            autoFocus
            onClick={onConfirm}
            style={{ background: "var(--red)", color: "#fff" }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
