import React, { useEffect, useRef, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import api from "../api.js";

const fmtReset = (ts) => {
  if (!ts) return "";
  const diff = ts - Date.now();
  if (diff <= 0) return "即将重置";
  const h = Math.floor(diff / 3.6e6);
  const dd = Math.floor(h / 24);
  if (dd > 0) return `${dd} 天后重置`;
  if (h > 0) return `${h} 小时后重置`;
  return `${Math.max(1, Math.floor(diff / 60000))} 分钟后重置`;
};

const cls = (pct) => (pct <= 10 ? "red" : pct <= 30 ? "amber" : "");

function Bar({ label, remaining, resetAt }) {
  const used = Math.max(0, Math.min(100, 100 - remaining));
  return (
    <div className="acct-row">
      <div className="acct-line">
        <span>{label}</span>
        <strong>{remaining}%</strong>
      </div>
      <div className="acct-bar">
        <div className={cls(remaining)} style={{ width: `${used}%` }} />
      </div>
      <div className="acct-sub">{fmtReset(resetAt)}</div>
    </div>
  );
}

function SourceSection({ src }) {
  return (
    <div className="acct-src">
      <div className="acct-src-title">
        <span>{src.name}</span>
        {src.plan && <em className="acct-src-plan">{src.plan}</em>}
        {src.email && <em className="acct-src-mail">{src.email}</em>}
      </div>
      {src.error ? (
        <div className="acct-err">{src.error}</div>
      ) : (
        <>
          {(src.rows || []).map((r) => (
            <Bar key={r.id} label={r.label} remaining={r.remaining} resetAt={r.resetAt} />
          ))}
          {(src.extras || []).map((e, i) => (
            <div key={i}>
              <div className="acct-line">
                <span>{e.label}</span>
                <strong>{e.value}</strong>
              </div>
              {e.sub && <div className="acct-sub">{e.sub}</div>}
            </div>
          ))}
          {src.period?.end && (
            <div className="acct-sub">
              计费周期 {src.period.start ? new Date(src.period.start).toLocaleDateString() : "?"} ~{" "}
              {new Date(src.period.end).toLocaleDateString()}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Account quota: a single toolbar button (Gauge + lowest remaining %),
 *  opening a popover with per-source detail sections. 5 min refresh. */
export default function AccountUsage() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useRef(null);

  const load = () => {
    api
      .get("/api/account/usage")
      .then((d) => {
        setData(d);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const sources = data?.sources || [];
  if (err || sources.length === 0) return null;

  const rems = sources.flatMap((s) => (s.rows || []).map((r) => r.remaining)).filter(Number.isFinite);
  const lowest = rems.length ? Math.min(...rems) : null;
  const lowCls = lowest != null ? cls(lowest) : "";

  return (
    <div className="acct-pop" ref={ref}>
      <button
        className={"icon-ghost acct-btn" + (open ? " on" : "")}
        title="账户用量"
        onClick={() => setOpen((o) => !o)}
      >
        <Gauge size={15} />
        {lowest != null && <span className={"acct-lowest " + lowCls}>{lowest}%</span>}
      </button>
      {open && (
        <div className="acct-panel">
          {sources.map((src) => (
            <SourceSection key={src.id} src={src} />
          ))}
          <button className="acct-reload" onClick={load}>
            <RefreshCw size={11} /> 刷新
          </button>
        </div>
      )}
    </div>
  );
}
