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

export function buildMarkdown(items, { title, sessionId, cwd } = {}) {
  const out = [`# ${title || sessionId || "session"}`, cwd ? `> ${cwd}` : "", ""];
  for (const it of items || []) {
    switch (it.kind) {
      case "user":
        out.push(`## 你\n\n${it.text}${it.images?.length ? `\n\n*(+${it.images.length} 张图片)*` : ""}`);
        break;
      case "agent":
        out.push(`## Devin\n\n${it.text}`);
        break;
      case "thought":
        out.push(`> **思考过程**\n>\n> ${it.text.replace(/\n/g, "\n> ")}`);
        break;
      case "tool":
        out.push(toolBlock(it));
        break;
      case "plan":
        out.push(
          "**计划**\n\n" +
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
