import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../clipboard.js";
import { useEnvironment } from "../environmentContext.js";

/** Success feedback belongs to this source and text, never a stale async reply. */
export default function useCopyText() {
  const { host } = useEnvironment();
  const [copied, setCopied] = useState(null);
  const live = useRef(true), revision = useRef(0), timer = useRef(null);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; revision.current++; clearTimeout(timer.current); };
  }, [host]);
  const copy = useCallback(async (text) => {
    const request = ++revision.current;
    clearTimeout(timer.current); setCopied(null);
    const current = () => live.current && revision.current === request;
    const ok = await copyText(text, { host, shouldCopy: current });
    if (current() && ok) {
      setCopied(text);
      timer.current = setTimeout(() => { if (current()) setCopied(null); }, 1500);
    }
    return ok;
  }, [host]);
  return { copied, copy };
}
