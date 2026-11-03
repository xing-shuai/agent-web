import React, { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, ArrowUp, Square, X, Slash } from "lucide-react";

// Touch devices have no Shift key — Enter inserts a newline there and
// sending is done via the send button only.
const COARSE = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

const HIST_MAX = 50;
const histKey = (sid) => `devin-web.hist.${sid}`;
const draftKey = (sid) => `devin-web.draft.${sid}`;
const loadHist = (sid) => {
  try {
    const h = JSON.parse(localStorage.getItem(histKey(sid)) || "[]");
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
};
const cmdName = (c) => (typeof c === "string" ? c : c?.name || "");
const cmdDesc = (c) => (typeof c === "string" ? "" : c?.description || "");
const cmdHint = (c) => (typeof c === "string" ? "" : c?.input?.hint || "");

export default function InputBar({ running, disabled, onSend, onCancel, controls, meter, commands = [], sessionId }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState([]); // {data, mimeType, preview}
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const [histIdx, setHistIdx] = useState(-1);
  const draftRef = useRef("");
  const taRef = useRef(null);
  const listRef = useRef(null);

  // Per-session input history (ref — also written by pushHist)
  const histRef = useRef([]);
  useEffect(() => {
    histRef.current = sessionId ? loadHist(sessionId) : [];
  }, [sessionId]);
  const hist = histRef.current;
  useEffect(() => {
    // Per-session draft survives switching away and back.
    setText(sessionId ? localStorage.getItem(draftKey(sessionId)) || "" : "");
    setHistIdx(-1);
    setSlashClosed(false);
    requestAnimationFrame(autoGrow);
  }, [sessionId]);

  // Slash-command suggestions: only while typing `/<query>` (no space/newline yet)
  const slashQ = text.startsWith("/") && !/[\s]/.test(text) ? text.slice(1).toLowerCase() : null;
  const matches =
    slashQ !== null && !slashClosed
      ? commands
          .map((c) => ({ name: cmdName(c), desc: cmdDesc(c), hint: cmdHint(c) }))
          .filter((c) => c.name && c.name.toLowerCase().includes(slashQ))
          .slice(0, 32)
      : [];
  const menuOpen = matches.length > 0;

  const addImage = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const rd = new FileReader();
    rd.onload = () => {
      const dataUrl = rd.result;
      const base64 = String(dataUrl).split(",")[1];
      setImages((imgs) => [...imgs, { data: base64, mimeType: file.type, preview: dataUrl }]);
    };
    rd.readAsDataURL(file);
  };

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  };

  const pushHist = (t) => {
    if (!sessionId || !t) return;
    const h = [t, ...histRef.current.filter((x) => x !== t)].slice(0, HIST_MAX);
    histRef.current = h;
    try {
      localStorage.setItem(histKey(sessionId), JSON.stringify(h));
    } catch { /* full — fine */ }
  };

  const send = () => {
    const t = text.trim();
    if ((!t && images.length === 0) || disabled) return;
    const blocks = [
      ...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
      ...(t ? [{ type: "text", text: t }] : []),
    ];
    onSend(blocks);
    pushHist(t);
    setText("");
    if (sessionId) try { localStorage.removeItem(draftKey(sessionId)); } catch {}
    setImages([]);
    setHistIdx(-1);
    setSlashClosed(false);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
  };

  const pickCmd = (name) => {
    setText(`/${name} `);
    setSlashClosed(true);
    taRef.current?.focus();
    requestAnimationFrame(autoGrow);
  };

  const walkHistory = (dir, target) => {
    if (!hist.length) return false;
    // Only browse history when the caret is at the boundary of the text.
    const atStart = target.selectionStart === 0 && target.selectionEnd === 0;
    const atEnd = target.selectionStart === text.length && target.selectionEnd === text.length;
    if ((dir === -1 && !atStart) || (dir === 1 && !atEnd)) return false;
    if (dir === -1) {
      if (histIdx + 1 >= hist.length) return false;
      if (histIdx === -1) draftRef.current = text;
      const next = histIdx + 1;
      setHistIdx(next);
      setText(hist[next]);
    } else {
      if (histIdx === -1) return false;
      const next = histIdx - 1;
      setHistIdx(next);
      setText(next === -1 ? draftRef.current : hist[next]);
    }
    requestAnimationFrame(() => {
      const ta = taRef.current;
      ta?.setSelectionRange(ta.value.length, ta.value.length);
      autoGrow();
    });
    return true;
  };

  const onKeyDown = (e) => {
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickCmd(matches[slashIdx % matches.length].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashClosed(true);
        return;
      }
    }
    if (e.key === "ArrowUp" && walkHistory(-1, e.target)) return e.preventDefault();
    if (e.key === "ArrowDown" && walkHistory(1, e.target)) return e.preventDefault();
    if (e.key === "Enter" && !e.shiftKey && !COARSE && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="input-wrap col">
      <div className="input-card">
        {menuOpen && (
          <div className="slash-menu" ref={listRef}>
            {matches.map((c, i) => (
              <button
                key={c.name}
                className={"slash-item" + (i === slashIdx % matches.length ? " sel" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickCmd(c.name);
                }}
                onMouseEnter={() => setSlashIdx(i)}
              >
                <Slash size={13} />
                <span className="slash-name">
                  /{c.name}
                  {c.hint && <span className="slash-hint"> {c.hint}</span>}
                </span>
                <span className="slash-desc">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="img-tray">
            {images.map((img, i) => (
              <div key={i} className="img-thumb">
                <img src={img.preview} />
                <button onClick={() => setImages((imgs) => imgs.filter((_, j) => j !== i))}>
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          className="input-ta"
          rows={1}
          placeholder={running ? "Devin 正在工作…（可直接发送排队）" : "给 Devin 发消息…"}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            if (sessionId)
              try {
                if (v) localStorage.setItem(draftKey(sessionId), v);
                else localStorage.removeItem(draftKey(sessionId));
              } catch { /* full — fine */ }
            setSlashIdx(0);
            setSlashClosed(false);
            setHistIdx(-1);
            autoGrow();
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            for (const item of e.clipboardData?.items || []) {
              if (item.kind === "file") addImage(item.getAsFile());
            }
          }}
        />
        <div className="input-toolbar">
          <div className="it-left">
            <input
              type="file"
              accept="image/*"
              id="img-upload"
              style={{ display: "none" }}
              onChange={(e) => {
                addImage(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <label htmlFor="img-upload" className="tool-ic-btn" title="添加图片">
              <ImagePlus size={17} />
            </label>
            {controls}
          </div>
          <div className="it-right">
            {meter}
            {running ? (
              <button className="stop" onClick={onCancel} title="停止">
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                className="send"
                onClick={send}
                disabled={disabled || (!text.trim() && !images.length)}
                title="发送"
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="input-hint">
        Enter 发送 · Shift+Enter 换行 · ↑ 历史{commands.length ? " · / 命令" : ""}
      </div>
    </div>
  );
}
