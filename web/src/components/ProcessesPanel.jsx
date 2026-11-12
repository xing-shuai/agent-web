import DialogResize, { DialogMaximize } from "./DialogResize.jsx";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, Check, Copy, X, RotateCw, Square, Loader2 } from "lucide-react";
import { useEnvironment } from "../environmentContext.js";
import { useLayer } from "../layers.js";
import useCopyText from "../hooks/useCopyText.js";
import ConfirmDialog from "./ConfirmDialog.jsx";
import { t } from "../i18n.js";

const live = (status) => ["running", "terminating", "terminate_timeout"].includes(status);
const statusText = (p) => ({ running: t("运行中"), terminating: t("正在停止"), terminate_timeout: t("停止超时"), killed: t("已停止") })[p.status] ||
  (p.exitCode === 0 ? t("已完成") : t("退出码 {code}", { code: p.exitCode ?? "—" }));
// startTime/endTime are epoch ms from @aliou/pi-processes; ignore missing/invalid.
const startedAt = (p) => Number.isFinite(p.startTime) && p.startTime > 0 ? p.startTime : null;
const duration = (p) => {
  const start = startedAt(p);
  if (start == null) return "";
  const end = Number.isFinite(p.endTime) ? p.endTime : Date.now();
  const s = Math.max(0, Math.floor((end - start) / 1000)), pad = (n) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};
const startClock = (p) => startedAt(p) == null ? "" : new Date(startedAt(p)).toLocaleTimeString();
const dotClass = (p) => live(p.status) ? "run" : p.status === "killed" || p.status === "terminated" ? "killed" : p.exitCode === 0 ? "ok" : "fail";

export default React.memo(function ProcessesPanel({ sessionId, title, environmentName, wsUp, summary, onClose }) {
  const env = useEnvironment(), ref = useRef(null), listRef = useRef(null), logRef = useRef(null), mounted = useRef(true), stopLock = useRef(false);
  const refresh = useRef(() => {}), previousSummary = useRef(summary), loadedOnce = useRef(false);
  const [data, setData] = useState(null), [selected, setSelected] = useState(null), [output, setOutput] = useState(null);
  const [readError, setReadError] = useState(""), [stopError, setStopError] = useState("");
  const [loading, setLoading] = useState(true), [stopping, setStopping] = useState(null), [uncertain, setUncertain] = useState(null);
  const [confirming, setConfirming] = useState(null), [following, setFollowing] = useState(true);
  const { copied, copy } = useCopyText();
  const process = data?.processes?.find((p) => p.id === selected);
  useLayer({ ref, modal: true, outside: false, onClose, initialFocus: ".processes-close" });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setFollowing(true); }, [selected]);
  useEffect(() => { const el = logRef.current; if (el && following) el.scrollTop = el.scrollHeight; }, [output, following]);

  useEffect(() => {
    let disposed = false, polling, controller, deadline;
    const read = async (manual) => {
      clearTimeout(polling);
      if (disposed) return;
      if (document.hidden) { polling = setTimeout(read, 2000); return; }
      controller?.abort(); clearTimeout(deadline);
      const current = new AbortController(); controller = current;
      const timer = setTimeout(() => current.abort(), 10000); deadline = timer;
      // Background polls stay quiet; only the first load and manual refreshes spin.
      if (manual || !loadedOnce.current) { loadedOnce.current = true; setLoading(true); }
      try {
        const next = await env.api.get(`/api/sessions/${encodeURIComponent(sessionId)}/processes`, { signal: current.signal });
        if (!Array.isArray(next?.processes)) throw new Error(t("当前环境后端不支持后台任务管理，需要更新对应组件。"));
        if (next.attached && !next.available) throw new Error(t("后台进程插件不可用；请检查重复插件或后端配置。"));
        if (disposed || current !== controller) return;
        setData(next); setReadError("");
        const id = next.processes.some((p) => p.id === selected) ? selected : next.processes[0]?.id || null;
        if (id !== selected) { setOutput(null); setSelected(id); return; }
        if (id) {
          const logs = await env.api.get(`/api/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(id)}/output`, { signal: current.signal });
          if (!disposed && current === controller) setOutput(logs);
        } else setOutput(null);
      } catch (error) {
        if (!disposed && current === controller) setReadError(error.status === 404 ? t("当前环境后端不支持后台任务管理，需要更新对应组件。") : error.name === "AbortError" ? t("后台任务读取超时，请刷新重试") : error.message);
      } finally {
        clearTimeout(timer);
        if (!disposed && current === controller) {
          setLoading(false);
          polling = setTimeout(read, 2000);
        }
      }
    };
    refresh.current = read;
    read();
    const visible = () => { if (!document.hidden) read(); };
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; clearTimeout(polling); clearTimeout(deadline); controller?.abort(); document.removeEventListener("visibilitychange", visible); };
  }, [env, sessionId, selected]);
  // Only task lifecycle boundaries, never streaming tokens, refresh this panel.
  useEffect(() => { if (previousSummary.current !== summary) { previousSummary.current = summary; refresh.current(); } }, [summary]);

  const stop = async (id) => {
    if (!wsUp || stopLock.current || readError) return;
    stopLock.current = true; setStopping(id); setStopError("");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      await env.api.post(`/api/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(id)}/stop`, {}, { signal: controller.signal });
    } catch (error) {
      if (mounted.current) {
        const unknown = !error.status || error.status >= 500 || error.outcomeUnknown;
        if (unknown) setUncertain(id);
        setStopError(unknown ? t("停止结果尚未确认，不会自动重试。请刷新任务列表核对。") : error.message);
      }
    } finally {
      clearTimeout(timer); stopLock.current = false;
      if (mounted.current) { setStopping(null); refresh.current(); }
    }
  };

  return createPortal(<div className="modal-back tree-back">
    <section className="processes-panel" ref={ref} role="dialog" aria-modal="true" aria-label={t("后台任务")}>
      <header className="tree-header"><div><strong>{t("后台任务")}</strong><small>{environmentName} · {title || sessionId}</small></div>
        <div className="processes-actions"><button className="icon-ghost" disabled={loading} onClick={() => refresh.current(true)} title={t("刷新任务列表")} aria-label={t("刷新任务列表")}><RotateCw size={16} className={loading ? "spin" : ""} /></button>
        <DialogMaximize target={ref} storageKey="dw.dialogMax.processes" />
          <button className="icon-ghost processes-close" onClick={onClose} title={t("关闭后台任务")} aria-label={t("关闭后台任务")}><X size={18} /></button></div>
      </header>
      <p className="processes-help">{t("停止生成不会停止后台任务；任务完成后仍可能自动续跑。有任务运行时不能切换分支。")}
        {!!data?.limit && <> {t("每会话最多 {limit} 个后台任务。", { limit: data.limit })}</>}</p>
      {(readError || stopError) && <div className="tree-error" role="alert">{readError || stopError}</div>}
      {!wsUp && <p className="processes-help" role="status">{t("连接断开，仅可查看任务，不能发送停止操作。")}</p>}
      <div className="processes-body">
        <div className="processes-list" role="group" aria-label={t("后台任务列表")} ref={listRef} onKeyDown={(event) => {
          const rows = [...(listRef.current?.querySelectorAll("[data-process-id]") || [])];
          if (!rows.length) return;
          const index = rows.findIndex((row) => row.dataset.processId === selected);
          const next = event.key === "ArrowDown" ? Math.min(rows.length - 1, index + 1) : event.key === "ArrowUp" ? Math.max(0, index - 1) :
            event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          const id = rows[next]?.dataset.processId;
          if (id && id !== selected) { setOutput(null); setSelected(id); }
          rows[next]?.focus();
        }}>
          {!data && <p role="status">{loading ? t("正在读取后台任务…") : t("后台任务尚未加载")}</p>}
          {data && !data.processes.length && <p role="status">{data.attached ? t("暂无后台任务") : t("会话未加载；后台任务不跨会话卸载保存。")}</p>}
          {data?.processes.map((p) => <button type="button" key={p.id} data-process-id={p.id} aria-pressed={selected === p.id}
            tabIndex={selected === p.id ? 0 : -1}
            className={`processes-row${selected === p.id ? " selected" : ""}`} onClick={() => { if (selected !== p.id) { setOutput(null); setSelected(p.id); } }}>
            <strong><span className={"processes-dot " + dotClass(p)} aria-hidden="true" />{p.name}</strong>
            <small className={live(p.status) ? "processes-live" : ""}>{statusText(p)}{duration(p) ? ` · ${duration(p)}` : ""}</small><code>{p.command}</code>
          </button>)}
        </div>
        <div className="processes-detail">
          {process ? <><div className="processes-detail-head"><div><strong>{process.name}</strong><small>{process.id} · PID {process.pid} · {statusText(process)}{startClock(process) ? ` · ${startClock(process)}` : ""}{duration(process) ? ` · ${duration(process)}` : ""}</small></div>
            {live(process.status) && <button className="btn danger" disabled={!wsUp || !!stopping || uncertain === process.id || !!readError} onClick={() => setConfirming(process)}>
              {stopping === process.id ? <Loader2 size={13} className="spin" /> : <Square size={13} />}{stopping === process.id ? t("正在停止") : t("停止此任务")}</button>}</div>
            <div className="processes-command-row"><code className="processes-command">{process.command}</code>
              <button type="button" className="icon-ghost" title={t("复制命令")} aria-label={t("复制命令")} onClick={() => copy(process.command)}>{copied === process.command ? <Check size={13} /> : <Copy size={13} />}</button></div>
            <small className="dim">{process.cwd}</small>
            {process.error && <p role="alert">{process.error}</p>}
            <div className="processes-log">
              <pre className="processes-output" ref={logRef} aria-label={t("后台任务日志")} onScroll={() => {
                const el = logRef.current;
                if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= 24);
              }}>{output?.id === process.id ? output.text || t("暂无输出") : t("正在读取日志…")}</pre>
              {output?.id === process.id && !!output.text && <button type="button" className="icon-ghost processes-log-copy" title={t("复制日志")} aria-label={t("复制日志")}
                onClick={() => copy(output.text)}>{copied === output.text ? <Check size={13} /> : <Copy size={13} />}</button>}
              {!following && <button type="button" className="processes-jump" onClick={() => { setFollowing(true); const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }}>
                <ArrowDown size={12} />{t("跳到最新")}</button>}
            </div>
            {output?.truncated && <small className="dim">{t("仅显示最近 200 行日志，最多 64 KiB；完整输出由插件管理。")}</small>}
          </> : <p className="dim">{t("选择任务查看日志")}</p>}
        </div>
      </div>
      <DialogResize target={ref} />
      {confirming && <ConfirmDialog title={t("停止后台任务")} confirmLabel={t("停止此任务")}
        message={t("确定停止后台任务 “{name}”？命令：{command}。停止后不会自动重试。", { name: confirming.name, command: confirming.command })}
        onCancel={() => setConfirming(null)} onConfirm={async () => { await stop(confirming.id); setConfirming(null); }} />}
    </section>
  </div>, document.body);
});
