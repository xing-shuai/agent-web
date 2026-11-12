import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./transcript-search-worker.js", import.meta.url));

// Full-text transcript search on a worker thread: the stores are hundreds of
// MiB and node:sqlite is synchronous, so scanning on the main thread would
// freeze every WS stream. Hits arrive incrementally so a budget cut still
// returns everything found so far.
export function searchTranscripts({ q, sessions, devinDbPath, piSessionsDir, budgetMs = 8000, limit = 50, signal }) {
  return new Promise((resolve) => {
    const deadline = Date.now() + budgetMs;
    const results = [];
    let truncated = false, settled = false, doneSeen = false;
    const worker = new Worker(WORKER, {
      workerData: { q, qLower: q.toLowerCase(), sessions, devinDbPath, piSessionsDir, budgetMs, limit, deadline },
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve({ results: results.slice(0, limit), truncated: truncated || results.length > limit, elapsedMs: Date.now() - (deadline - budgetMs) });
    };
    const timer = setTimeout(() => { truncated = true; finish(); }, budgetMs + 50);
    const onAbort = () => { truncated = true; finish(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (msg) => {
      if (msg.type === "hit") { if (results.length < limit) results.push(msg.hit); else { truncated = true; finish(); } }
      else if (msg.type === "done") { doneSeen = true; truncated ||= msg.truncated; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); finish(); }
    });
    worker.on("error", () => { clearTimeout(timer); finish(); });
    worker.on("exit", () => { truncated ||= !doneSeen; finish(); });
  });
}
