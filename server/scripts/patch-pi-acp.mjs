#!/usr/bin/env node
/* postinstall: patch pi-acp so free-form extension UI ("input"/"editor")
 * goes through ACP elicitation/create instead of being auto-cancelled.
 * Upstream cancels those requests outright; our web UI renders form-mode
 * elicitations as an answer card, so the user can reply.
 * Idempotent — re-runs safely; warns (not fails) if the anchor drifts on
 * a future pi-acp release. */
import { createRequire } from "module";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const req = createRequire(import.meta.url);
let pkgJson;
try {
  pkgJson = req.resolve("pi-acp/package.json");
} catch {
  console.warn("[patch-pi-acp] pi-acp not installed — skipping");
  process.exit(0);
}
const file = join(dirname(pkgJson), "dist", "index.js");
const src = readFileSync(file, "utf8");

const MARK = "__devin_elicitation_patch";
if (src.includes(MARK)) {
  console.log("[patch-pi-acp] already patched");
  process.exit(0);
}

const anchor = `    if (method === "input" || method === "editor") {
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: \`Pi \${method} UI request is not supported in ACP yet; cancelling it.\`
        }
      });
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }`;

const replacement = `    if (method === "input" || method === "editor") {
      // ${MARK}: route free-form input through elicitation/create so ACP
      // clients can render an answer card instead of auto-cancelling.
      try {
        const elicTitle = stringProp(ev, "title") ?? stringProp(ev, "message") ?? \`Pi \${method}\`;
        const elicRes = await this.conn.unstable_createElicitation({
          sessionId: this.sessionId,
          message: stringProp(ev, "message") ?? elicTitle,
          mode: "form",
          requestedSchema: {
            type: "object",
            title: elicTitle,
            properties: {
              value: {
                type: "string",
                title: elicTitle,
                description: stringProp(ev, "placeholder") ?? undefined,
                default: stringProp(ev, "prefill") ?? undefined
              }
            },
            required: ["value"]
          }
        });
        const elicVal = elicRes?.action === "accept" ? elicRes?.content?.value : null;
        await this.proc.sendExtensionUiResponse(elicVal == null ? { id, cancelled: true } : { id, value: String(elicVal) });
      } catch {
        await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      }
      return;
    }`;

if (!src.includes(anchor)) {
  console.warn("[patch-pi-acp] anchor not found — pi-acp layout changed? Patch NOT applied.");
  process.exit(0); // warn only — never break npm install
}
writeFileSync(file, src.replace(anchor, replacement));
console.log("[patch-pi-acp] applied elicitation patch to " + file);
