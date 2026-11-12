import { parseAst } from "rollup/parseAst";
import { transformSync } from "esbuild";
import { readFileSync, readdirSync, statSync } from "fs";

function* files(dir) {
  for (const f of readdirSync(dir)) {
    const p = dir + "/" + f;
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(jsx?|tsx?)$/.test(f) && !p.includes("/locales/")) yield p;
  }
}

function walk(node, cb) {
  if (!node || typeof node !== "object") return;
  cb(node);
  for (const k of Object.getOwnPropertyNames(node)) {
    if (k === "loc" || k === "range" || k === "type" || k === "start" || k === "end") continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const n of v) if (n && typeof n === "object") walk(n, cb);
    } else if (v && typeof v === "object") {
      walk(v, cb);
    }
  }
}

const keys = new Set();
const suspects = [];
const parseErrors = [];
for (const f of files(process.argv[2] || "web/src")) {
  const src = readFileSync(f, "utf8");
  let js;
  try {
    js = transformSync(src, { loader: f.endsWith("x") ? "jsx" : "js", jsx: "transform" }).code;
  } catch (e) {
    parseErrors.push(`${f}: ${e.message.split("\n")[1] || e.message}`);
    continue;
  }
  let ast;
  try {
    ast = parseAst(js, { allowReturnOutsideFunction: true });
  } catch (e) {
    parseErrors.push(`${f}: acorn ${e.message}`);
    continue;
  }
  walk(ast, (n) => {
    if (n.type === "CallExpression" && n.callee?.type === "Identifier" && n.callee.name === "t") {
      const a = n.arguments?.[0];
      if (!a) { suspects.push(`${f}:${n.start}: t() no args`); return; }
      const val = a.type === "Literal" ? a.value
        : a.type === "TemplateLiteral" && a.expressions.length === 0 ? a.quasis[0].value.cooked
        : undefined;
      if (typeof val === "string") keys.add(val);
      else suspects.push(`${f}:${n.start}: t() first arg not static (${a.type})`);
    }
    if (n.type === "Literal" && typeof n.value === "string" && /t\(|\$\{|^\)/.test(n.value))
      suspects.push(`${f}:${n.start}: literal ${JSON.stringify(n.value.slice(0, 80))}`);
    if (n.type === "TemplateElement" && n.value?.cooked && /t\(|^\)/.test(n.value.cooked))
      suspects.push(`${f}:${n.start}: template part ${JSON.stringify(n.value.cooked.slice(0, 80))}`);
  });
}

console.log(JSON.stringify([...keys].sort()));
console.error("=== parse errors ===\n" + parseErrors.join("\n") + "\n=== suspects ===\n" + (suspects.join("\n") || "none"));
