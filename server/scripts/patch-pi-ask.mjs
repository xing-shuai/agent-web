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
if (src.includes(MARKER)) {
  console.log("patch-pi-ask: already patched");
  process.exit(0);
}

// 1) widen the types import
const impFrom = 'import type { AskParams } from "./types.ts";';
const impTo = 'import type { AskParams, AskResult, AskResultAnswer } from "./types.ts";';
if (!src.includes(impFrom)) {
  console.error(`patch-pi-ask: import anchor not found in ${file}`);
  process.exit(1);
}
src = src.replace(impFrom, impTo);

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
if (!src.includes(retFrom)) {
  console.error(`patch-pi-ask: non-interactive return anchor not found in ${file}`);
  process.exit(1);
}
src = src.replace(retFrom, retTo);

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
	let cancelled = false;

	for (const q of questions) {
		const opts = q.options ?? [];
		const labels = opts.map((o) => o.label);
		const title =
			q.label && q.label !== q.prompt ? \`\${q.label} — \${q.prompt}\` : q.prompt || q.id;
		const picked: number[] = [];
		let customText: string | undefined;

		if (opts.length === 0) {
			customText = await ui.input(title, "输入回答");
			if (customText === undefined) cancelled = true;
		} else if (q.type === "multi") {
			const remaining = opts.map((_o, i) => i);
			while (remaining.length) {
				const sel = await ui.select(
					picked.length ? \`\${title}(已选 \${picked.length} 项)\` : title,
					[DONE, ...remaining.map((i) => labels[i])]
				);
				if (sel === undefined) {
					cancelled = true;
					break;
				}
				if (sel === DONE) break;
				const i = labels.indexOf(sel);
				if (i < 0) break;
				picked.push(i);
				remaining.splice(remaining.indexOf(i), 1);
			}
		} else {
			const sel = await ui.select(title, labels);
			if (sel === undefined) cancelled = true;
			else {
				const i = labels.indexOf(sel);
				if (i >= 0) picked.push(i);
			}
		}
		if (cancelled) break;

		const freeformIdx = picked.find((i) => opts[i]?.freeform);
		if (freeformIdx !== undefined) {
			customText = await ui.input(
				title,
				opts[freeformIdx]?.description ?? "输入自定义内容"
			);
			if (customText === undefined) {
				cancelled = true;
				break;
			}
		}

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
