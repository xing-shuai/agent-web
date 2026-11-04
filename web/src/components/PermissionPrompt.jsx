import React, { useState } from "react";
import { HelpCircle, ShieldAlert, X } from "lucide-react";

export default function PermissionPrompt({ pendingPermissions, onPermission, agentName = "Devin" }) {
  // Disable a card's buttons the moment it's answered — the resolved event
  // may take a beat, and a double click would answer the JSON-RPC twice.
  const [answered, setAnswered] = useState(() => new Set());
  if (!pendingPermissions?.length) return null;
  const answer = (requestId, optionId) => {
    setAnswered((s) => new Set(s).add(requestId));
    onPermission(requestId, optionId);
  };
  return (
    <div className="perm-stack col">
      {pendingPermissions.map((p) => {
        // pi-acp bridges extension_ui select/confirm into permission requests
        // with pi-ui-* toolCallIds — those are questions, not permission asks:
        // render the dialog title as the prompt and hide the raw JSON blob.
        const isUiDialog = String(p.toolCall?.toolCallId || "").startsWith("pi-ui-");
        return (
        <div key={p.requestId} className="perm-card">
          <div className="perm-title">
            {isUiDialog ? <HelpCircle size={15} /> : <ShieldAlert size={15} />}
            {agentName} {isUiDialog ? "提问" : "请求权限"}
            {!isUiDialog && <strong>{p.toolCall?.title || p.toolCall?.toolCallId || "操作"}</strong>}
          </div>
          {isUiDialog && <div className="elic-msg">{p.toolCall?.title || "请回答"}</div>}
          {!isUiDialog && p.toolCall?.rawInput != null && (
            <pre className="perm-input">
              {typeof p.toolCall.rawInput === "string"
                ? p.toolCall.rawInput.slice(0, 2000)
                : JSON.stringify(p.toolCall.rawInput, null, 2).slice(0, 2000)}
            </pre>
          )}
          <div className="perm-actions">
            {p.options.map((o) => (
              <button
                key={o.optionId}
                disabled={answered.has(p.requestId)}
                className={/allow|approve|yes|always/i.test(o.kind || o.optionId + o.name) ? "primary" : "secondary"}
                onClick={() => answer(p.requestId, o.optionId)}
              >
                {o.name}
              </button>
            ))}
            <button
              className="danger-ghost"
              disabled={answered.has(p.requestId)}
              onClick={() => answer(p.requestId, null)}
            >
              <X size={13} /> 拒绝
            </button>
          </div>
        </div>
        );
      })}
    </div>
  );
}
