import React, { useEffect, useRef, useState } from "react";
import { useLayer } from "../layers.js";
import { createPortal } from "react-dom";
import { Settings, X } from "lucide-react";
import { getUi, setUi } from "../ui.js";
import { getView, setView, VIEWS } from "../theme.js";
import { t, setLang } from "../i18n.js";
import { formatHotkey, keyNameOf, hotkeyRecording } from "../hotkeys.js";

// Combos the app already owns — recording one of these is refused inline.
const RESERVED_KEYS = new Set([
  "Ctrl+K", "Ctrl+F", "Ctrl+`", "Ctrl+\\", "Ctrl+Shift+\\",
  "Alt+Shift+W", "Alt+Shift+ArrowLeft", "Alt+Shift+ArrowRight", "Alt+Shift+ArrowUp", "Alt+Shift+ArrowDown",
]);

function Seg({ options, value, onChange, label }) {
  return (
    <div className="set-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.v} aria-pressed={value === o.v} className={value === o.v ? "cur" : ""} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function Switch({ on, onChange, label }) {
  return (
    <label className="switch">
      <input type="checkbox" aria-label={label} checked={on} onChange={(e) => onChange(e.target.checked)} />
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
export default function SettingsMenu({ agents = [] }) {
  const [open, setOpen] = useState(false);
  const [ui, setUiState] = useState(getUi);
  const [view, setViewState] = useState(getView);
  const [recording, setRecording] = useState(false);
  const [keyError, setKeyError] = useState(null);
  useEffect(() => { if (open) { setUiState(getUi()); setViewState(getView()); setRecording(false); setKeyError(null); } }, [open]);

  // Capture-phase listener wins over the app hotkeys while recording.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setRecording(false); setKeyError(null); return; }
      if (e.repeat || e.isComposing || e.keyCode === 229) return;
      const spec = formatHotkey(e);
      if (!spec) return; // modifier-only press
      const key = keyNameOf(e.code);
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !/^F([1-9]|1[0-2])$/.test(key)) {
        setKeyError(t("需要至少一个 Ctrl/Alt/Meta 修饰键，或使用 F 键"));
        return;
      }
      if (RESERVED_KEYS.has(spec)) {
        setKeyError(t("此组合已被应用占用"));
        return;
      }
      setKeyError(null);
      setRecording(false);
      set({ quickKey: spec });
    };
    hotkeyRecording.active = true;
    window.addEventListener("keydown", onKey, true);
    return () => { hotkeyRecording.active = false; window.removeEventListener("keydown", onKey, true); };
  }, [recording]);

  const panelRef = useRef(null);
  useLayer({ open, ref: panelRef, modal: true, onClose: () => setOpen(false) });

  const set = (patch) => {
    setUi(patch);
    setUiState(getUi());
  };

  return (
    <>
      <button className="icon-ghost" title={t("设置")} onClick={() => setOpen(true)}>
        <Settings size={15} />
      </button>
      {open &&
        createPortal(
          <div className="modal-back" onClick={() => setOpen(false)}>
            <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t("设置")} tabIndex={-1} className="modal set-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h3>{t("设置")}</h3>
                <button className="icon-ghost" onClick={() => setOpen(false)} title={t("关闭")}>
                  <X size={15} />
                </button>
              </div>
              <div className="set-body">
                <div className="set-label">{t("外观")}</div>
                <Row name={t("侧栏字号")} desc={t("左侧会话列表与工作区文字")}>
                  <input
                    className="set-range"
                    type="range"
                    aria-label={t("侧栏字号")}
                    min={80}
                    max={130}
                    step={5}
                    value={ui.sbfs}
                    onChange={(e) => set({ sbfs: +e.target.value })}
                  />
                  <em className="set-val">{ui.sbfs}%</em>
                </Row>
                <Row name={t("侧栏会话布局")} desc={t("单行紧凑显示；双行展开状态和时间")}>
                  <Seg
                    label={t("侧栏会话布局")}
                    value={ui.sessionRows}
                    onChange={(v) => set({ sessionRows: v === "single" ? null : v })}
                    options={[{ v: "single", l: t("单行") }, { v: "double", l: t("双行") }]}
                  />
                </Row>
                <Row name={t("界面语言")} desc={t("切换后重新载入页面")}>
                  <Seg
                    label={t("界面语言")}
                    value={ui.lang}
                    onChange={(v) => v !== ui.lang && setLang(v)}
                    options={[{ v: "zh", l: "中文" }, { v: "en", l: "English" }]}
                  />
                </Row>
                <Row name={t("对话字号")} desc={t("聊天瀑布流与输入区文字")}>
                  <input
                    className="set-range"
                    type="range"
                    aria-label={t("对话字号")}
                    min={80}
                    max={130}
                    step={5}
                    value={ui.tfs}
                    onChange={(e) => set({ tfs: +e.target.value })}
                  />
                  <em className="set-val">{ui.tfs}%</em>
                </Row>
                <Row name={t("内容行宽")} desc={t("对话内容的最大宽度")}>
                  <Seg
                    label={t("内容行宽")}
                    value={ui.colw}
                    onChange={(v) => set({ colw: v === "std" ? null : v })}
                    options={[
                      { v: "narrow", l: t("窄") },
                      { v: "std", l: t("标准") },
                      { v: "wide", l: t("宽") },
                    ]}
                  />
                </Row>
                <Row name={t("减少动画")} desc={t("关闭过渡与动效")}>
                  <Switch label={t("减少动画")} on={ui.motion === "off"} onChange={(v) => set({ motion: v ? "off" : null })} />
                </Row>

                <div className="set-label">{t("对话")}</div>
                <Row name={t("流式自动收起")} desc={t("思考与工具归入总根，执行时展开滚动，结束后逐层收起；正文保持展开")}>
                  <Switch label={t("流式自动收起")} on={ui.autoFold} onChange={(v) => set({ autoFold: v ? "1" : null })} />
                </Row>
                <Row name={t("转录样式")} desc={t("与会话更多菜单中的视图同步")}>
                  <select
                    className="set-select"
                    aria-label={t("转录样式")}
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

                <div className="set-label">{t("输入")}</div>
                <Row name={t("发送方式")} desc={t("Ctrl+Enter 模式下 Enter 仅换行")}>
                  <Seg
                    label={t("发送方式")}
                    value={ui.send}
                    onChange={(v) => set({ send: v === "enter" ? null : v })}
                    options={[
                      { v: "enter", l: t("Enter 发送") },
                      { v: "mod", l: "Ctrl+Enter" },
                    ]}
                  />
                </Row>
                <Row name={t("按键提示常显")} desc={t("输入框上方快捷键提示不隐藏")}>
                  <Switch label={t("按键提示常显")} on={ui.hint} onChange={(v) => set({ hint: v ? "1" : null })} />
                </Row>

                <div className="set-label">{t("快速对话")}</div>
                <Row name={t("快速对话快捷键")} desc={t("全局呼出或收起快速对话面板")}>
                  <button
                    type="button"
                    className={"set-key-btn" + (recording ? " rec" : "")}
                    aria-label={t("快速对话快捷键")}
                    aria-pressed={recording}
                    onClick={() => { setRecording((v) => !v); setKeyError(null); }}
                  >
                    {recording ? t("按下新的组合键…") : ui.quickKey}
                  </button>
                  <button type="button" className="secondary" disabled={ui.quickKey === "Ctrl+Shift+Space"} onClick={() => set({ quickKey: null })}>{t("重置")}</button>
                  {keyError && <em className="set-err" role="alert">{keyError}</em>}
                </Row>
                <Row name={t("快速对话默认 Agent")} desc={t("本机环境可用的 Agent")}>
                  <select
                    className="set-select"
                    aria-label={t("快速对话默认 Agent")}
                    value={ui.quickAgent || ""}
                    onChange={(e) => set({ quickAgent: e.target.value || null })}
                  >
                    <option value="">{t("默认 (Pi)")}</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
                  </select>
                </Row>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
