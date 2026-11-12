// A lazy, single browser worker. Only its current job is posted: cancelling
// offscreen/unmounted/stream-replaced requests cannot build a stale work queue.
const queue = new Map(), cache = new Map();
let worker, active, timer, disabled = false, sequence = 0, cacheBytes = 0;
const cacheKey = (code, language) => `${language}\0${code}`;

function pump() {
  if (active || !queue.size || disabled) return;
  if (!worker) {
    try {
      worker = new Worker(new URL("./syntaxHighlight.worker.js", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }) => {
        if (data.id !== active?.id) return;
        clearTimeout(timer);
        const job = active; active = null;
        const weight = (job.code.length + job.language.length) * 2 + (data.result?.bytes || 0);
        if (weight <= 2 * 1024 * 1024) {
          const key = cacheKey(job.code, job.language), old = cache.get(key);
          if (old) cacheBytes -= old.weight;
          cache.delete(key); cache.set(key, { result: data.result, weight }); cacheBytes += weight;
          while (cache.size > 32 || cacheBytes > 8 * 1024 * 1024) { const key = cache.keys().next().value; cacheBytes -= cache.get(key).weight; cache.delete(key); }
        }
        job.done?.(data.result); pump();
      };
      worker.onerror = (event) => { event.preventDefault(); fail(); };
      worker.onmessageerror = fail;
    } catch { fail(); return; }
  }
  active = queue.values().next().value; queue.delete(active.id);
  timer = setTimeout(fail, 5000);
  try { worker.postMessage({ id: active.id, code: active.code, language: active.language }); } catch { fail(); }
}

function fail() {
  clearTimeout(timer); worker?.terminate(); worker = null; disabled = true;
  const pending = [active, ...queue.values()]; active = null; queue.clear();
  for (const job of pending) job?.done?.(null);
}

export function requestHighlight(code, language, done) {
  if (disabled || typeof Worker === "undefined" || code.length > 200000 || language.length > 128) { done(null); return () => {}; }
  const key = cacheKey(code, language), hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); done(hit.result); return () => {}; }
  const job = { id: ++sequence, code, language, done };
  queue.set(job.id, job); pump();
  return () => { queue.delete(job.id); job.done = null; };
}
