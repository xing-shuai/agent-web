// Theme preference: "system" | "light" | "dark", persisted in localStorage.
// `apply` sets <html data-theme>; call before first render to avoid a flash.

const KEY = "devin-web.theme";
const mq = window.matchMedia
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : { matches: true, addEventListener() {} };

export function getPref() {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function resolved() {
  const p = getPref();
  return p === "system" ? (mq.matches ? "dark" : "light") : p;
}

export function apply() {
  const t = resolved();
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.scheme = getScheme();
  document.documentElement.dataset.view = getView();
  // Keep browser chrome color in sync. With a "system" pref the two
  // media-scoped metas do the work; an explicit pref forces both to the
  // resolved color so it wins regardless of which media query matches.
  const darkMeta = document.querySelector(
    'meta[name="theme-color"][media="(prefers-color-scheme: dark)"]'
  );
  const lightMeta = document.querySelector(
    'meta[name="theme-color"][media="(prefers-color-scheme: light)"]'
  );
  if (getPref() === "system") {
    if (darkMeta) darkMeta.content = "#0f0f11";
    if (lightMeta) lightMeta.content = "#ffffff";
  } else {
    const c = t === "dark" ? "#0f0f11" : "#ffffff";
    if (darkMeta) darkMeta.content = c;
    if (lightMeta) lightMeta.content = c;
  }
}

export function setPref(v) {
  localStorage.setItem(KEY, v);
  apply();
}

// Next step in the system → light → dark cycle.
export function nextPref() {
  return { system: "light", light: "dark", dark: "system" }[getPref()];
}

// ---------- accent schemes ----------

const SCHEME_KEY = "devin-web.scheme";
// Dark palettes: `bg` is the scheme's main background, `c` its accent — the
// swatch renders them split so a card previews the whole palette.
export const SCHEMES = [
  { id: "slate", name: "深灰", bg: "#191a1c", c: "#8ab4f8" },
  { id: "ocean", name: "深空", bg: "#26303f", c: "#6ea8fe" },
  { id: "warm", name: "暖灰", bg: "#2d2a27", c: "#f2a35e" },
  { id: "violet", name: "雾紫", bg: "#2b2836", c: "#b79df5" },
  { id: "moss", name: "苔绿", bg: "#272b27", c: "#7dd3a8" },
  { id: "graphite", name: "石墨", bg: "#0f0f11", c: "#818cf8" },
];

export function getScheme() {
  const v = localStorage.getItem(SCHEME_KEY);
  return SCHEMES.some((s) => s.id === v) ? v : "slate";
}

export function setScheme(id) {
  localStorage.setItem(SCHEME_KEY, id);
  document.documentElement.dataset.scheme = getScheme();
}

// ---------- transcript views ----------

const VIEW_KEY = "devin-web.view";
export const VIEWS = [
  { value: "default", name: "默认", description: "标准聊天气泡布局" },
  { value: "bubbles", name: "气泡", description: "双方消息都显示为气泡" },
  { value: "cards", name: "卡片", description: "每条消息是独立卡片" },
  { value: "timeline", name: "时间线", description: "左侧时间轴 + 节点" },
  { value: "compact", name: "紧凑", description: "更小字号更密排布" },
  { value: "reading", name: "阅读", description: "大字号宽行距，适合长文" },
  { value: "focus", name: "专注", description: "收窄居中，减少干扰" },
  { value: "terminal", name: "终端", description: "等宽字体命令行风格" },
  { value: "notebook", name: "笔记", description: "Jupyter 式编号单元格" },
  { value: "spotlight", name: "聚光", description: "淡化旧内容，突出当前轮" },
  { value: "plain", name: "纯文本", description: "去掉所有装饰和容器" },
];

export function getView() {
  const v = localStorage.getItem(VIEW_KEY);
  return VIEWS.some((s) => s.value === v) ? v : "default";
}

export function setView(id) {
  localStorage.setItem(VIEW_KEY, id);
  document.documentElement.dataset.view = getView();
}

// Live-update when the OS theme flips while pref is "system".
mq.addEventListener("change", () => {
  if (getPref() === "system") apply();
});
