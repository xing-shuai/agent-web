import React, { useEffect, useRef, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { useLayer } from "../layers.js";
import { useEnvironment } from "../environmentContext.js";
import { t } from "../i18n.js";

const fmtReset = (ts) => {
  if (!ts) return "";
  const diff = ts - Date.now();
  if (diff <= 0) return t("即将重置");
  const h = Math.floor(diff / 3.6e6);
  const dd = Math.floor(h / 24);
  if (dd > 0) return t("{v0} 天后重置", { v0: dd });
  if (h > 0) return t("{v0} 小时后重置", { v0: h });
  return t("{v0} 分钟后重置", { v0: Math.max(1, Math.floor(diff / 60000)) });
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
              {t("计费周期 {v0} ~ {v1}", { v0: src.period.start ? new Date(src.period.start).toLocaleDateString() : "?", v1: new Date(src.period.end).toLocaleDateString() })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Account quota: a single toolbar button showing the remaining quota of the
 *  source matching the active session's agent/model provider (Devin plan for
 *  devin sessions, the pi provider for pi sessions; global lowest otherwise).
 *  Clicking opens a popover with every source's detail. 5 min refresh. */
export default function AccountUsage({ agent, provider }) {
  const { api } = useEnvironment();
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

  useLayer({ open, ref, onClose: () => setOpen(false), initialFocus: false });

  const sources = data?.sources || [];
  if (err || sources.length === 0) return null;

  // Pick the source backing the active session; fall back to the global lowest.
  let shown = null;
  if (agent === "devin") shown = sources.find((s) => s.id === "devin") || null;
  else if (agent === "pi") {
    const want = provider?.includes("codex") ? "pi-codex" : provider?.includes("deepseek") ? "pi-deepseek" : null;
    shown =
      (want && sources.find((s) => s.id === want)) ||
      sources.find((s) => s.agent === "pi" && s.rows?.length) ||
      sources.find((s) => s.agent === "pi") ||
      null;
  }
  const rowPool = shown ? shown.rows || [] : sources.flatMap((s) => s.rows || []);
  const lowRow = rowPool.filter((r) => Number.isFinite(r.remaining)).sort((a, b) => a.remaining - b.remaining)[0];
  const lowCls = lowRow ? cls(lowRow.remaining) : "";
  const title = t("{v0}用量{v1}", { v0: shown?.name || t("账户"), v1: lowRow ? t(" · {v0}剩余 {v1}%", { v0: lowRow.label || lowRow.short || t("额度"), v1: lowRow.remaining }) : "" });

  return (
    <div className="acct-pop" ref={ref}>
      <button
        className={"icon-ghost acct-btn" + (open ? " on" : "")}
        title={title}
        aria-label={title}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Gauge size={15} />
        {lowRow ? (
          <span className={"acct-lowest " + lowCls}>
            <span className="acct-period">{lowRow.short} </span><span className="acct-value">{lowRow.remaining}%</span>
          </span>
        ) : (
          shown?.mini && <span className="acct-lowest">{shown.mini}</span>
        )}
      </button>
      {open && (
        <div className="acct-panel">
          {sources.map((src) => (
            <SourceSection key={src.id} src={src} />
          ))}
          <button className="acct-reload" onClick={load}>
            <RefreshCw size={11} /> {t("刷新")}
          </button>
        </div>
      )}
    </div>
  );
}
