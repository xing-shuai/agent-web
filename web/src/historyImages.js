import { historyImageAsset } from "../../server/src/history-wire.js";
import { t } from "./i18n.js";
export { historyImageAsset };

export function hasHistoryImages(value) {
  const seen = new WeakSet();
  const walk = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return false;
    seen.add(node);
    return !!historyImageAsset(node) || Object.values(node).some(walk);
  };
  return walk(value);
}

/** Materialize only on explicit raw viewing/export. Never mutate the transcript,
 * return partial JSON, or re-encode base64 (its original whitespace matters). */
export async function hydrateHistoryImages(value, api, { signal } = {}) {
  const assets = new Map(), seen = new WeakSet();
  const collect = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node); const asset = historyImageAsset(node);
    if (asset) assets.set(asset.url, asset);
    for (const child of Object.values(node)) collect(child);
  };
  collect(value);
  if (!assets.size) return value;
  const queue = [...assets.values()], resolved = new Map(), group = new AbortController();
  const cancel = () => group.abort();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (;;) {
        if (group.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const asset = queue.shift(); if (!asset) break;
        const controller = new AbortController(), abort = () => controller.abort();
        let timedOut = false;
        group.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => { timedOut = true; abort(); }, 20000);
        let result;
        try { result = await api.get(`${asset.url}?encoding=base64`, { signal: controller.signal }); }
        catch (error) { throw timedOut ? new Error(t("图片读取超时，请重试")) : error; }
        finally { clearTimeout(timer); group.signal.removeEventListener("abort", abort); }
        if (group.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (typeof result?.data !== "string" || result.mimeType !== asset.mimeType) throw new Error(t("图片原始数据不可用，请重试"));
        resolved.set(asset.url, result.data);
      }
    }));
  } catch (error) { group.abort(); throw error; }
  finally { signal?.removeEventListener("abort", cancel); }
  const copies = new WeakMap();
  const clone = (node) => {
    if (!node || typeof node !== "object") return node;
    if (copies.has(node)) return copies.get(node);
    const out = Array.isArray(node) ? [] : {}; copies.set(node, out);
    for (const [key, child] of Object.entries(node)) Object.defineProperty(out, key, { value: clone(child), enumerable: true, writable: true, configurable: true });
    const asset = historyImageAsset(node);
    if (asset) out.data = resolved.get(asset.url);
    return out;
  };
  return clone(value);
}
