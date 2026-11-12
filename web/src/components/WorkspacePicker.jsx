import React, { useEffect, useRef, useState } from "react";
import { X, Folder, FolderOpen, FolderPlus, CornerLeftUp, Loader2 } from "lucide-react";
import { createPortal } from "react-dom";
import { useLayer } from "../layers.js";
import { useEnvironment } from "../environmentContext.js";
import { t } from "../i18n.js";

export default function WorkspacePicker({ initial, onClose, onSelect }) {
  const { api } = useEnvironment();
  const [dir, setDir] = useState(initial || "~");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [newDir, setNewDir] = useState("");
  const [recentCwds, setRecentCwds] = useState([]);

  const panelRef = useRef(null);
  useLayer({ ref: panelRef, onClose, modal: true, initialFocus: ".path-input input" });

  // Recent workspaces = dirs that already have CLI/web sessions
  useEffect(() => {
    api
      .get("/api/sessions")
      .then(({ sessions }) => {
        const seen = new Map();
        for (const s of sessions) {
          if (s.cwd && !seen.has(s.cwd)) seen.set(s.cwd, s.updatedAt || "");
        }
        setRecentCwds([...seen.keys()]);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setData(null);
    setError(null);
    api
      .get(`/api/fs/browse?path=${encodeURIComponent(dir)}&hidden=${hidden ? 1 : 0}`)
      .then((d) => {
        if (live) {
          setData(d);
          setDir(d.path);
          setError(null);
        }
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => (live = false);
  }, [dir, hidden]);

  const mkdir = async () => {
    if (!newDir.trim() || !data || loading || data.path !== dir) return;
    try {
      await api.post("/api/fs/mkdir", { path: `${data.path}/${newDir.trim()}` });
      setDir(`${data.path}/${newDir.trim()}`);
      setNewDir("");
    } catch (e) {
      setError(e.message);
    }
  };

  const dirs = data?.entries.filter((e) => e.isDir) || [];

  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t("选择工作区目录")} tabIndex={-1} className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{t("选择工作区目录")}</h3>
          <button className="icon-ghost" onClick={onClose} title={t("关闭")}>
            <X size={16} />
          </button>
        </div>
        {recentCwds.length > 0 && (
          <div className="recent-cwds">
            <span className="recent-label">{t("有会话的目录：")}</span>
            {recentCwds.slice(0, 8).map((p) => (
              <button key={p} className="cwd-chip" title={p} onClick={() => setDir(p)}>
                <Folder size={11} />
                <span className="chip-path">{p}</span>
              </button>
            ))}
          </div>
        )}
        <div className="path-row">
          <div className="path-input">
            <FolderOpen size={14} />
            <input
              value={dir}
              aria-label={t("工作区路径")}
              onChange={(e) => setDir(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setDir(e.target.value)}
            />
          </div>
          <label className="switch">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            <span className="sw-track" />
            {t("显示隐藏")}
          </label>
        </div>
        {error && <div className="error-line" role="alert">{error}</div>}
        <div className="dir-list" aria-busy={loading}>
          {loading && <div className="dim pad" role="status"><Loader2 size={14} className="spin" />{t("正在加载目录…")}</div>}
          {data && data.path !== "/" && (
            <button type="button" className="dir-row" onClick={() => setDir(data.parent)}>
              <CornerLeftUp size={14} />
              <span className="dir-name">{t("上一级")}</span>
            </button>
          )}
          {dirs.map((e) => (
            <button type="button" key={e.path} className="dir-row" onClick={() => setDir(e.path)} title={e.path}>
              <Folder size={14} />
              <span className="dir-name">{e.name}</span>
            </button>
          ))}
          {data && dirs.length === 0 && <div className="dim pad">{t("（无子目录）")}</div>}
        </div>
        <div className="mkdir-row">
          <input
            placeholder={t("新建文件夹名…")}
            aria-label={t("新建文件夹名")}
            value={newDir}
            onChange={(e) => setNewDir(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && mkdir()}
          />
          <button className="secondary" onClick={mkdir} disabled={!newDir.trim() || loading || !data || data.path !== dir}>
            <FolderPlus size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
            {t("创建并进入")}
          </button>
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            {t("取消")}
          </button>
          <button className="primary" disabled={loading || !data || data.path !== dir} onClick={() => !loading && data?.path === dir && onSelect(data.path)}>
            {t("使用此目录")}
          </button>
        </div>
      </div>
    </div>, document.body
  );
}
