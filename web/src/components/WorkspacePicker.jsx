import React, { useEffect, useState } from "react";
import { X, Folder, FolderOpen, FolderPlus, CornerLeftUp } from "lucide-react";
import api from "../api.js";

export default function WorkspacePicker({ initial, onClose, onSelect }) {
  const [dir, setDir] = useState(initial || "~");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [newDir, setNewDir] = useState("");
  const [recentCwds, setRecentCwds] = useState([]);

  // Esc closes the picker.
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    api
      .get(`/api/fs/browse?path=${encodeURIComponent(dir)}&hidden=${hidden ? 1 : 0}`)
      .then((d) => {
        if (live) {
          setData(d);
          setDir(d.path);
          setError(null);
        }
      })
      .catch((e) => live && setError(e.message));
    return () => (live = false);
  }, [dir, hidden]);

  const mkdir = async () => {
    if (!newDir.trim() || !data) return;
    try {
      await api.post("/api/fs/mkdir", { path: `${data.path}/${newDir.trim()}` });
      setDir(`${data.path}/${newDir.trim()}`);
      setNewDir("");
    } catch (e) {
      setError(e.message);
    }
  };

  const dirs = data?.entries.filter((e) => e.isDir) || [];

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>选择工作区目录</h3>
          <button className="icon-ghost" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>
        {recentCwds.length > 0 && (
          <div className="recent-cwds">
            <span className="recent-label">有会话的目录：</span>
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
              onChange={(e) => setDir(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setDir(e.target.value)}
            />
          </div>
          <label className="switch">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            <span className="sw-track" />
            显示隐藏
          </label>
        </div>
        {error && <div className="error-line">{error}</div>}
        <div className="dir-list">
          {data && data.path !== "/" && (
            <div className="dir-row" onClick={() => setDir(data.parent)}>
              <CornerLeftUp size={14} />
              <span className="dir-name">上一级</span>
            </div>
          )}
          {dirs.map((e) => (
            <div key={e.path} className="dir-row" onClick={() => setDir(e.path)} title={e.path}>
              <Folder size={14} />
              <span className="dir-name">{e.name}</span>
            </div>
          ))}
          {data && dirs.length === 0 && <div className="dim pad">（无子目录）</div>}
        </div>
        <div className="mkdir-row">
          <input
            placeholder="新建文件夹名…"
            value={newDir}
            onChange={(e) => setNewDir(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && mkdir()}
          />
          <button className="secondary" onClick={mkdir} disabled={!newDir.trim()}>
            <FolderPlus size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
            创建并进入
          </button>
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" onClick={() => data && onSelect(data.path)}>
            使用此目录
          </button>
        </div>
      </div>
    </div>
  );
}
