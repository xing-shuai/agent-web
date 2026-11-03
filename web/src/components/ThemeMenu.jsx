import React, { useEffect, useRef, useState } from "react";
import { Palette, Monitor, Sun, Moon, Check } from "lucide-react";
import { getPref, setPref, getScheme, setScheme, SCHEMES } from "../theme.js";

const THEME_OPTS = [
  { id: "system", name: "跟随系统", Icon: Monitor },
  { id: "light", name: "浅色", Icon: Sun },
  { id: "dark", name: "深色", Icon: Moon },
];

/** Sidebar footer popover: appearance (light/dark/system) + accent schemes. */
export default function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const [pref, setPrefState] = useState(getPref);
  const [scheme, setSchemeState] = useState(getScheme);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="thm" ref={ref}>
      <button className="icon-ghost" title="外观与主题色" onClick={() => setOpen((o) => !o)}>
        <Palette size={15} />
      </button>
      {open && (
        <div className="thm-panel">
          <div className="thm-label">外观</div>
          <div className="thm-row">
            {THEME_OPTS.map(({ id, name, Icon }) => (
              <button
                key={id}
                className={"thm-opt" + (pref === id ? " cur" : "")}
                onClick={() => {
                  setPref(id);
                  setPrefState(id);
                }}
              >
                <Icon size={13} />
                {name}
              </button>
            ))}
          </div>
          <div className="thm-label">主题色</div>
          <div className="thm-swatches">
            {SCHEMES.map((s) => (
              <button
                key={s.id}
                className={"thm-swatch" + (scheme === s.id ? " cur" : "")}
                title={s.name}
                onClick={() => {
                  setScheme(s.id);
                  setSchemeState(s.id);
                }}
              >
                <span
                  className="thm-dot"
                  style={{ background: `linear-gradient(135deg, ${s.bg} 50%, ${s.c} 50%)` }}
                />
                <span className="thm-sname">{s.name}</span>
                {scheme === s.id && <Check size={12} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
