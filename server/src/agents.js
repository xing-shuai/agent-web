import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

// Devin extension flags — these gate which slash commands the agent
// advertises in available_commands_update.
//   chains:                 +/btw
//   workspaceDirCommands:   +/add-dir /undo-add-dir /remove-dir
// The revert flags unlock the revert/* RPC namespace (listSteps/forkFromStep).
const DEVIN_INIT_META = {
  "cognition.ai/chains": true,
  "cognition.ai/workspaceDirCommands": true,
  "cognition.ai/revert": true,
  "cognition.ai/revertByUserMessageId": true,
};

const firstExisting = (paths) => paths.find((p) => fs.existsSync(p));

/** Agent registry: one ACP client + SessionHub per enabled agent.
 *  Enabled set comes from DEVIN_WEB_AGENTS (comma list, default "devin,pi"),
 *  in that order — the first enabled entry is the primary hub that owns the
 *  shared workspace list. `devinExt` marks the devin-only behaviours (sqlite
 *  mirror, lock states, revert/fork, prompt_history graft); `caps` is what
 *  the frontend needs to show/hide features. */
export function buildAgents() {
  const all = [
    {
      id: "devin",
      name: "Devin",
      bin: process.env.DEVIN_BIN || "devin",
      args: ["acp"],
      initMeta: DEVIN_INIT_META,
      devinExt: true,
      caps: { fork: true, quota: true },
    },
    {
      id: "pi",
      name: "Pi",
      bin:
        process.env.PI_ACP_BIN ||
        firstExisting([
          path.join(ROOT, "node_modules", ".bin", "pi-acp"),
          path.join(ROOT, "server", "node_modules", ".bin", "pi-acp"),
        ]),
      args: [],
      initMeta: {},
      devinExt: false,
      caps: { fork: false, quota: false },
    },
  ];
  const enabled = (process.env.DEVIN_WEB_AGENTS || "devin,pi")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const id of enabled) {
    const a = all.find((x) => x.id === id);
    if (!a || !a.bin) continue;
    out.push(a);
  }
  return out;
}
