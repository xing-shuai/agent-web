import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import useCopyText from "../hooks/useCopyText.js";
import { requestHighlight } from "../syntaxHighlight.js";
import { StreamingTailContext } from "../markdownBlocks.js";
import { TranscriptSearch } from "../transcriptSearch.js";
import { t } from "../i18n.js";

const textContent = (node) => node == null || typeof node === "boolean" ? "" : typeof node === "string" || typeof node === "number" ? String(node) :
  Array.isArray(node) ? node.map(textContent).join("") : textContent(node.props?.children);
const tokenNodes = (nodes) => nodes.map((node, index) => node.type === "text" ? node.value :
  <span key={index} className={node.properties?.className?.join(" ")}>{tokenNodes(node.children || [])}</span>);

/** Full text mounts immediately. Offscreen code needs neither a parser nor
 * thousands of syntax spans; coloring is computed near the viewport off-thread. */
export default function CodePre({ children }) {
  const ref = useRef(null), [visible, setVisible] = useState(false);
  const { copied, copy } = useCopyText();
  const tail = useContext(StreamingTailContext);
  const searching = !!useContext(TranscriptSearch).query || tail;
  const [colored, setColored] = useState(null);
  const codeEl = Array.isArray(children) ? children.find((child) => child?.props) : children;
  const cls = codeEl?.props?.className || "", language = cls.match(/language-([\w#+-]+)/)?.[1];
  const raw = textContent(codeEl?.props?.children);
  useEffect(() => {
    if (!language || !raw || typeof Worker === "undefined") return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    // The browser viewport also clips background/offscreen panes. An explicit
    // transcript root alone would consider those panes visible to themselves.
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting && entry.boundingClientRect.width > 0));
    }, { rootMargin: "200px 0px", scrollMargin: "200px 0px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [language, !!raw]);
  useEffect(() => {
    if (!visible || !language || !raw || searching) { setColored(null); return; }
    return requestHighlight(raw, language, (result) => setColored({ raw, language, result }));
  }, [visible, raw, language, searching]);
  // Search owns DOM Ranges: don't replace its text nodes with syntax spans.
  const tokens = useMemo(() => visible && !searching && colored?.raw === raw && colored.language === language && colored.result ? tokenNodes(colored.result.nodes) : null, [visible, colored, raw, language, searching]);
  return <div className="code-card" ref={ref}>
    <div className="cc-head"><span className="cc-lang">{language || "code"}</span><button type="button" className="cc-copy" onClick={() => copy(raw)}>
      {copied === raw ? <Check size={13} /> : <Copy size={13} />}{copied === raw ? t("已复制") : t("复制")}</button></div>
    <pre><code className={`${cls}${tokens ? " hljs" : ""}`}>{tokens || raw}</code></pre>
  </div>;
}
