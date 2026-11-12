import React, { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Loader2, RotateCw, Square, TerminalSquare, Pin, PinOff, SlidersHorizontal, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import ConfirmDialog from "./ConfirmDialog.jsx";
import { ctrlCharacter, terminalKeySequence } from "../terminalKeys.js";
import { useLayer, hasActiveLayer } from "../layers.js";
import { installTerminalTouch } from "../terminalTouch.js";
import { copyText } from "../clipboard.js";
import { getUi, setUi } from "../ui.js";
import { t } from "../i18n.js";

const PRIMARY_KEYS = [
  ["interrupt", "Ctrl+C", t("停止当前命令")], ["escape", "Esc", "Escape"], ["tab", "Tab", t("补全 / Tab")],
  ["left", "←", t("左移")], ["down", "↓", t("下移 / 下一条历史")], ["up", "↑", t("上移 / 上一条历史")], ["right", "→", t("右移")],
];
const EXTRA_KEYS = [["home", "Home", t("行首")], ["end", "End", t("行尾")],
  ["pageUp", "PgUp", t("向上翻页")], ["pageDown", "PgDn", t("向下翻页")], ["delete", "Del", t("向后删除")]];

const LABELS = { connecting: t("连接中"), connected: t("已连接"), reconnecting: t("重连中"), exited: t("已退出"), error: t("无法连接") };

// Keep one terminal instance through a reversible exit transition. A close
// freezes its old workspace until disposal, so an outside click cannot start
// a new shell in the pane it is simultaneously focusing.
export default function TerminalPanel({ open = true, bounds, ...props }) {
  const [desktop, setDesktop] = useState(() => window.innerWidth > 768);
  const [present, setPresent] = useState(open), [visible, setVisible] = useState(false);
  const snapshot = useRef(props), anchor = useRef(bounds), initialized = useRef(false);
  if (open) { snapshot.current = props; anchor.current = bounds; }
  useEffect(() => {
    const resize = () => setDesktop(window.innerWidth > 768);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useLayoutEffect(() => {
    let first, second, timer;
    const reduced = !desktop || document.documentElement.dataset.motion === "off" || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (open) {
      setPresent(true);
      if (reduced || (initialized.current && present)) setVisible(true);
      else first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setVisible(true)); });
    } else {
      setVisible(false);
      if (reduced) setPresent(false);
      else timer = setTimeout(() => setPresent(false), 200);
    }
    initialized.current = true;
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); clearTimeout(timer); };
  }, [open, desktop]);
  if (!present) return null;
  const rect = anchor.current;
  const style = rect ? { "--terminal-left": `${rect.left}px`, "--terminal-top": `${rect.top}px`, "--terminal-pane-width": `${rect.width}px`, "--terminal-pane-height": `${rect.height}px` } : {};
  return <div className={`terminal-frame${visible && open ? " open" : ""}${!open ? " closing" : ""}`} style={style} inert={!open || undefined} aria-hidden={!open || undefined}>
    <TerminalContent {...snapshot.current} bounds={rect} floating={desktop} active={open} />
  </div>;
}

function TerminalContent({ cwd, onClose, environment, environmentName, bounds, floating, active }) {
  const panelRef = useRef(null), pasteRef = useRef(null);
  const opacityRef = useRef(null), opacityTriggerRef = useRef(null);
  const [opacityOpen, setOpacityOpen] = useState(false);
  const [transparency, setTransparency] = useState(() => getUi().terminalTransparency);
  const opacityId = useId();
  useEffect(() => {
    const sync = (event) => {
      if (event.type === "storage" && event.key && event.key !== "dw.terminalTransparency") return;
      setTransparency(getUi().terminalTransparency);
    };
    window.addEventListener("dw-ui", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("dw-ui", sync); window.removeEventListener("storage", sync); };
  }, []);
  useLayoutEffect(() => { setOpacityOpen(false); }, [cwd]);
  const hostRef = useRef(null);
  const socketRef = useRef(null);
  const activeRef = useRef(active), previousActive = useRef(active), connectedRef = useRef(false);
  activeRef.current = active;
  const terminalRef = useRef(null);
  const touchRef = useRef(null);
  const ctrlRef = useRef(false);
  const pasteRequestRef = useRef(0);
  const dragRef = useRef(null), openedRef = useRef(false);
  const [pinned, setPinned] = useState(() => localStorage.getItem("dw.terminalPinned") === "1");
  const [height, setHeight] = useState(() => Math.max(.2, Math.min(.85, +localStorage.getItem("dw.terminalHeight") || .55)));
  useEffect(() => { try { localStorage.setItem("dw.terminalPinned", pinned ? "1" : "0"); } catch {} }, [pinned]);
  const [width, setWidth] = useState(() => Math.min(900, Math.max(320, +localStorage.getItem("dw.terminalWidth") || 480)));
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [moreKeys, setMoreKeys] = useState(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [keyNotice, setKeyNotice] = useState("");
  const [touchSelection, setTouchSelection] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const moreId = useId();
  const setCtrl = (armed) => { ctrlRef.current = armed; setCtrlArmed(armed); };
  const closePaste = () => { pasteRequestRef.current++; setPasteOpen(false); setPasteText(""); };

  // Cancel unfinished handshakes immediately, while retaining an already
  // connected renderer for the visual exit. Reopening can resume a cancelled
  // connection, but never reconnects an established shell just for animation.
  useLayoutEffect(() => {
    if (!active) {
      if (!connectedRef.current) socketRef.current?.close();
      setConfirmEnd(false); setOpacityOpen(false); closePaste();
    }
    if (active && !previousActive.current && socketRef.current?.readyState !== WebSocket.OPEN) setAttempt((value) => value + 1);
    previousActive.current = active;
  }, [active]);

  useLayoutEffect(() => {
    if (!opacityOpen || !active || !opacityRef.current || !opacityTriggerRef.current) return;
    const panel = opacityRef.current, trigger = opacityTriggerRef.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft || 0) + 8, top = (viewport?.offsetTop || 0) + 8;
    const right = left + (viewport?.width || window.innerWidth) - 16;
    const bottom = top + (viewport?.height || window.innerHeight) - 16;
    panel.style.translate = "none";
    panel.style.left = `${Math.max(left, Math.min(trigger.right - panel.offsetWidth, right - panel.offsetWidth))}px`;
    panel.style.top = `${Math.max(top, Math.min(trigger.bottom + 6, bottom - panel.offsetHeight))}px`;
  }, [opacityOpen, active, bounds]);

  // Back hides an overlay terminal without ever intercepting shell Escape/Tab.
  useLayer({ open: !floating, ref: panelRef, onClose, passive: true, history: true, outside: false, escape: false, initialFocus: false });
  useLayer({ open: pasteOpen, ref: pasteRef, onClose: closePaste, outside: false, fit: false, initialFocus: false });
  useLayer({ open: opacityOpen && active, ref: opacityRef, triggerRef: opacityTriggerRef, onClose: () => setOpacityOpen(false), initialFocus: "input" });

  useEffect(() => {
    if (!floating || pinned) return;
    const outside = (event) => {
      if (panelRef.current?.contains(event.target) || event.target.closest?.("[data-terminal-toggle]") || hasActiveLayer()) return;
      onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside, true); };
  }, [floating, pinned, onClose]);

  useEffect(() => {
    connectedRef.current = false;
    if (!cwd) { setStatus("error"); setError(t("请先选择工作区")); return; }
    const focusOnConnect = !openedRef.current, openingFocus = document.activeElement;
    openedRef.current = true;
    let disposed = false;
    let socket;
    let retryTimer;
    let fitFrame;
    let ready = false;
    let running = false;
    let replayGeneration = 0;
    let connecting = false;
    let firstConnect = true;
    const host = hostRef.current;
    const terminal = new Terminal({
      cursorBlink: true, fontFamily: '"JetBrains Mono Variable", monospace',
      fontSize: 13, scrollback: 3000, disableStdin: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    const touch = installTerminalTouch(terminal, host, {
      onSelection: setTouchSelection, onReview: setReviewing,
      onNoHistory: () => setKeyNotice(t("当前程序没有历史输出，可使用更多里的 PgUp/PgDn")),
    });
    touchRef.current = touch;
    const resetCtrl = () => setCtrl(false);
    terminal.textarea?.addEventListener("blur", resetCtrl);
    terminal.textarea?.addEventListener("paste", resetCtrl, true);
    terminal.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.code === "Backquote"));
    const send = (message) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const fitTerminal = () => {
      if (disposed || !host.clientWidth || !host.clientHeight) return;
      touch.fit(() => fit.fit());
      if (ready) send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    };
    const scheduleFit = () => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(fitTerminal);
    };
    const applyTheme = () => {
      const css = getComputedStyle(document.documentElement);
      terminal.options.theme = {
        background: css.getPropertyValue("--code-bg").trim() || "#0b0b0d",
        foreground: css.getPropertyValue("--text").trim() || "#ededef",
        cursor: css.getPropertyValue("--accent").trim() || "#818cf8",
        selectionBackground: css.getPropertyValue("--accent-soft").trim() || "#818cf844",
      };
    };
    applyTheme();
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-scheme"] });
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(host);
    window.visualViewport?.addEventListener("resize", scheduleFit);
    document.fonts?.ready.then(() => { if (!disposed) scheduleFit(); });
    const inputSubscription = terminal.onData((data) => {
      if (!activeRef.current || !ready || terminal.options.disableStdin || socket?.readyState !== WebSocket.OPEN) return;
      // Ignore multi-byte terminal protocol replies when waiting for a Ctrl key.
      if (ctrlRef.current && !(data.startsWith("\x1b") && data.length > 1)) {
        setCtrl(false);
        data = ctrlCharacter(data) ?? data;
      }
      // Bound each frame, including large/bracketed clipboard pastes.
      for (let i = 0; i < data.length;) {
        let end = Math.min(data.length, i + 8192);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
        send({ type: "input", data: data.slice(i, end) });
        i = end;
      }
    });
    const retry = () => {
      if (disposed || !activeRef.current) return;
      setStatus("reconnecting");
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, 2000);
    };
    const connect = async () => {
      if (disposed || !activeRef.current || connecting || (socket && socket.readyState <= WebSocket.OPEN)) return;
      connecting = true;
      ready = false;
      terminal.options.disableStdin = true;
      setError(null);
      try {
        await environment.api.get(`/api/terminal?cwd=${encodeURIComponent(cwd)}`);
        if (disposed || !activeRef.current) return;
        fitTerminal();
        const ws = new WebSocket(environment.websocketUrl("/ws/terminal", { cwd, cols: terminal.cols, rows: terminal.rows }));
        socket = ws;
        socketRef.current = ws;
        ws.onmessage = (event) => {
          if (disposed || socket !== ws) return;
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === "terminal_ready") {
            const generation = ++replayGeneration;
            ready = false;
            running = message.running;
            terminal.options.disableStdin = true;
            setCtrl(false);
            closePaste();
            touch.clear();
            terminal.reset();
            terminal.resize(message.cols, message.rows);
            terminal.write(message.replay || "", () => {
              if (disposed || !activeRef.current || socket !== ws || ws.readyState !== WebSocket.OPEN || generation !== replayGeneration) return;
              // Historical terminal queries must not write responses back into
              // today's shell while replay is being parsed.
              ready = true;
              connectedRef.current = true;
              terminal.options.disableStdin = !running;
              setStatus(running ? "connected" : "exited");
              fitTerminal();
              if (firstConnect) { if (focusOnConnect && document.activeElement === openingFocus) terminal.focus(); firstConnect = false; }
            });
          } else if (message.type === "terminal_output") {
            terminal.write(message.data);
          } else if (message.type === "terminal_exit") {
            running = false;
            terminal.options.disableStdin = true;
            setCtrl(false);
            closePaste();
            setStatus("exited");
            terminal.writeln(t("\r\n[终端已退出，退出码 {v0}{v1}]", { v0: message.exitCode, v1: message.signal ? `，信号 ${message.signal}` : "" }));
          } else if (message.type === "terminal_error") {
            setError(message.error);
            if (!ready) setStatus("error");
          }
        };
        ws.onclose = (event) => {
          if (disposed || socket !== ws) return;
          ready = false;
          connectedRef.current = false;
          terminal.options.disableStdin = true;
          socketRef.current = null;
          setCtrl(false);
          closePaste();
          if (event.code === 1008) setStatus("error");
          else retry();
        };
        // onclose owns reconnection; no offline command queue/re-execution.
        ws.onerror = () => {};
      } catch (e) {
        if (disposed || !activeRef.current) return;
        setError(e.message);
        if (!e.status || e.status >= 500) retry();
        else setStatus("error");
      } finally {
        connecting = false;
      }
    };
    setStatus("connecting");
    setConfirmEnd(false);
    setCtrl(false);
    closePaste();
    setMoreKeys(false);
    setKeyNotice("");
    setTouchSelection(null);
    setReviewing(false);
    connect();
    const wake = () => {
      if (disposed || (socket && socket.readyState <= WebSocket.OPEN)) return;
      clearTimeout(retryTimer);
      connect();
    };
    window.addEventListener("online", wake);
    const visible = () => { if (document.visibilityState === "visible") wake(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      connectedRef.current = false;
      clearTimeout(retryTimer);
      cancelAnimationFrame(fitFrame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      window.visualViewport?.removeEventListener("resize", scheduleFit);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", visible);
      socketRef.current = null;
      terminalRef.current = null;
      touchRef.current = null;
      touch.dispose();
      pasteRequestRef.current++;
      ctrlRef.current = false;
      terminal.textarea?.removeEventListener("blur", resetCtrl);
      terminal.textarea?.removeEventListener("paste", resetCtrl, true);
      socket?.close(); // Detach only: the workspace shell keeps running.
      inputSubscription.dispose();
      terminal.dispose();
    };
  }, [cwd, attempt, environment]);

  useEffect(() => {
    if (!keyNotice) return;
    const timer = setTimeout(() => setKeyNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [keyNotice]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px), (pointer: coarse)");
    const reset = () => { if (!media.matches) setCtrl(false); };
    media.addEventListener("change", reset);
    return () => media.removeEventListener("change", reset);
  }, []);

  const canInput = () => status === "connected" && terminalRef.current &&
    !terminalRef.current.options.disableStdin && socketRef.current?.readyState === WebSocket.OPEN;
  const pressKey = (key) => {
    if (!canInput()) return;
    const terminal = terminalRef.current;
    const sequence = terminalKeySequence(key, terminal.modes, ctrlRef.current);
    setCtrl(false);
    terminal.input(sequence, true);
  };
  const copySelection = async () => {
    const terminal = terminalRef.current;
    const selection = window.getSelection();
    const text = terminal?.getSelection() || (hostRef.current?.contains(selection?.anchorNode) ? selection.toString() : "");
    if (!text) { setKeyNotice(t("先长按或拖动选择终端文字，再点复制")); return; }
    try {
      const copied = await copyText(text, { container: hostRef.current, silent: true,
        shouldCopy: () => terminalRef.current === terminal });
      if (terminalRef.current === terminal) setKeyNotice(copied ? t("已复制选中文字") : t("复制未获授权，请长按选中文字复制"));
    } catch { if (terminalRef.current === terminal) setKeyNotice(t("复制失败，请长按选中文字复制")); }
  };
  const openPaste = async () => {
    if (!canInput()) return;
    setCtrl(false);
    setPasteText(""); setPasteOpen(true); setKeyNotice("");
    const terminal = terminalRef.current, request = ++pasteRequestRef.current;
    if (!navigator.clipboard?.readText) return; // Native long-press paste works on HTTP too.
    try {
      const text = await navigator.clipboard.readText();
      if (request !== pasteRequestRef.current || terminal !== terminalRef.current) return;
      if (text.length > 256 * 1024) setKeyNotice(t("粘贴内容过长，最多 256K 字符"));
      else setPasteText(text);
    } catch {
      if (request === pasteRequestRef.current && terminal === terminalRef.current) setKeyNotice(t("无法读取剪贴板，可长按输入框粘贴"));
    }
  };
  const pasteToTerminal = () => {
    if (!canInput() || !pasteText || pasteText.length > 256 * 1024) return;
    setCtrl(false);
    terminalRef.current.paste(pasteText); // Preserve bracketed-paste mode; don't synthesize Enter.
    terminalRef.current.focus();
    closePaste();
  };
  const toggleKeyboard = () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (document.activeElement === terminal.textarea) terminal.blur();
    else terminal.focus();
  };
  // Do not blur the xterm textarea (and dismiss the IME) when tapping a key.
  const keepKeyboard = (event) => event.preventDefault();

  const command = (type) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) { setError(null); ws.send(JSON.stringify({ type })); }
    else setAttempt((v) => v + 1);
  };
  const stopResize = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.classList.remove("resizing", "terminal-height-resizing");
    try { localStorage.setItem(floating ? "dw.terminalHeight" : "dw.terminalWidth", String(floating ? height : width)); } catch {}
  };
  useEffect(() => () => document.body.classList.remove("resizing", "terminal-height-resizing"), []);

  return (
    <aside ref={panelRef} className={`terminal-panel${floating ? " terminal-floating" : ""}${pinned ? " pinned" : ""}`} style={{ "--terminal-width": `${width}px`, "--terminal-height": `${height * 100}%`, "--terminal-opacity": 1 - transparency / 100 }} aria-label={environmentName ? t("远程终端：{v0}", { v0: environmentName }) : t("工作区终端")}>
      <div
        className="terminal-resize" role="separator" aria-label={floating ? t("调整终端高度") : t("调整终端宽度")} aria-orientation={floating ? "horizontal" : "vertical"}
        tabIndex={0} aria-valuemin={floating ? 20 : 320} aria-valuemax={floating ? 85 : 900} aria-valuenow={floating ? Math.round(height * 100) : width}
        onKeyDown={(event) => {
          const keys = floating ? ["ArrowUp", "ArrowDown"] : ["ArrowRight", "ArrowLeft"];
          if (!keys.includes(event.key)) return;
          event.preventDefault();
          if (floating) { const value = Math.max(.2, Math.min(.85, height + (event.key === keys[0] ? -.03 : .03))); setHeight(value); try { localStorage.setItem("dw.terminalHeight", String(value)); } catch {} }
          else setWidth(Math.max(320, Math.min(900, width + (event.key === keys[0] ? -20 : 20))));
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { x: e.clientX, y: e.clientY, width: panelRef.current.clientWidth, height: panelRef.current.clientHeight };
          if (floating) document.body.classList.add("terminal-height-resizing");
          document.body.classList.add("resizing");
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (!drag) return;
          if (floating) { setHeight(Math.max(.2, Math.min(.85, (drag.height + e.clientY - drag.y) / panelRef.current.parentElement.clientHeight))); return; }
          const max = Math.max(320, e.currentTarget.parentElement.parentElement.clientWidth - 320);
          setWidth(Math.min(900, max, Math.max(320, drag.width + drag.x - e.clientX)));
        }}
        onPointerUp={stopResize} onPointerCancel={stopResize} onLostPointerCapture={stopResize}
      />
      <div className="terminal-head">
        <TerminalSquare size={16} />{environmentName && <span className="remote-title">{environmentName}</span>}
        <strong>{t("终端")}</strong>
        <span className={`terminal-state ${status}`} role="status">
          {(status === "connecting" || status === "reconnecting") && <Loader2 size={12} className="spin" />}
          {LABELS[status]}
        </span>
        <span className="terminal-actions">
          <button type="button" ref={opacityTriggerRef} className={"icon-ghost terminal-opacity-trigger" + (opacityOpen ? " on" : "")}
            aria-label={t("终端透明度")} title={t("终端透明度：{v0}%", { v0: transparency })} aria-haspopup="dialog" aria-expanded={opacityOpen} aria-controls={opacityId}
            onClick={() => setOpacityOpen((value) => !value)}><SlidersHorizontal size={15} /></button>
          {floating && <button type="button" className={"icon-ghost" + (pinned ? " on" : "")} aria-pressed={pinned} aria-label={pinned ? t("取消固定终端") : t("固定悬浮终端")} title={pinned ? t("取消固定：点击外部自动收起") : t("固定：点击外部仍保持悬浮")} onClick={() => setPinned((value) => !value)}>{pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>}
          {status === "exited" && <button className="icon-ghost" title={t("新建 shell")} onClick={() => command("restart")}><RotateCw size={15} /></button>}
          {status === "connected" && <button className="icon-ghost" title={t("结束终端进程")} onClick={() => setConfirmEnd(true)}><Square size={14} /></button>}
          <button className="icon-ghost" title={t("收起终端（后台继续运行）")} onClick={onClose}><X size={17} /></button>
        </span>
      </div>
      <div className="terminal-path" title={cwd}>{cwd || t("未选择工作区")}</div>
      {error && <div className="terminal-error" role="alert">
        <span>{error}</span>
        {(status === "error" || status === "reconnecting") && <button onClick={() => setAttempt((v) => v + 1)}>{t("重试")}</button>}
        <button className="icon-ghost" title={t("关闭提示")} onClick={() => setError(null)}><X size={13} /></button>
      </div>}
      <div className="terminal-screen" ref={hostRef}>
        {touchSelection && <>
          <div className="terminal-selection-actions" role="group" aria-label={t("选中文字操作")}>
            <button type="button" onPointerDown={keepKeyboard} onClick={copySelection}>{t("复制")}</button>
            <button type="button" onPointerDown={keepKeyboard} onClick={() => touchRef.current?.clear()}>{t("取消选择")}</button>
          </div>
          {["start", "end"].map((edge) => <button key={edge} type="button"
            className="terminal-selection-handle" data-terminal-handle={edge} aria-label={edge === "start" ? t("调整选区起点") : t("调整选区终点")}
            style={touchSelection[edge] || { visibility: "hidden" }} />)}
        </>}
        {reviewing && !touchSelection && <button type="button" className="terminal-history-jump" onPointerDown={keepKeyboard}
          onClick={() => { touchRef.current?.clear(); terminalRef.current?.scrollToBottom(); }}>{t("回到最新")}</button>}
        {keyNotice && <div className="terminal-key-notice" role="status">{keyNotice}</div>}
      </div>
      <div className="terminal-keys" role="group" aria-label={t("手机终端操作")}>
        <div className="terminal-keyrow">
          <div className="terminal-keyscroll">
            {PRIMARY_KEYS.map(([key, label, title], index) => <React.Fragment key={key}>
              {index === 1 && <button type="button" className={ctrlArmed ? "armed" : ""} data-terminal-key="ctrl"
                aria-pressed={ctrlArmed} title={t("Ctrl：再输入一个英文字母，使用一次；再点取消")} disabled={status !== "connected"}
                onPointerDown={keepKeyboard} onClick={() => setCtrl(!ctrlRef.current)}>Ctrl</button>}
              <button type="button" data-terminal-key={key} title={title} aria-label={title} disabled={status !== "connected"}
                onPointerDown={keepKeyboard} onClick={() => pressKey(key)}>{label}</button>
            </React.Fragment>)}
          </div>
          <button type="button" className="terminal-more-toggle" aria-expanded={moreKeys} aria-controls={moreKeys ? moreId : undefined}
            title={moreKeys ? t("收起更多按键") : t("更多终端操作")} onPointerDown={keepKeyboard}
            onClick={() => { setMoreKeys((v) => !v); closePaste(); }}>{t("更多")}</button>
        </div>
        {moreKeys && <div id={moreId} className="terminal-extra-keys" role="group" aria-label={t("更多终端操作")}>
          {EXTRA_KEYS.map(([key, label, title]) => <button type="button" key={key} data-terminal-key={key} title={title} aria-label={title}
            disabled={status !== "connected"} onPointerDown={keepKeyboard} onClick={() => pressKey(key)}>{label}</button>)}
          <button type="button" data-terminal-action="copy" onPointerDown={keepKeyboard} onClick={copySelection}>{t("复制")}</button>
          <button type="button" data-terminal-action="paste" disabled={status !== "connected"} onPointerDown={keepKeyboard} onClick={openPaste}>{t("粘贴")}</button>
          <button type="button" data-terminal-action="keyboard" title={t("显示或收起软键盘")} disabled={status !== "connected"}
            onPointerDown={keepKeyboard} onClick={toggleKeyboard}>{t("键盘")}</button>
        </div>}
        {pasteOpen && <div ref={pasteRef} className="terminal-paste" role="region" aria-label={t("粘贴确认")}>
          <label>{t("粘贴预览（也可长按输入框粘贴）")}
            <textarea rows={2} value={pasteText} maxLength={256 * 1024} placeholder={t("在此粘贴文本，确认后发送")}
              onChange={(event) => { pasteRequestRef.current++; setPasteText(event.target.value); }} />
          </label>
          {/[\r\n]/.test(pasteText) && <div className="terminal-paste-warning">{t("含换行的文本可能立即执行，请先确认。")}</div>}
          <div className="terminal-paste-actions">
            <button type="button" onPointerDown={keepKeyboard} onClick={closePaste}>{t("取消")}</button>
            <button type="button" disabled={status !== "connected" || !pasteText} onPointerDown={keepKeyboard} onClick={pasteToTerminal}>{t("粘贴到终端")}</button>
          </div>
        </div>}
      </div>
      <div className="terminal-foot">{t("服务器账号权限 · 收起或刷新不会结束进程")}</div>
      {opacityOpen && active && createPortal(
        <div ref={opacityRef} id={opacityId} className="terminal-opacity-panel" role="dialog" aria-label={t("终端透明度")} tabIndex={-1}>
          <div className="terminal-opacity-row"><strong>{t("透明度")}</strong><output htmlFor={`${opacityId}-range`}>{transparency}%</output></div>
          <input id={`${opacityId}-range`} className="set-range" type="range" min={0} max={80} step={5}
            aria-label={t("终端透明度")} aria-valuetext={t("{v0}% 透明，{v1}% 不透明", { v0: transparency, v1: 100 - transparency })}
            value={transparency} onChange={(event) => setUi({ terminalTransparency: +event.target.value || null })} />
          <div className="terminal-opacity-row"><span>{t("文字和背景一起变淡")}</span><button type="button" onClick={() => setUi({ terminalTransparency: null })}>{t("恢复不透明")}</button></div>
        </div>, document.body
      )}
      {confirmEnd && <ConfirmDialog
        title={t("结束终端")} message={t("将结束当前工作区的 shell 及其前台任务，其他页面连接的同一终端也会受到影响。")}
        confirmLabel={t("结束终端")} onCancel={() => setConfirmEnd(false)}
        onConfirm={() => { command("terminate"); setConfirmEnd(false); }}
      />}
    </aside>
  );
}
