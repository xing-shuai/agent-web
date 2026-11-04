import React, { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, ArrowUp, Square, X, Slash, FileText, Paperclip } from "lucide-react";
import api from "../api.js";
import { getUi } from "../ui.js";

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
const cmdCategory = (name) => {
  if (/ask|plan|code|smart|bypass|fast|think/.test(name)) return "模式";
  if (/rename|share|goal|session|context|compact|recap|new/.test(name)) return "会话";
  if (/dir|workspace/.test(name)) return "工作区";
  if (/login|logout|status|billing|auth|account|usage/.test(name)) return "账户";
  if (/mcp|bug|help|skill|btw/.test(name)) return "工具";
  return "其他";
};

export default function InputBar({ running, disabled, onSend, onCancel, controls, meter, commands = [], sessionId, inject, cwd, agentName = "Devin" }) {
  const [text, setText] = useState("");
  // Re-render when UI prefs change so the hint reflects the send-key mode.
  const [, setUiTick] = useState(0);
  useEffect(() => {
    const h = () => setUiTick((t) => t + 1);
    window.addEventListener("dw-ui", h);
    return () => window.removeEventListener("dw-ui", h);
  }, []);
  const [images, setImages] = useState([]); // {data, mimeType, preview}
  const [files, setFiles] = useState([]); // {name, data, mimeType} pasted/picked non-image files
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const [histIdx, setHistIdx] = useState(-1);
  const draftRef = useRef("");
  const taRef = useRef(null);
  const listRef = useRef(null);
  // @-mention state: rel path -> abs path, the live token being typed, and
  // debounced search results for it.
  const refsRef = useRef(new Map());
  const [atQ, setAtQ] = useState(null); // {query, start} while an @token is typed
  const [atMatches, setAtMatches] = useState([]);
  const [atIdx, setAtIdx] = useState(0);

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

  // External text injection (e.g. "edit" a queued prompt pulls it back here).
  // Tagged with the session it came from — never fill another session's
  // composer with a stale inject.
  useEffect(() => {
    if (!inject?.n || inject.sessionId !== sessionId) return;
    setText(inject.text || "");
    setSlashClosed(true);
    taRef.current?.focus();
    requestAnimationFrame(autoGrow);
  }, [inject?.n]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Full-list view groups commands by category; filtered view stays flat.
  // `menuList` = items in display order so keyboard nav + Enter pick right.
  const CAT_ORDER = ["模式", "会话", "工作区", "账户", "工具", "其他"];
  const { menuRows, menuList } = useMemo(() => {
    if (slashQ)
      return { menuRows: matches.map((c, i) => ({ t: "item", c, i })), menuList: matches };
    const buckets = new Map();
    for (const c of matches) {
      const cat = cmdCategory(c.name);
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat).push(c);
    }
    const rows = [];
    const list = [];
    for (const cat of CAT_ORDER) {
      const bs = buckets.get(cat);
      if (!bs?.length) continue;
      rows.push({ t: "head", cat });
      for (const c of bs) rows.push({ t: "item", c, i: list.push(c) - 1 });
    }
    return { menuRows: rows, menuList: list };
  }, [matches, slashQ]);

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

  // Non-image attachments: text-ish files go inline as ACP `resource` blocks
  // (200KB cap); binary/larger files are rejected with a hint to @-mention
  // them instead — the agent reads those itself via resource_link.
  const addFile = (file) => {
    if (!file) return;
    if (file.type.startsWith("image/")) return addImage(file);
    if (file.size > 200 * 1024) {
      alert(`${file.name} 超过 200KB —— 请把文件放进工作区后用 @ 引用`);
      return;
    }
    const rd = new FileReader();
    rd.onload = () => {
      const t = String(rd.result || "");
      if (t.includes("")) {
        alert(`${file.name} 是二进制文件 —— 请放进工作区后用 @ 引用`);
        return;
      }
      setFiles((fs) => [...fs, { name: file.name, data: t, mimeType: file.type || "text/plain" }]);
    };
    rd.readAsText(file);
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

  // @-mention detection: the token being typed is the run of non-space
  // chars between the last "@" and the caret.
  const detectAt = (v, caret) => {
    const head = v.slice(0, caret);
    const m = head.match(/@([^\s@]*)$/);
    if (!m) return null;
    return { query: m[1], start: caret - m[1].length - 1 };
  };

  useEffect(() => {
    if (!atQ || !cwd) {
      setAtMatches([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await api.get(
          `/api/fs/search?root=${encodeURIComponent(cwd)}&q=${encodeURIComponent(atQ.query)}`
        );
        setAtMatches(r.files || []);
        setAtIdx(0);
      } catch {
        setAtMatches([]);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [atQ?.query, cwd]);

  const pickAt = (f) => {
    const at = atQ;
    if (!at) return;
    const before = text.slice(0, at.start);
    const caret = taRef.current?.selectionStart ?? at.start + at.query.length + 1;
    const after = text.slice(caret);
    refsRef.current.set(f.rel, f.path);
    setText(`${before}@${f.rel} ${after}`);
    setAtQ(null);
    setAtMatches([]);
    requestAnimationFrame(() => {
      const pos = before.length + f.rel.length + 2;
      taRef.current?.setSelectionRange(pos, pos);
      autoGrow();
    });
  };

  const send = () => {
    const t = text.trim();
    if ((!t && images.length === 0 && files.length === 0) || disabled) return;
    // resource_link blocks for every @path still present in the text.
    const links = [];
    for (const [rel, abs] of refsRef.current) {
      if (t.includes(`@${rel}`))
        links.push({ type: "resource_link", uri: "file://" + abs, name: rel });
    }
    const blocks = [
      ...links,
      ...files.map((f) => ({
        type: "resource",
        resource: { uri: `file:///${f.name}`, mimeType: f.mimeType, text: f.data },
      })),
      ...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
      ...(t ? [{ type: "text", text: t }] : []),
    ];
    onSend(blocks);
    pushHist(t);
    setText("");
    if (sessionId) try { localStorage.removeItem(draftKey(sessionId)); } catch {}
    setImages([]);
    setFiles([]);
    refsRef.current.clear();
    setAtQ(null);
    setAtMatches([]);
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
    if (atMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtIdx((i) => (i + 1) % atMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtIdx((i) => (i - 1 + atMatches.length) % atMatches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickAt(atMatches[atIdx % atMatches.length]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtQ(null);
        setAtMatches([]);
        return;
      }
    }
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % menuList.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => (i - 1 + menuList.length) % menuList.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickCmd(menuList[slashIdx % menuList.length].name);
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
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      const wantSend =
        getUi().send === "mod" ? (e.ctrlKey || e.metaKey) && !e.shiftKey : !e.shiftKey && !COARSE;
      if (wantSend) {
        e.preventDefault();
        send();
      }
    }
  };

  return (
    <div className="input-wrap col">
      <div className="input-card">
        {menuOpen && (
          <div className="slash-menu" ref={listRef}>
            {menuRows.map((r) =>
              r.t === "head" ? (
                <div key={"cat-" + r.cat} className="slash-cat">
                  {r.cat}
                </div>
              ) : (
                <button
                  key={r.c.name}
                  className={"slash-item" + (r.i === slashIdx % menuList.length ? " sel" : "")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickCmd(r.c.name);
                  }}
                  onMouseEnter={() => setSlashIdx(r.i)}
                >
                  <Slash size={13} />
                  <span className="slash-name">
                    /{r.c.name}
                    {r.c.hint && <span className="slash-hint"> {r.c.hint}</span>}
                  </span>
                  <span className="slash-desc">{r.c.desc}</span>
                </button>
              )
            )}
          </div>
        )}
        {atMatches.length > 0 && (
          <div className="slash-menu at-menu" ref={listRef}>
            {atMatches.map((f, i) => (
              <button
                key={f.path}
                className={"slash-item" + (i === atIdx % atMatches.length ? " sel" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickAt(f);
                }}
                onMouseEnter={() => setAtIdx(i)}
              >
                <FileText size={13} />
                <span className="slash-name">@{f.rel}</span>
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
        {files.length > 0 && (
          <div className="img-tray file-tray">
            {files.map((f, i) => (
              <div key={i} className="file-chip" title={f.name}>
                <FileText size={13} />
                <span>{f.name}</span>
                <button onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
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
          placeholder={running ? `${agentName} 正在工作…（可直接发送排队）` : `给 ${agentName} 发消息…`}
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
            setAtQ(detectAt(v, e.target.selectionStart ?? v.length));
            autoGrow();
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            for (const item of e.clipboardData?.items || []) {
              if (item.kind === "file") addFile(item.getAsFile());
            }
          }}
        />
        <div className="input-toolbar">
          <div className="it-left">
            <input
              type="file"
              accept="*/*"
              id="file-upload"
              style={{ display: "none" }}
              onChange={(e) => {
                addFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <label htmlFor="file-upload" className="tool-ic-btn" title="添加附件（图片或文本文件）">
              <Paperclip size={17} />
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
                disabled={disabled || (!text.trim() && !images.length && !files.length)}
                title="发送"
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="input-hint">
        {getUi().send === "mod"
          ? "Ctrl+Enter 发送 · Enter 换行 · ↑ 历史"
          : "Enter 发送 · Shift+Enter 换行 · ↑ 历史"}
        {commands.length ? " · / 命令" : ""}
      </div>
    </div>
  );
}
