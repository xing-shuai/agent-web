import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Settings, X } from "lucide-react";
import { getUi, setUi } from "../ui.js";
import { getView, setView, VIEWS } from "../theme.js";

function Seg({ options, value, onChange }) {
  return (
    <div className="set-seg">
      {options.map((o) => (
        <button key={o.v} className={value === o.v ? "cur" : ""} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function Switch({ on, onChange }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="sw-track" />
    </label>
  );
}

function Row({ name, desc, children }) {
  return (
    <div className="set-row">
      <span className="set-name">
        {name}
        {desc && <em>{desc}</em>}
      </span>
      {children}
    </div>
  );
}

/** Sidebar footer settings button → portal modal with appearance/input prefs.
 *  Portaled because the mobile drawer transform breaks fixed positioning. */
export default function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [ui, setUiState] = useState(getUi);
  const [view, setViewState] = useState(getView);

  useEffect(() => {
    if (!open) return;
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);

  const set = (patch) => {
    setUi(patch);
    setUiState(getUi());
  };

  return (
    <>
      <button className="icon-ghost" title="设置" onClick={() => setOpen(true)}>
        <Settings size={15} />
      </button>
      {open &&
        createPortal(
          <div className="modal-back" onClick={() => setOpen(false)}>
            <div className="modal set-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h3>设置</h3>
                <button className="icon-ghost" onClick={() => setOpen(false)} title="关闭">
                  <X size={15} />
                </button>
              </div>
              <div className="set-body">
                <div className="set-label">外观</div>
                <Row name="界面缩放" desc="全局字体与布局大小">
                  <input
                    className="set-range"
                    type="range"
                    min={80}
                    max={130}
                    step={5}
                    value={ui.scale}
                    onChange={(e) => set({ scale: +e.target.value })}
                  />
                  <em className="set-val">{ui.scale}%</em>
                </Row>
                <Row name="内容行宽" desc="对话内容的最大宽度">
                  <Seg
                    value={ui.colw}
                    onChange={(v) => set({ colw: v === "std" ? null : v })}
                    options={[
                      { v: "narrow", l: "窄" },
                      { v: "std", l: "标准" },
                      { v: "wide", l: "宽" },
                    ]}
                  />
                </Row>
                <Row name="减少动画" desc="关闭过渡与动效">
                  <Switch on={ui.motion === "off"} onChange={(v) => set({ motion: v ? "off" : null })} />
                </Row>

                <div className="set-label">对话</div>
                <Row name="转录样式" desc="与顶栏视图选择同步">
                  <select
                    className="set-select"
                    value={view}
                    onChange={(e) => {
                      setView(e.target.value);
                      setViewState(e.target.value);
                    }}
                  >
                    {VIEWS.map((v) => (
                      <option key={v.value} value={v.value}>
                        {v.name} · {v.description}
                      </option>
                    ))}
                  </select>
                </Row>

                <div className="set-label">输入</div>
                <Row name="发送方式" desc="Ctrl+Enter 模式下 Enter 仅换行">
                  <Seg
                    value={ui.send}
                    onChange={(v) => set({ send: v === "enter" ? null : v })}
                    options={[
                      { v: "enter", l: "Enter 发送" },
                      { v: "mod", l: "Ctrl+Enter" },
                    ]}
                  />
                </Row>
                <Row name="按键提示常显" desc="输入框上方快捷键提示不隐藏">
                  <Switch on={ui.hint} onChange={(v) => set({ hint: v ? "1" : null })} />
                </Row>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
