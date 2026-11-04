// Patches @eko24ive/pi-ask so ask_user works when pi runs headless under
// pi-acp (ctx.mode === "rpc"). Upstream returns "requires interactive TUI
// mode" for anything but the TUI; here we run a degraded flow over the
// extension_ui select/input dialogs, which pi-acp already bridges to ACP
// permission cards / elicitation cards in agent-web.
// Idempotent: skips when the marker is already present.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const MARKER = "__devin_rpc_ask_patch";

function resolveAskTool() {
  const candidates = [];
  if (process.env.PI_ASK_PKG) candidates.push(process.env.PI_ASK_PKG);
  try {
    const req = createRequire(path.join(os.homedir(), ".pi/agent/npm/package.json"));
    candidates.push(path.dirname(req.resolve("@eko24ive/pi-ask/package.json")));
  } catch {}
  candidates.push(path.join(os.homedir(), ".pi/agent/npm/node_modules/@eko24ive/pi-ask"));
  for (const dir of candidates) {
    const p = path.join(dir, "src/ask-tool.ts");
    if (existsSync(p)) return p;
  }
  return null;
}

const file = resolveAskTool();
if (!file) {
  console.log("patch-pi-ask: @eko24ive/pi-ask not installed — skipped");
  process.exit(0);
}
let src = readFileSync(file, "utf8");

// Re-runnable: a previously-patched file has the swap applied but its
// appended flow may be stale — cut the old block and re-append below.
const blockStart = src.indexOf(`\n// ${MARKER}: sequential fallback`);
if (blockStart >= 0) src = src.slice(0, blockStart);

// 1) widen the types import
const impFrom = 'import type { AskParams } from "./types.ts";';
const impTo = 'import type { AskParams, AskResult, AskResultAnswer } from "./types.ts";';
if (src.includes(impFrom)) src = src.replace(impFrom, impTo);
else if (!src.includes(impTo)) {
  console.error(`patch-pi-ask: import anchor not found in ${file}`);
  process.exit(1);
}

// 2) swap the non-tui early-return for the degraded flow
const retFrom = `	if (ctx.mode !== "tui") {
		return nonInteractiveResponse(validation.state);
	}`;
const retTo = `	if (ctx.mode !== "tui") {
		// ${MARKER}: headless (pi-acp/remote) — answer via extension_ui
		// select/input dialogs instead of bailing out.
		try {
			return successfulResponse(await runRpcAskFlow(ctx, validation.state));
		} catch {
			return nonInteractiveResponse(validation.state);
		}
	}`;
if (src.includes(retFrom)) src = src.replace(retFrom, retTo);
else if (!src.includes("runRpcAskFlow(ctx, validation.state)")) {
  console.error(`patch-pi-ask: non-interactive return anchor not found in ${file}`);
  process.exit(1);
}

// 3) append the degraded flow
src += `
// ${MARKER}: sequential fallback when no TUI exists. Each question becomes
// one extension_ui dialog: options → ui.select (multi → loop with a Done
// sentinel), freeform/empty-option questions → ui.input. Any cancel aborts
// the whole flow with cancelled:true, matching the TUI contract.
async function runRpcAskFlow(
	ctx: ExtensionContext,
	state: ReturnType<typeof import("./state/create.ts").createInitialState>
): Promise<AskResult> {
	const ui = ctx.ui;
	const questions = state.questions;
	const answers: Record<string, AskResultAnswer> = {};
	const DONE = "✓ 完成选择";
	const OTHER = "✏️ 自定义输入…";
	let cancelled = false;

	for (const q of questions) {
		const opts = q.options ?? [];
		const labels = opts.map((o) => o.label);
		const title =
			q.label && q.label !== q.prompt ? \`\${q.label} — \${q.prompt}\` : q.prompt || q.id;
		const picked: number[] = [];
		const customTexts: string[] = [];

		if (opts.length === 0) {
			const t = await ui.input(title, "输入回答");
			if (t === undefined) cancelled = true;
			else if (t) customTexts.push(t);
		} else if (q.type === "multi") {
			const remaining = opts.map((_o, i) => i);
			while (true) {
				const sel = await ui.select(
					picked.length ? \`\${title}(已选 \${picked.length} 项)\` : title,
					[DONE, ...remaining.map((i) => labels[i]), OTHER]
				);
				if (sel === undefined) {
					cancelled = true;
					break;
				}
				if (sel === DONE) break;
				if (sel === OTHER) {
					const t = await ui.input(title, "输入自定义内容");
					if (t === undefined) {
						cancelled = true;
						break;
					}
					if (t) customTexts.push(t);
					continue;
				}
				const i = labels.indexOf(sel);
				if (i < 0) break;
				picked.push(i);
				remaining.splice(remaining.indexOf(i), 1);
				if (!remaining.length) break;
			}
		} else {
			const sel = await ui.select(title, [...labels, OTHER]);
			if (sel === undefined) cancelled = true;
			else if (sel === OTHER) {
				const t = await ui.input(title, "输入自定义内容");
				if (t === undefined) cancelled = true;
				else if (t) customTexts.push(t);
			} else {
				const i = labels.indexOf(sel);
				if (i >= 0) picked.push(i);
			}
		}
		if (cancelled) break;

		const freeformIdx = picked.find((i) => opts[i]?.freeform);
		if (freeformIdx !== undefined) {
			const t = await ui.input(
				title,
				opts[freeformIdx]?.description ?? "输入自定义内容"
			);
			if (t === undefined) {
				cancelled = true;
				break;
			}
			if (t) customTexts.push(t);
		}

		const customText = customTexts.join("；") || undefined;
		if (picked.length || customText !== undefined || !q.required) {
			answers[q.id] = {
				indices: picked,
				labels: picked.map((i) => labels[i]),
				values: picked.map((i) => opts[i]?.value ?? labels[i]),
				...(customText !== undefined ? { customText } : {}),
			};
		}
	}

	return {
		title: state.title,
		cancelled,
		mode: "submit",
		questions: questions.map((q) => ({
			id: q.id,
			label: q.label,
			prompt: q.prompt,
			type: q.requestedType ?? q.type,
			...(q.presentedType && q.presentedType !== q.requestedType
				? { presentedType: q.presentedType }
				: {}),
		})),
		answers: cancelled ? {} : answers,
	};
}
`;

writeFileSync(file, src);
console.log(`patch-pi-ask: patched ${file}`);
