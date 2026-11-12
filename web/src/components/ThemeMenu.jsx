import React, { useRef, useState } from "react";
import { useLayer } from "../layers.js";
import { createPortal } from "react-dom";
import { Palette, Monitor, Sun, Moon, Check } from "lucide-react";
import { getPref, setPref, getScheme, setScheme, SCHEMES } from "../theme.js";
import { t } from "../i18n.js";

const THEME_OPTS = [
  { id: "system", name: t("跟随系统"), Icon: Monitor },
  { id: "light", name: t("浅色"), Icon: Sun },
  { id: "dark", name: t("深色"), Icon: Moon },
];

/** Sidebar footer popover: appearance (light/dark/system) + accent schemes.
 *  The panel is portaled to <body>: the mobile sidebar drawer is a transformed
 *  element, which would become the containing block for a fixed-position panel
 *  and drag it off-screen along with the drawer. */
export default function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const [pref, setPrefState] = useState(getPref);
  const [scheme, setSchemeState] = useState(getScheme);
  const [bottom, setBottom] = useState(54);
  const ref = useRef(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  useLayer({ open, ref: panelRef, triggerRef: btnRef, onClose: () => setOpen(false), initialFocus: false });

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setBottom(window.innerHeight - r.top + 6);
    }
    setOpen((o) => !o);
  };

  return (
    <div className="thm" ref={ref}>
      <button className="icon-ghost" title={t("外观与主题色")} ref={btnRef} onClick={toggle}>
        <Palette size={15} />
      </button>
      {open &&
        createPortal(
          <div className="thm-panel" ref={panelRef} style={{ bottom }}>
            <div className="thm-label">{t("外观")}</div>
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
            <div className="thm-label">{t("主题色")}</div>
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
          </div>,
          document.body
        )}
    </div>
  );
}
