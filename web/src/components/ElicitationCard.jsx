import React, { useMemo, useState } from "react";
import { HelpCircle, X } from "lucide-react";

/** ACP elicitation/create — the agent asks a structured question.
 *  Schema-driven form: enum/oneOf → single-select chips, array → multi-select
 *  chips, boolean → yes/no, number/integer → numeric input, string → text.
 *  Responds {action:"accept",content} | {action:"decline"}. */
export default function ElicitationCard({ pendingElicitations, onAnswer, agentName = "Devin" }) {
  const [answered, setAnswered] = useState(() => new Set());
  if (!pendingElicitations?.length) return null;
  const done = (requestId, action, content) => {
    setAnswered((s) => new Set(s).add(requestId));
    onAnswer(requestId, action, content);
  };
  return (
    <div className="perm-stack col">
      {pendingElicitations.map((e) => (
        <ElicitForm key={e.requestId} e={e} agentName={e.agentName || agentName} disabled={answered.has(e.requestId)} onDone={done} />
      ))}
    </div>
  );
}

function ElicitForm({ e, agentName, disabled, onDone }) {
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
        {agentName} 提问<strong>{e.message || schema.title || "请回答"}</strong>
      </div>
      {schema.description && <div className="elic-desc">{schema.description}</div>}
      {fields.map(([name, p]) => (
        <Field key={name} name={name} p={p} value={values[name]} req={required.includes(name)} onChange={(v) => set(name, v)} disabled={disabled} />
      ))}
      <div className="perm-actions">
        <button
          className="primary"
          disabled={disabled || missing.length > 0}
          title={missing.length ? `还有必填项: ${missing.join(", ")}` : ""}
          onClick={() => onDone(e.requestId, "accept", values)}
        >
          提交
        </button>
        <button className="danger-ghost" disabled={disabled} onClick={() => onDone(e.requestId, "decline")}>
          <X size={13} /> 拒绝
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
            { v: true, t: "是" },
            { v: false, t: "否" },
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
