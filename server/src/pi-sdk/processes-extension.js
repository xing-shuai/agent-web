// Loaded by the SDK's TypeScript-aware extension loader, not by Node directly.
// Keep the upstream engine unchanged; only Web policy belongs here.
import processes from "@aliou/pi-processes/extensions/processes/index.ts";
import { isBackgroundCommand, registerBackgroundBlocker } from "@aliou/pi-processes/extensions/processes/hooks/background-blocker.ts";

export default async function webProcesses(pi) {
  await processes(pi);
  if (process.platform === "win32") return;
  // Web must not silently lose completion notifications to unmanaged nohup/&.
  // Reuse the upstream AST-based guard without changing personal Pi settings.
  registerBackgroundBlocker(pi, () => true);
  pi.on("tool_call", (event) => {
    if (event.toolName === "process" && event.input?.action === "start" && isBackgroundCommand(event.input.command || ""))
      return { block: true, reason: "Run the foreground command inside process start; do not detach it with nohup, setsid, disown or &." };
  });
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.background_processes = "For background commands use the process tool, not nohup, disown, setsid or shell &. Start finite jobs with onSuccess/onFailure turn notifications, continue other work, and inspect process output when notified. Never poll with sleep. Stop generation does not stop background processes; stop them explicitly when requested. Do not background the command inside process start. Use a shell timeout command when a runtime deadline is needed.";
  });
}
