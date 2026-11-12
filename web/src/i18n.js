import { getUi, setUi } from "./ui.js";
import { en } from "./locales/en.js";

// gettext-style: the Chinese source string IS the key. Falls back to the
// source itself when no translation exists. {name} placeholders interpolate.
const lang = () => {
  try { return getUi().lang; } catch { return "zh"; } // no localStorage (tests/SSR)
};
export const t = (source, vars) => {
  const text = lang() === "en" ? (en[source] ?? source) : source;
  return vars ? text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`) : text;
};

export const setLang = (lang, reload = () => location.reload()) => {
  setUi({ lang });
  reload();
};

// Applied once at boot (main.jsx calls applyUi next to applyTheme).
export const applyLang = () => {
  document.documentElement.lang = getUi().lang === "en" ? "en" : "zh-CN";
};
