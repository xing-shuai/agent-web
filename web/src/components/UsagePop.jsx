import React, { useEffect, useRef, useState } from "react";
import { ChartColumn } from "lucide-react";

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n ?? "–"));

/** Context-usage popover: current usage + a sparkline of recent samples.
 *  `stats` (pi sessions): aggregate token/cost totals mined from the session
 *  file — same numbers pi-open-tui's footer shows. */
export default function UsagePop({ usage, hist, byAgent, stats, up = false, trigger }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!usage?.size && !stats) return null;
  const pct = usage?.size ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : null;
  const cls = pct > 90 ? "red" : pct > 70 ? "amber" : "";

  // sparkline from usage history samples (percentage of window used)
  const pts = (hist || []).filter((h) => h.size).map((h) => (h.used / h.size) * 100);
  const w = 120;
  const h = 28;
  const path =
    pts.length > 1
      ? pts
          .map((p, i) => `${(i / (pts.length - 1)) * w},${h - 2 - (p / 100) * (h - 4)}`)
          .join(" ")
      : null;

  return (
    <div className="usage-pop" ref={ref}>
      <button className={"ctx-meter " + cls} onClick={() => setOpen((o) => !o)} title="上下文用量详情">
        {trigger ?? (
          <>
            <ChartColumn size={13} />
            <span>
              {pct != null ? `${pct}% · ${fmt(usage.used)}` : fmt(stats?.input + stats?.output)}
            </span>
          </>
        )}
      </button>
      {open && (
        <div className={"usage-panel" + (up ? " up" : "")}>
          {usage?.size && (
            <>
              <div className="usage-row">
                <span>上下文</span>
                <strong>
                  {fmt(usage.used)} / {fmt(usage.size)}
                </strong>
              </div>
              <div className="usage-bar">
                <div className={cls} style={{ width: `${pct}%` }} />
              </div>
            </>
          )}
          {stats && (
            <div className="usage-rows">
              <div className="usage-sub" style={{ margin: "0 0 2px" }}>
                会话累计
              </div>
              <div className="usage-row">
                <span>输入</span>
                <strong>{fmt(stats.input)}</strong>
              </div>
              <div className="usage-row">
                <span>输出</span>
                <strong>{fmt(stats.output)}</strong>
              </div>
              {stats.cacheRead > 0 && (
                <div className="usage-row">
                  <span>缓存读取</span>
                  <strong>
                    {fmt(stats.cacheRead)}
                    {stats.cacheHitRate != null && ` · ${stats.cacheHitRate.toFixed(1)}%`}
                  </strong>
                </div>
              )}
              {stats.cost > 0 && (
                <div className="usage-row">
                  <span>费用</span>
                  <strong>${stats.cost < 1 ? stats.cost.toFixed(3) : stats.cost.toFixed(2)}</strong>
                </div>
              )}
            </div>
          )}
          {(usage?.input != null || usage?.output != null) && (
            <div className="usage-rows">
              {usage.input != null && (
                <div className="usage-row">
                  <span>输入 tokens</span>
                  <strong>{usage.input.toLocaleString()}</strong>
                </div>
              )}
              {usage.output != null && (
                <div className="usage-row">
                  <span>输出 tokens</span>
                  <strong>{usage.output.toLocaleString()}</strong>
                </div>
              )}
              {usage.cached != null && (
                <div className="usage-row">
                  <span>缓存命中</span>
                  <strong>{usage.cached.toLocaleString()}</strong>
                </div>
              )}
            </div>
          )}
          {byAgent && Object.keys(byAgent).length > 1 && (
            <div className="usage-rows">
              <div className="usage-sub" style={{ margin: "0 0 2px" }}>
                各 Agent 上下文
              </div>
              {Object.entries(byAgent).map(([agent, u]) => {
                const p = u?.size ? Math.min(100, Math.round((u.used / u.size) * 100)) : 0;
                return (
                  <div key={agent} className="usage-agent">
                    <div className="usage-row">
                      <span className="usage-agent-name">
                        {agent === "root" ? "主 Agent" : agent}
                      </span>
                      <strong>
                        {fmt(u?.used)} / {fmt(u?.size)}
                      </strong>
                    </div>
                    <div className="usage-bar">
                      <div
                        className={p > 90 ? "red" : p > 70 ? "amber" : ""}
                        style={{ width: `${p}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {path && (
            <>
              <div className="usage-sub">最近 {pts.length} 次采样</div>
              <svg className="usage-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
                <polyline points={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
              </svg>
            </>
          )}
        </div>
      )}
    </div>
  );
}
