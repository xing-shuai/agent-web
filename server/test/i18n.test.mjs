import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM("", { url: "http://localhost/" });
for (const k of ["window", "document", "localStorage", "Event", "location"])
  Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: dom.window[k] });
const { t, setLang } = await import("../../web/src/i18n.js");
const { getUi, setUi } = await import("../../web/src/ui.js");
const { en } = await import("../../web/src/locales/en.js");

test("t falls back to source, interpolates and looks up en", () => {
  assert.equal(getUi().lang, "zh");
  assert.equal(t("删除"), "删除");
  assert.equal(t("一个没有词条的字符串"), "一个没有词条的字符串");
  assert.equal(t("{v0} 分钟前", { v0: 5 }), "5 分钟前");
  setUi({ lang: "en" });
  assert.equal(t("删除"), "Delete");
  assert.equal(t("没有词条而已"), "没有词条而已");
  setUi({ lang: "zh" });
});

test("setLang persists and reloads", () => {
  const reloads = [];
  setLang("en", () => reloads.push(1));
  assert.equal(getUi().lang, "en");
  assert.equal(reloads.length, 1);
  setUi({ lang: "zh" });
});

const SRC = path.resolve(import.meta.dirname, "../../web/src");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== "locales") walk(p);
    else if (/\.jsx?$/.test(e.name) && e.name !== "i18n.js") files.push(p);
  }
})(SRC);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const ALLOW = [/中文/, /English/, /[\u4e00-\u9fff]/ === null, /选项描述与键名相同/];

test("every t() key has an en dictionary entry", () => {
  const missing = new Set();
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(/(?<![\w$.])t\(("(?:[^"\\]|\\.)*")|(?<![\w$.])t\(`((?:[^`\\]|\\.)*`)|(?<![\w$.])t\('((?:[^'\\]|\\.)*')/g)) {
      let k;
      try { k = eval(m[1] ?? m[2] ?? m[3]); } catch { continue; } // cooked value — matches what t() receives at runtime
      if (typeof k !== "string" || !/[\u4e00-\u9fff]/.test(k)) continue;
      if (!(k in en)) missing.add(`${path.basename(f)}: ${k.slice(0, 60)}`);
    }
  }
  assert.equal(missing.size, 0, "missing en entries:\n" + [...missing].join("\n"));
});

test("no unwrapped CJK literals in string/JSX positions", () => {
  const leaks = [];
  const allow = [/\/src\/components\/SettingsMenu\.jsx.*Chinese|l: "中文"/, /v: "zh", l: "中文"/, /components\/ConfigMenu\.jsx:\d+:.*\/model\|模型\/i\.test/];
  for (const f of files) {
    const rel = path.relative(SRC, f);
    strip(fs.readFileSync(f, "utf8")).split("\n").forEach((line, i) => {
      if (/state[nN]ame|states\s*=\s*\{/.test(line)) return;
      const noT = line.replace(/t\((?:"([^"\\]|\\.)*"|`[^`]*`|'[^']*')\s*(?:,[^)]*)?\)/g, "");
      if (/[\u4e00-\u9fff]/.test(noT) && !allow.some((r) => r.test(`${rel}:${i + 1}:${line}`))) leaks.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.equal(leaks.length, 0, "unwrapped CJK (allowlist: language-picker labels):\n" + leaks.slice(0, 20).join("\n"));
});
