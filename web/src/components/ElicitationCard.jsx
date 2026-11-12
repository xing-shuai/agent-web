import React, { useMemo, useState } from "react";
import { HelpCircle, X } from "lucide-react";
import { t } from "../i18n.js";

/** ACP elicitation/create — the agent asks a structured question.
 *  Schema-driven form: enum/oneOf → single-select chips, array → multi-select
 *  chips, boolean → yes/no, number/integer → numeric input, string → text.
 *  Responds {action:"accept",content} | {action:"decline"}. */
function ElicitationCard({ pendingElicitations, onAnswer, agentName = "Devin", wsUp = true }) {
  const [answered, setAnswered] = useState(() => new Set());
  if (!pendingElicitations?.length) return null;
  const done = (requestId, action, content) => {
    // Only mark answered when the response actually left the wire — an
    // offline send keeps the card answerable instead of firing on reconnect.
    if (onAnswer(requestId, action, content) === false) return;
    setAnswered((s) => new Set(s).add(requestId));
  };
  return (
    <div className="perm-stack col">
      {pendingElicitations.map((e) => (
        <ElicitForm key={e.requestId} e={e} agentName={e.agentName || agentName} disabled={answered.has(e.requestId) || !wsUp} disabledTitle={!wsUp ? t("连接断开") : null} onDone={done} />
      ))}
    </div>
  );
}

function ElicitForm({ e, agentName, disabled, disabledTitle, onDone }) {
  const schema = e.schema || {};
  const fields = useMemo(() => Object.entries(schema.properties || {}), [schema]);
  const [values, setValues] = useState(() => {
    const init = {};
    for (const [name, p] of fields) if (p.default != null) init[name] = p.default;
    return init;
  });
  const required = schema.required || [];
  const missing = required.filter((n) => values[n] == null || values[n] === "" || (Array.isArray(values[n]) && !values[n].length));
  const set = (name, v) => setValues((o) => ({ ...o, [name]: v }));

  return (
    <div className="perm-card elic-card">
      <div className="perm-title">
        <HelpCircle size={15} />
        {t("{v0} 提问", { v0: agentName })}
      </div>
      <div className="elic-msg">{e.message || schema.title || t("请回答")}</div>
      {schema.description && schema.description !== e.message && <div className="elic-desc">{schema.description}</div>}
      {fields.map(([name, p]) => (
        <Field
          key={name} name={name}
          p={p.description && p.description === e.message ? { ...p, description: undefined } : p}
          value={values[name]} req={required.includes(name)}
          onChange={(v) => set(name, v)} disabled={disabled}
        />
      ))}
      <div className="perm-actions">
        <button
          className="primary"
          disabled={disabled || missing.length > 0}
          title={disabledTitle || (missing.length ? t("还有必填项: {v0}", { v0: missing.join(", ") }) : "")}
          onClick={() => onDone(e.requestId, "accept", values)}
        >
          {t("提交")}
        </button>
        <button className="danger-ghost" disabled={disabled} title={disabledTitle} onClick={() => onDone(e.requestId, "decline")}>
          <X size={13} /> {t("拒绝")}
        </button>
      </div>
    </div>
  );
}

function Field({ name, p, value, req, onChange, disabled }) {
  const label = (
    <div className="elic-label">
      {p.title || name}
      {req && <em>*</em>}
      {p.description && <span className="elic-field-desc">{p.description}</span>}
    </div>
  );

  // Single-select: string enum, or oneOf [{const,title}]
  const single = p.type === "string" && (p.enum || p.oneOf);
  // Multi-select: array with items.enum / items.anyOf
  const multi = p.type === "array" && (p.items?.enum || p.items?.anyOf);

  if (single) {
    const opts = p.oneOf ? p.oneOf.map((o) => ({ v: o.const, t: o.title || o.const })) : p.enum.map((v) => ({ v, t: v }));
    return (
      <div className="elic-field">
        {label}
        <div className="elic-opts">
          {opts.map((o) => (
            <button
              key={o.v}
              type="button"
              disabled={disabled}
              className={"elic-opt" + (value === o.v ? " on" : "")}
              onClick={() => onChange(value === o.v ? undefined : o.v)}
            >
              {o.t}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (multi) {
    const items = p.items.anyOf ? p.items.anyOf.map((o) => ({ v: o.const, t: o.title || o.const })) : p.items.enum.map((v) => ({ v, t: v }));
    const cur = Array.isArray(value) ? value : [];
    return (
      <div className="elic-field">
        {label}
        <div className="elic-opts">
          {items.map((o) => {
            const on = cur.includes(o.v);
            return (
              <button
                key={o.v}
                type="button"
                disabled={disabled}
                className={"elic-opt" + (on ? " on" : "")}
                onClick={() => onChange(on ? cur.filter((x) => x !== o.v) : [...cur, o.v])}
              >
                {o.t}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  if (p.type === "boolean") {
    return (
      <div className="elic-field">
        {label}
        <div className="elic-opts">
          {[
            { v: true, t: t("是") },
            { v: false, t: t("否") },
          ].map((o) => (
            <button
              key={String(o.v)}
              type="button"
              disabled={disabled}
              className={"elic-opt" + (value === o.v ? " on" : "")}
              onClick={() => onChange(o.v)}
            >
              {o.t}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (p.type === "number" || p.type === "integer") {
    return (
      <div className="elic-field">
        {label}
        <input
          className="elic-input"
          type="number"
          value={value ?? ""}
          placeholder={p.default != null ? String(p.default) : ""}
          disabled={disabled}
          onChange={(ev) => onChange(ev.target.value === "" ? undefined : Number(ev.target.value))}
        />
      </div>
    );
  }
  // Free text (also covers unknown types).
  return (
    <div className="elic-field">
      {label}
      <textarea
        className="elic-input elic-ta"
        rows={2}
        value={value ?? ""}
        placeholder={p.default ?? p.description ?? ""}
        disabled={disabled}
        onChange={(ev) => onChange(ev.target.value)}
      />
    </div>
  );
}

export default React.memo(ElicitationCard);
