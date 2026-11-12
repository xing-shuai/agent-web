// Lossless, opt-in history transport. Shared with the browser decoder; no Node APIs.
export const HISTORY_ENCODING = "strings-v1";
export const HISTORY_ENCODING_V2 = "strings-v2";
const imageAssets = new WeakMap();
export const historyImageAsset = (image) => image && typeof image === "object" ? imageAssets.get(image) : undefined;
export const HISTORY_COMPRESSION = {
  serverNoContextTakeover: true, clientNoContextTakeover: true,
  threshold: 1024, concurrencyLimit: 4, zlibDeflateOptions: { level: 3, memLevel: 7 },
};

// Keep original objects untouched. Only strings move: explicit paths avoid
// interpreting tool-returned objects as protocol markers (including __proto__).
export function packHistoryEvents(events) {
  const historyStrings = [], historyRefs = [], indexes = new Map();
  const walk = (value, path, converted = false) => {
    if (path.length >= 250) return value;
    if (!converted && value && typeof value.toJSON === "function") return walk(value.toJSON(String(path.at(-1))), path, true);
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (typeof value === "string" && value.length >= 512) {
      let index = indexes.get(value);
      if (index === undefined) { index = historyStrings.length; indexes.set(value, index); historyStrings.push(value); }
      historyRefs.push([index, ...path]);
      return null;
    }
    if (Array.isArray(value)) return value.map((child, index) => walk(child, [...path, index]));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child, [...path, key])]));
    return value;
  };
  return { events: walk(events, ["events"]), historyStrings, historyRefs };
}

// Mutate only the freshly JSON-parsed wire envelope, before any subscriber sees it.
export function unpackHistory(message) {
  if (!message.historyEncoding || message.unchanged) return message;
  if (![HISTORY_ENCODING, HISTORY_ENCODING_V2].includes(message.historyEncoding) || !Array.isArray(message.events) ||
      !Array.isArray(message.historyStrings) || !Array.isArray(message.historyRefs)) throw new Error("Invalid history encoding");
  for (const ref of message.historyRefs) {
    if (!Array.isArray(ref) || ref.length < 3 || ref.length > 256) throw new Error("Invalid history reference");
    const [index, ...path] = ref;
    if (!Number.isSafeInteger(index) || index < 0 || typeof message.historyStrings[index] !== "string" || path[0] !== "events") throw new Error("Invalid history string");
    let target = message;
    for (let i = 0; i < path.length; i++) {
      const key = path[i];
      if ((typeof key !== "string" && !Number.isSafeInteger(key)) || !target || typeof target !== "object" || !Object.hasOwn(target, key)) throw new Error("Invalid history path");
      if (i < path.length - 1) target = target[key];
      else {
        if (target[key] !== null) throw new Error("Invalid history placeholder");
        Object.defineProperty(target, key, { value: message.historyStrings[index], enumerable: true, configurable: true, writable: true });
      }
    }
  }
  if (message.historyAssets !== undefined) {
    if (message.historyEncoding !== HISTORY_ENCODING_V2 || !Array.isArray(message.historyAssets)) throw new Error("Invalid history assets");
    const prefix = `/api/sessions/${encodeURIComponent(message.sessionId)}/img/`;
    for (const asset of message.historyAssets) {
      if (!asset || typeof asset.url !== "string" || !asset.url.startsWith(prefix) || !/^pi-[a-f0-9]{64}\/0$/.test(asset.url.slice(prefix.length)) ||
          !/^image\/(png|jpeg|gif|webp|avif)$/.test(asset.mimeType) || !Number.isSafeInteger(asset.width) || asset.width <= 0 || asset.width > 32768 || !Number.isSafeInteger(asset.height) || asset.height <= 0 || asset.height > 32768 || !Array.isArray(asset.path) || asset.path.length < 4 || asset.path.length > 250 || asset.path[0] !== "events" || asset.path.at(-1) !== "data") throw new Error("Invalid history asset");
      let target = message;
      for (const key of asset.path.slice(0, -1)) {
        if ((typeof key !== "string" && !Number.isSafeInteger(key)) || !target || typeof target !== "object" || !Object.hasOwn(target, key)) throw new Error("Invalid asset path");
        target = target[key];
      }
      if (!target || target.type !== "image" || !Object.hasOwn(target, "data") || target.data !== null || imageAssets.has(target)) throw new Error("Invalid asset placeholder");
      imageAssets.set(target, { url: asset.url, mimeType: asset.mimeType, width: asset.width, height: asset.height });
    }
  }
  delete message.historyAssets; delete message.historyStrings; delete message.historyRefs;
  // Retain the negotiated format for the UI's immutable resume checkpoint.
  if (message.historyEncoding === HISTORY_ENCODING_V2) message.historyFormat = HISTORY_ENCODING_V2;
  delete message.historyEncoding;
  return message;
}
