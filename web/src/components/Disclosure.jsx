import React, { useLayoutEffect, useMemo, useRef, useState } from "react";

/** One reversible height transition for classic and live tool/thought bodies.
 * Freeze closing children so nested lifecycle changes cannot collapse the
 * visible content halfway through their parent's exit. Never mount a closed
 * body just to measure it; release expensive output when the transition ends. */
export default function Disclosure({ open, instant = false, summary, className = "", clipClassName = "", children, ...props }) {
  const [present, setPresent] = useState(open);
  const content = useMemo(() => open ? (typeof children === "function" ? children() : children) : null, [open, children]);
  const ref = useRef(null), snapshot = useRef(content), previousInstant = useRef(instant);
  // Leaving a forced search result must be immediate too: don't leave an old
  // matching body visible while search reveals a different node.
  const immediate = instant || previousInstant.current;
  useLayoutEffect(() => {
    if (open) snapshot.current = content;
    else if (!present) snapshot.current = null;
    previousInstant.current = instant;
  });
  useLayoutEffect(() => {
    if (open) { setPresent(true); return; }
    if (!present) return;
    const reduced = immediate || document.documentElement.dataset.motion === "off" || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduced) { setPresent(false); return; }
    // Read the CSS duration rather than cutting a slower transition short.
    // The fallback also covers engines that don't fire transitionend.
    const duration = window.getComputedStyle(ref.current).transitionDuration;
    const ms = (duration && Math.max(...duration.split(",").map((value) => parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000)))) || 360;
    const timer = setTimeout(() => setPresent(false), ms + 60);
    return () => clearTimeout(timer);
  }, [open, instant]);
  const body = <div {...(!summary ? props : {})} ref={ref}
    className={`disclosure-reveal${!summary && className ? ` ${className}` : ""}`}
    data-open={open} data-instant={immediate || undefined} aria-hidden={!open} inert={!open}
    onTransitionEnd={(event) => {
      if (!open && event.target === event.currentTarget && event.propertyName === "grid-template-rows") setPresent(false);
    }}>
    <div className={`disclosure-clip${clipClassName ? ` ${clipClassName}` : ""}`}>{open ? content : present ? snapshot.current : null}</div>
  </div>;
  return summary ? <details {...props} className={className} data-open={open} open={open || present}>{summary}{body}</details> : body;
}
