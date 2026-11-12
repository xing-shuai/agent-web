import { t } from "./i18n.js";
// Transcript → Markdown export.

const truncate = (t, n = 4000) => (t && t.length > n ? t.slice(0, n) + "\n…(truncated)" : t || "");

function toolBlock(it) {
  const name = it.toolName || it.toolKind || "tool";
  const head = `**${name}** · ${it.status || ""}${it.title ? ` — ${it.title}` : ""}`;
  const texts = (it.content || [])
    .map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
  const body = truncate(texts || JSON.stringify(it.rawInput ?? "", null, 2), 2000);
  return body ? `${head}\n\n\`\`\`\n${body}\n\`\`\`` : head;
}

export function buildMarkdown(items, { title, sessionId, cwd, agent } = {}) {
  const out = [`# ${title || sessionId || "session"}`, cwd ? `> ${cwd}` : "", ""];
  for (const it of items || []) {
    switch (it.kind) {
      case "user":
        out.push(it.images?.length ? t("## 你\n\n{v0}\n\n*(+{v1} 张图片)*", { v0: it.text, v1: it.images.length }) : t("## 你\n\n{v0}", { v0: it.text }));
        break;
      case "agent":
        out.push(`## ${agent || "Devin"}\n\n${it.text}`);
        break;
      case "thought":
        out.push(t("> **思考过程**\n>\n> {v0}", { v0: it.text.replace(/\n/g, "\n> ") }));
        break;
      case "tool":
        out.push(toolBlock(it));
        break;
      case "compaction":
        out.push(t("---\n\n**上下文压缩 · {v0}**{v1}\n\n{v2}", { v0: it.status || "completed", v1: Number.isFinite(it.at) ? ` · ${new Date(it.at).toISOString()}` : "", v2: it.summary || it.error || "" }));
        break;
      case "processNotification":
        out.push(`> **${t("后台任务")} · ${it.name || ""}**\n> ${(it.summary || "").replace(/\n/g, "\n> ")}`);
        break;
      case "branchSummary":
        out.push(t("---\n\n**分支摘要**\n\n{v0}", { v0: it.summary || "" }));
        break;
      case "plan":
        out.push(
          t("**计划**\n\n") +
            (it.entries || [])
              .map((e) => `- [${e.status === "completed" ? "x" : " "}] ${e.title || e.content || ""}`)
              .join("\n")
        );
        break;
    }
  }
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function buildJson(items, { title, sessionId, cwd } = {}) {
  return JSON.stringify(
    {
      title: title || sessionId || "session",
      sessionId: sessionId || null,
      cwd: cwd || null,
      exportedAt: new Date().toISOString(),
      items: items || [],
    },
    null,
    2
  );
}

export function downloadText(filename, text, mime = "text/markdown;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
