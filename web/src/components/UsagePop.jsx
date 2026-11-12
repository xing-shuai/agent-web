import React, { useRef, useState } from "react";
import { useLayer } from "../layers.js";
import { ChartColumn } from "lucide-react";
import { t } from "../i18n.js";

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n ?? "–"));

/** Context-usage popover: current usage + a sparkline of recent samples.
 *  `stats` (pi sessions): aggregate token/cost totals mined from the session
 *  file — same numbers pi-open-tui's footer shows. */
export default function UsagePop({ usage, hist, byAgent, stats, up = false, trigger }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useLayer({ open, ref, onClose: () => setOpen(false), initialFocus: false });

  if (!usage?.size && !stats) return null;
  const known = Number.isFinite(usage?.used);
  const pct = usage?.size && known ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : null;
  const approximate = usage?.estimated ? "≈" : "";
  const cls = pct > 90 ? "red" : pct > 70 ? "amber" : "";

  // sparkline from usage history samples (percentage of window used)
  const pts = (hist || []).filter((h) => h.size && Number.isFinite(h.used)).map((h) => (h.used / h.size) * 100);
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
      <button type="button" className={"ctx-meter " + cls} aria-expanded={open} onClick={() => setOpen((o) => !o)} title={t("上下文用量详情{v0}", { v0: pct == null ? t("：待更新") : `：${approximate}${pct}%` })}>
        {trigger ?? (
          <>
            <ChartColumn size={13} />
            <span>
              {pct != null ? `${approximate}${pct}% · ${fmt(usage.used)}` : t("待更新")}
            </span>
          </>
        )}
      </button>
      {open && (
        <div className={"usage-panel" + (up ? " up" : "")}>
          {usage?.size && (
            <>
              <div className="usage-row">
                <span>{t("上下文")}{usage.estimated ? t("（估算）") : ""}</span>
                <strong title={known ? t("{v0}{v1} / {v2} tokens", { v0: approximate, v1: usage.used.toLocaleString(), v2: usage.size.toLocaleString() }) : t("等待模型用量")}>
                  {known ? t("{v0}{v1}", { v0: approximate, v1: fmt(usage.used) }) : t("待更新")} / {fmt(usage.size)}
                </strong>
              </div>
              <div className="usage-bar">
                <div className={cls} style={{ width: `${pct ?? 0}%` }} />
              </div>
              {usage.estimated && <div className="usage-sub">{usage.source === "mixed" ? t("含新增消息估算，待下次模型用量校准。") : t("上下文估算，待下次模型用量校准。")}</div>}
            </>
          )}
          {stats && (
            <div className="usage-rows">
              <div className="usage-sub" style={{ margin: "0 0 2px" }}>
                {t("会话累计")}
              </div>
              <div className="usage-sub">{t("历史调用总量，不随上下文压缩减少。")}</div>
              <div className="usage-row">
                <span>{t("输入")}</span>
                <strong>{fmt(stats.input)}</strong>
              </div>
              <div className="usage-row">
                <span>{t("输出")}</span>
                <strong>{fmt(stats.output)}</strong>
              </div>
              {stats.cacheRead > 0 && (
                <div className="usage-row">
                  <span>{t("缓存读取")}</span>
                  <strong>
                    {fmt(stats.cacheRead)}
                    {stats.cacheHitRate != null && ` · ${stats.cacheHitRate.toFixed(1)}%`}
                  </strong>
                </div>
              )}
              {stats.cost > 0 && (
                <div className="usage-row">
                  <span>{t("费用")}</span>
                  <strong>${stats.cost < 1 ? stats.cost.toFixed(3) : stats.cost.toFixed(2)}</strong>
                </div>
              )}
            </div>
          )}
          {(usage?.input != null || usage?.output != null) && (
            <div className="usage-rows">
              {usage.input != null && (
                <div className="usage-row">
                  <span>{t("输入 tokens")}</span>
                  <strong>{usage.input.toLocaleString()}</strong>
                </div>
              )}
              {usage.output != null && (
                <div className="usage-row">
                  <span>{t("输出 tokens")}</span>
                  <strong>{usage.output.toLocaleString()}</strong>
                </div>
              )}
              {usage.cached != null && (
                <div className="usage-row">
                  <span>{t("缓存命中")}</span>
                  <strong>{usage.cached.toLocaleString()}</strong>
                </div>
              )}
            </div>
          )}
          {byAgent && Object.keys(byAgent).length > 1 && (
            <div className="usage-rows">
              <div className="usage-sub" style={{ margin: "0 0 2px" }}>
                {t("各 Agent 上下文")}
              </div>
              {Object.entries(byAgent).map(([agent, u]) => {
                const p = u?.size ? Math.min(100, Math.round((u.used / u.size) * 100)) : 0;
                return (
                  <div key={agent} className="usage-agent">
                    <div className="usage-row">
                      <span className="usage-agent-name">
                        {agent === "root" ? t("主 Agent") : agent}
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
              <div className="usage-sub">{t("最近 {v0} 次采样", { v0: pts.length })}</div>
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
