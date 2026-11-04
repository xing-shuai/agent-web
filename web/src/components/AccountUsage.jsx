import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
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

/** Per-account quota widget — one compact row per backing subscription
 *  (Devin plan, ChatGPT/Codex, DeepSeek balance…), expanding into per-source
 *  detail sections. Auto-refreshes every 5 min. */
export default function AccountUsage() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(null);

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

  const sources = data?.sources || [];
  if (err || sources.length === 0) return null;

  return (
    <div className="acct-usage">
      {sources.map((src) => (
        <button
          key={src.id}
          className="acct-head"
          onClick={() => setOpen((o) => !o)}
          title={`${src.name}${src.plan ? " " + src.plan : ""} 用量 · 点击查看详情`}
        >
          <span className="acct-name">{src.name}</span>
          <span className="acct-mini">
            {src.error ? (
              <span className="acct-item red">!</span>
            ) : (
              <>
                {(src.rows || []).slice(0, 2).map((r) => (
                  <span key={r.id} className={"acct-item " + cls(r.remaining)}>
                    {r.short} {r.remaining}%
                  </span>
                ))}
                {!src.rows?.length && src.mini && <span className="acct-item">{src.mini}</span>}
              </>
            )}
          </span>
        </button>
      ))}
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
