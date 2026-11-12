import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, ArrowUp, Square, X, Slash, FileText, Paperclip } from "lucide-react";
import { useEnvironment } from "../environmentContext.js";
import { getUi } from "../ui.js";
import { emptyDraft, readDraft, saveDraft } from "../composerDrafts.js";
import { t } from "../i18n.js";

const HIST_MAX = 50;
const histKey = (env, sid) => env.storageKey(`devin-web.hist.${sid}`);
const loadHist = (env, sid) => {
  try {
    const h = JSON.parse(localStorage.getItem(histKey(env, sid)) || "[]");
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
};
const cmdName = (c) => (typeof c === "string" ? c : c?.name || "");
const cmdDesc = (c) => (typeof c === "string" ? "" : c?.description || "");
const cmdHint = (c) => (typeof c === "string" ? "" : c?.input?.hint || "");
const cmdCategory = (name) => {
  if (/ask|plan|code|smart|bypass|fast|think/.test(name)) return t("模式");
  if (/rename|share|goal|session|context|compact|recap|new|tree/.test(name)) return t("会话");
  if (/dir|workspace/.test(name)) return t("工作区");
  if (/login|logout|status|billing|auth|account|usage/.test(name)) return t("账户");
  if (/mcp|bug|help|skill|btw/.test(name)) return t("工具");
  return t("其他");
};

function InputBar({ running, disabled, offline, onSend, onCancel, onPreviewImage, controls, meter, commands = [], sessionId, inject, onConsumeInject, cwd, agentName = "Devin", dropRef, onOpenTree }) {
  const env = useEnvironment();
  const [draft, setDraft] = useState(() => readDraft(sessionId, env));
  const { text, images, files, refs } = draft;
  const [draftWarning, setDraftWarning] = useState(null);
  const attachmentGeneration = useRef(0);
  const setField = (key, value) => setDraft((previous) => ({ ...previous, [key]: typeof value === "function" ? value(previous[key]) : value }));
  const setText = (value) => setField("text", value);
  const setImages = (value) => setField("images", value);
  const setFiles = (value) => setField("files", value);
  const addRef = (name, path) => setDraft((previous) => ({ ...previous, refs: new Map(previous.refs).set(name, path) }));
  useLayoutEffect(() => {
    setDraft(readDraft(sessionId, env));
    setAttachmentError(null);
    return () => { attachmentGeneration.current++; };
  }, [sessionId]);
  useLayoutEffect(() => {
    if (draft.sessionId === sessionId) setDraftWarning(saveDraft(draft, env));
  }, [draft, sessionId]);
  // Re-render when UI prefs change so the hint reflects the send-key mode.
  const [, setUiTick] = useState(0);
  useEffect(() => {
    const h = () => setUiTick((t) => t + 1);
    window.addEventListener("dw-ui", h);
    return () => window.removeEventListener("dw-ui", h);
  }, []);
  const [attachmentError, setAttachmentError] = useState(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const [histIdx, setHistIdx] = useState(-1);
  const draftRef = useRef("");
  const taRef = useRef(null);
  const uploadRef = useRef(null);
  const listRef = useRef(null);
  // @-mention state: rel path -> abs path, the live token being typed, and
  // debounced search results for it.
  const [atQ, setAtQ] = useState(null); // {query, start} while an @token is typed
  const [atMatches, setAtMatches] = useState([]);
  const [atIdx, setAtIdx] = useState(0);

  // Per-session input history (ref — also written by pushHist)
  const histRef = useRef([]);
  useEffect(() => {
    histRef.current = sessionId ? loadHist(env, sessionId) : [];
  }, [sessionId]);
  const hist = histRef.current;
  useEffect(() => {
    setHistIdx(-1);
    setSlashClosed(false);
    setAtQ(null);
    setAtMatches([]);
    requestAnimationFrame(autoGrow);
  }, [sessionId]);

  // External text injection (e.g. "edit" a queued prompt pulls it back here).
  // Tagged with the session it came from — never fill another session's
  // composer with a stale inject.
  useEffect(() => {
    if (!inject?.n || inject.sessionId !== sessionId) return;
    if (inject.replaceDraft) {
      attachmentGeneration.current++;
      setDraft({ ...emptyDraft(sessionId), text: inject.text || "" });
      setAtMatches([]); setAtQ(null); setHistIdx(-1); setSlashClosed(true);
      requestAnimationFrame(autoGrow);
      onConsumeInject?.(inject.n);
      return;
    }
    const blocks = inject.blocks;
    const nextText = blocks ? blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n") : inject.text || "";
    setText(inject.append && text ? `${text}\n\n${nextText}` : nextText);
    if (blocks) {
      setImages((previous) => [...previous, ...blocks.filter((b) => b.type === "image").map((b) => ({ data: b.data, mimeType: b.mimeType, preview: `data:${b.mimeType};base64,${b.data}` }))]);
      setFiles((previous) => [...previous, ...blocks.filter((b) => b.type === "resource" && b.resource?.text != null).map((b) => ({ name: b.resource.uri?.split("/").at(-1) || "attachment", data: b.resource.text, mimeType: b.resource.mimeType }))]);
      for (const block of blocks) if (block.type === "resource_link") addRef(block.name, block.uri.replace(/^file:\/\//, ""));
    }
    setSlashClosed(true);
    taRef.current?.focus();
    requestAnimationFrame(autoGrow);
    onConsumeInject?.(inject.n);
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
  const CAT_ORDER = [t("模式"), t("会话"), t("工作区"), t("账户"), t("工具"), t("其他")];
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
    const generation = attachmentGeneration.current;
    const rd = new FileReader();
    rd.onload = () => {
      if (generation !== attachmentGeneration.current) return;
      const dataUrl = rd.result;
      const base64 = String(dataUrl).split(",")[1];
      setImages((imgs) => [...imgs, { data: base64, mimeType: file.type, preview: dataUrl }]);
    };
    rd.onerror = () => { if (generation === attachmentGeneration.current) setAttachmentError(t("无法读取 {v0}，请重新选择文件。", { v0: file.name })); };
    rd.readAsDataURL(file);
  };

  // Non-image attachments: text-ish files go inline as ACP `resource` blocks
  // (200KB cap); binary/larger files are rejected with a hint to @-mention
  // them instead — the agent reads those itself via resource_link.
  const addFile = (file) => {
    if (!file) return;
    setAttachmentError(null);
    if (file.type.startsWith("image/")) return addImage(file);
    if (file.size > 200 * 1024) {
      setAttachmentError(t("{v0} 超过 200KB，请把文件放进工作区后用 @ 引用。", { v0: file.name }));
      return;
    }
    const generation = attachmentGeneration.current;
    const rd = new FileReader();
    rd.onload = () => {
      if (generation !== attachmentGeneration.current) return;
      const text = String(rd.result || "");
      if (text.includes("\u0000")) {
        setAttachmentError(t("{v0} 是二进制文件，请放进工作区后用 @ 引用。", { v0: file.name }));
        return;
      }
      setFiles((fs) => [...fs, { name: file.name, data: text, mimeType: file.type || "text/plain" }]);
    };
    rd.onerror = () => { if (generation === attachmentGeneration.current) setAttachmentError(t("无法读取 {v0}，请重新选择文件。", { v0: file.name })); };
    rd.readAsText(file);
  };

  // ChatView's pane-level drop target funnels files through this exact
  // path — a disabled composer reports its own attachment error instead.
  useEffect(() => {
    if (dropRef) dropRef.current = {
      add: addFile,
      reject: setAttachmentError,
      disabled,
      directory: () => setAttachmentError(t("不支持拖入文件夹，请放进工作区后用 @ 引用。")),
    };
    return () => { if (dropRef) dropRef.current = null; };
  });

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  };

  // Width changes alter wrapping; CSS caps the height relative to the pane.
  useEffect(() => {
    const host = taRef.current?.closest(".chat");
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(autoGrow);
    observer.observe(host);
    return () => observer.disconnect();
  }, [sessionId]);

  const pushHist = (t) => {
    if (!sessionId || !t) return;
    const h = [t, ...histRef.current.filter((x) => x !== t)].slice(0, HIST_MAX);
    histRef.current = h;
    try {
      localStorage.setItem(histKey(env, sessionId), JSON.stringify(h));
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
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await env.api.get(
          `/api/fs/search?root=${encodeURIComponent(cwd)}&q=${encodeURIComponent(atQ.query)}`
        );
        if (live) { setAtMatches(r.files || []); setAtIdx(0); }
      } catch {
        if (live) setAtMatches([]);
      }
    }, 180);
    return () => { live = false; clearTimeout(t); };
  }, [atQ?.query, cwd, sessionId]);

  const pickAt = (f) => {
    const at = atQ;
    if (!at) return;
    const before = text.slice(0, at.start);
    const caret = taRef.current?.selectionStart ?? at.start + at.query.length + 1;
    const after = text.slice(caret);
    addRef(f.rel, f.path);
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
    if (t === "/tree" && onOpenTree) {
      setText(""); setSlashClosed(true); onOpenTree(); return;
    }
    if ((!t && images.length === 0 && files.length === 0) || disabled) return;
    // resource_link blocks for every @path still present in the text.
    const links = [];
    for (const [rel, abs] of refs) {
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
    if (onSend(blocks) === false) return;
    pushHist(t);
    attachmentGeneration.current++;
    setDraft(emptyDraft(sessionId));
    setAttachmentError(null);
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
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
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
    if (e.key === "Enter") {
      // Touch keyboards keep Enter for newlines; use the button to send/queue.
      const wantSend =
        getUi().send === "mod" ? (e.ctrlKey || e.metaKey) && !e.shiftKey : !e.shiftKey && !window.matchMedia?.("(pointer: coarse)").matches;
      if (wantSend) {
        e.preventDefault();
        send();
      }
    }
  };

  const hasDraft = !!(text.trim() || images.length || files.length);

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
                <button type="button" className="img-preview" onClick={() => onPreviewImage?.(img.preview)} aria-label={t("预览待发送图片 {v0}", { v0: i + 1 })} title={t("点击预览图片")}>
                  <img src={img.preview} alt={t("待发送图片 {v0}", { v0: i + 1 })} />
                </button>
                <button type="button" className="img-remove" aria-label={t("移除图片 {v0}", { v0: i + 1 })} onClick={() => setImages((imgs) => imgs.filter((_, j) => j !== i))}>
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
                <button type="button" aria-label={t("移除附件 {v0}", { v0: f.name })} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {draftWarning && <p className="draft-note warning" role="status">{draftWarning}</p>}
        {!draftWarning && (images.length > 0 || files.length > 0 || refs.size > 0) && <p className="draft-note">{t("附件与文件引用仅在当前标签页暂存，发送后清理。")}</p>}
        {attachmentError && <div className="input-error" role="alert">
          <span>{attachmentError}</span><button type="button" className="icon-ghost" aria-label={t("关闭附件提示")} onClick={() => setAttachmentError(null)}><X size={14} /></button>
        </div>}
        <textarea
          ref={taRef}
          className="input-ta"
          rows={1}
          aria-label={t("给 {v0} 发消息", { v0: agentName })}
          placeholder={running ? t("{v0} 正在工作…（可直接发送排队）", { v0: agentName }) : t("给 {v0} 发消息…", { v0: agentName })}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
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
              ref={uploadRef}
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                for (const file of e.target.files || []) addFile(file);
                e.target.value = "";
              }}
            />
            <button type="button" className="tool-ic-btn" title={t("添加附件（图片或文本文件）")} aria-label={t("添加附件（图片或文本文件）")} onClick={() => uploadRef.current?.click()}>
              <Paperclip size={17} />
            </button>
            {controls}
          </div>
          <div className="it-right">
            {meter}
            {running && (
              <button type="button" className="stop" disabled={!!offline} onClick={onCancel} title={offline ? t("连接断开") : t("停止")} aria-label={t("停止")}>
                <Square size={12} fill="currentColor" />
              </button>
            )}
            {(!running || hasDraft) && (
              <button
                type="button"
                className="send"
                onClick={send}
                disabled={disabled || !hasDraft}
                title={running ? t("排队发送") : t("发送")}
                aria-label={running ? t("排队发送") : t("发送")}
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="input-hint">
        {getUi().send === "mod"
          ? t("Ctrl+Enter 发送 · Enter 换行 · ↑ 历史")
          : t("Enter 发送 · Shift+Enter 换行 · ↑ 历史")}
        {commands.length ? t(" · / 命令") : ""}
      </div>
    </div>
  );
}

export default React.memo(InputBar);
