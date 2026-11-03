import React, { useEffect, useState } from "react";
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

/** Account plan quota card — daily/weekly remaining % from the seat-management
 *  RPC, same data the CLI /usage panel shows. Auto-refreshes every 5 min. */
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

  if (err || !data) return null;
  const showDaily = data.daily && !data.hideDaily;

  return (
    <div className="acct-usage">
      <button className="acct-head" onClick={() => setOpen((o) => !o)} title="套餐配额 · 点击查看详情">
        <Gauge size={13} />
        <span className="acct-plan">{data.plan || "Devin"}</span>
        <span className="acct-mini">
          {showDaily && (
            <span className={"acct-item " + cls(data.daily.remaining)}>日 {data.daily.remaining}%</span>
          )}
          {data.weekly && (
            <span className={"acct-item " + cls(data.weekly.remaining)}>周 {data.weekly.remaining}%</span>
          )}
        </span>
      </button>
      {open && (
        <div className="acct-panel">
          {showDaily && (
            <Bar label="日配额剩余" remaining={data.daily.remaining} resetAt={data.daily.resetAt} />
          )}
          {data.weekly && (
            <Bar label="周配额剩余" remaining={data.weekly.remaining} resetAt={data.weekly.resetAt} />
          )}
          {data.overageMicros != null && data.overageMicros !== 0 && (
            <div className="acct-line">
              <span>超额余额</span>
              <strong>{(data.overageMicros / 1e6).toFixed(2)}</strong>
            </div>
          )}
          {data.promptCredits != null && data.promptCredits >= 0 && (
            <div className="acct-line">
              <span>剩余额度</span>
              <strong>{data.promptCredits}</strong>
            </div>
          )}
          {data.planEnd && (
            <div className="acct-sub">
              计费周期 {new Date(data.planStart).toLocaleDateString()} ~ {new Date(data.planEnd).toLocaleDateString()}
            </div>
          )}
          <button className="acct-reload" onClick={load}>
            <RefreshCw size={11} /> 刷新
          </button>
        </div>
      )}
    </div>
  );
}
