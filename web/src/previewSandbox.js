// Only trusted bootstrap code receives a nonce. Reports never receive API
// URLs, the coordinator token, preview tickets or access to the parent DOM.
export function sandboxHTML(html, channel, interactive, documentPath = "/report.html") {
  const policy = `default-src 'none'; script-src 'nonce-${channel}' blob: ${interactive ? "'unsafe-eval'" : ""}; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src blob: data:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri https://report-preview.invalid; worker-src 'none'`;
  const input = JSON.stringify([html, channel, interactive, policy, documentPath]).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><base href="https://report-preview.invalid/report.html"></head><body><script nonce="${channel}">(${bootstrap.toString()})(...${input});</script></body></html>`;
}

function bootstrap(html, channel, interactive, policy, documentPath) {
  const origin = "https://report-preview.invalid", baseURL = origin + documentPath, pending = new Map(), urls = new Map();
  let sequence = 0;
  const tell = (action, data = {}) => parent.postMessage({ channel, action, ...data }, "*");
  const warn = (error) => tell("warning", { error: String(error?.message || error).slice(0, 240) });
  // Defense in depth; CSP, opaque origin and the native top-frame/origin gate
  // are the boundaries. No networking or native interface is delegated here.
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false }); } catch { /* unavailable */ }
  }
  addEventListener("message", (event) => {
    const m = event.data;
    if (event.source !== parent || m?.channel !== channel || m.action !== "resource-result") return;
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m);
  });
  const request = (url) => new Promise((resolve, reject) => {
    const parsed = new URL(String(url), baseURL);
    if (parsed.origin !== origin) { reject(new Error("External resources are disabled: " + parsed.origin)); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Resource timed out")); }, 20000);
    pending.set(id, { resolve, reject, timer }); tell("resource", { id, url: parsed.href });
  });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (/^(?:blob:|data:)/i.test(url)) return nativeFetch(input, options);
    if ((options.method || input.method || "GET").toUpperCase() !== "GET") throw new Error("Preview is read-only");
    const result = await request(url);
    return new Response(result.bytes, { status: 200, headers: { "Content-Type": result.mimeType } });
  };
  class PreviewXHR extends EventTarget {
    open(method, url, async = true) { if (method.toUpperCase() !== "GET" || !async) throw new Error("Preview is read-only"); this.url = url; this.readyState = 1; }
    setRequestHeader() {}
    getResponseHeader(name) { return name.toLowerCase() === "content-type" ? this.mimeType : null; }
    abort() { this.aborted = true; }
    async send() {
      try {
        const r = await request(this.url); if (this.aborted) return;
        this.status = 200; this.readyState = 4; this.mimeType = r.mimeType;
        this.responseText = new TextDecoder().decode(r.bytes);
        this.response = this.responseType === "arraybuffer" ? r.bytes : this.responseType === "blob" ? new Blob([r.bytes], { type: r.mimeType }) : this.responseType === "json" ? JSON.parse(this.responseText) : this.responseText;
        for (const type of ["readystatechange", "load", "loadend"]) { const event = new Event(type); this["on" + type]?.(event); this.dispatchEvent(event); }
      } catch (error) { this.status = 0; this.onerror?.(new Event("error")); warn(error); }
    }
  }
  window.XMLHttpRequest = PreviewXHR;
  const replaceAsync = async (text, regex, fn) => {
    const matches = [...text.matchAll(regex)], replacements = await Promise.all(matches.map(fn));
    for (let i = matches.length - 1; i >= 0; i--) text = text.slice(0, matches[i].index) + replacements[i] + text.slice(matches[i].index + matches[i][0].length);
    return text;
  };
  async function resourceURL(value, base = baseURL, kind = "asset", ancestors = []) {
    if (/^(?:data:|blob:|#)/i.test(value)) return value;
    const url = new URL(value, base).href;
    if (ancestors.includes(url)) throw new Error("Cyclic resource imports are unsupported");
    const key = kind + url;
    if (!urls.has(key)) urls.set(key, (async () => {
      const result = await request(url); let body = result.bytes, mime = result.mimeType;
      if (kind === "style") { body = await css(new TextDecoder().decode(body), url, [...ancestors, url]); mime = "text/css"; }
      if (kind === "module") {
        body = await moduleCode(new TextDecoder().decode(body), url, [...ancestors, url]);
        mime = "text/javascript";
      }
      return URL.createObjectURL(new Blob([body], { type: mime }));
    })());
    return urls.get(key);
  }
  async function moduleCode(text, base, ancestors = []) {
    return replaceAsync(text, /(\b(?:import|export)\s+(?:[^'";\n]*?\sfrom\s*)?|\bimport\s*\()\s*(['"])([^'"]+)\2/g,
      async (m) => m[1] + JSON.stringify(await resourceURL(m[3], base, "module", ancestors)));
  }
  async function css(text, base, ancestors = []) {
    text = await replaceAsync(text, /@import\s+(['"])([^'"]+)\1/g, async (m) => "@import url(" + JSON.stringify(await resourceURL(m[2], base, "style", ancestors)) + ")");
    return replaceAsync(text, /url\(\s*(['"]?)([^'"\)]*?)\1\s*\)/g, async (m) => {
      try { return "url(" + JSON.stringify(await resourceURL(m[2], base, "asset", ancestors)) + ")"; } catch (e) { warn(e); return "url(data:,)"; }
    });
  }
  const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src"), logical = new WeakMap();
  const loadImage = async (image, value) => {
    logical.set(image, value);
    try { const url = await resourceURL(value); if (logical.get(image) === value) imageSrc.set.call(image, url); } catch (e) { image.alt ||= String(value); warn(e); }
  };
  Object.defineProperty(HTMLImageElement.prototype, "src", { configurable: true, get() { return logical.get(this) || imageSrc.get.call(this); }, set(value) {
    if (/^(?:data:|blob:)/i.test(value)) { logical.set(this, value); imageSrc.set.call(this, value); }
    else loadImage(this, String(value));
  } });
  const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); loadImage(e.target, e.target.dataset.previewSrc); }
  }, { rootMargin: "300px" }) : null;
  const queueImage = (image) => { if (!image.dataset.previewSrc) return; image.loading = "lazy"; observer ? observer.observe(image) : loadImage(image, image.dataset.previewSrc); };
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); tell("close"); } });
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]"); if (!link) return;
    event.preventDefault(); const href = link.getAttribute("href");
    if (href.startsWith("#")) { try { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView(); } catch {} }
    else tell("link", { url: href });
  }, true);
  (async () => {
    // Restrictive policy precedes untrusted markup even in the inert parser.
    const doc = new DOMParser().parseFromString(`<meta http-equiv="Content-Security-Policy" content="${policy}"><base href="${baseURL}">` + html, "text/html");
    const scripts = [], handlers = [];
    for (const e of doc.querySelectorAll("base,meta[http-equiv],iframe,frame,object,embed,link[rel=preload],link[rel=prefetch],link[rel=modulepreload]")) e.remove();
    for (const script of doc.querySelectorAll("script")) {
      if (/^application\/(?:ld\+)?json$/i.test(script.type)) continue;
      const marker = doc.createElement("span"); marker.hidden = true;
      marker.dataset.previewScript = String(scripts.length);
      scripts.push({ src: script.getAttribute("src"), code: script.textContent, module: script.type === "module" }); script.replaceWith(marker);
    }
    for (const e of doc.querySelectorAll("*")) {
      for (const attribute of [...e.attributes]) if (/^on/i.test(attribute.name)) {
        if (interactive) { const index = handlers.length; handlers.push([attribute.name.slice(2), attribute.value]); e.setAttribute("data-preview-handler-" + index, ""); }
        e.removeAttribute(attribute.name);
      }
      if (e.tagName === "IMG") {
        const src = e.getAttribute("src") || e.getAttribute("srcset")?.split(/\s|,/)[0];
        e.removeAttribute("srcset");
        if (src && !/^(?:data:|blob:)/i.test(src)) { e.dataset.previewSrc = src; e.removeAttribute("src"); }
      }
      if (e.hasAttribute("style")) e.setAttribute("style", await css(e.getAttribute("style"), baseURL));
    }
    for (const style of doc.querySelectorAll("style")) style.textContent = await css(style.textContent, baseURL);
    for (const link of doc.querySelectorAll("link[href]")) {
      if (link.rel !== "stylesheet") { link.remove(); continue; }
      try { const style = doc.createElement("style"), r = await request(link.getAttribute("href")); style.textContent = await css(new TextDecoder().decode(r.bytes), new URL(link.getAttribute("href"), baseURL).href); link.replaceWith(style); }
      catch (e) { link.remove(); warn(e); }
    }
    const base = doc.createElement("base"); base.href = baseURL; doc.head.prepend(base);
    const defaults = doc.createElement("style"); defaults.textContent = "body{margin:16px;font-family:system-ui,sans-serif}img{max-width:100%}pre{overflow:auto}"; doc.head.prepend(defaults);
    document.documentElement.replaceChildren(document.importNode(doc.head, true), document.importNode(doc.body, true));
    document.querySelectorAll("img").forEach(queueImage);
    new MutationObserver((mutations) => { for (const m of mutations) {
      if (m.type === "attributes" && m.target.tagName === "IMG") { const src = m.target.getAttribute("src"); if (src && !/^(?:data:|blob:)/i.test(src)) loadImage(m.target, src); }
      for (const node of m.addedNodes || []) if (node.nodeType === 1) { if (node.tagName === "IMG") queueImage(node); node.querySelectorAll?.("img").forEach(queueImage); }
    } }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
    if (interactive) {
      handlers.forEach(([type, code], i) => document.querySelectorAll("[data-preview-handler-" + i + "]").forEach((e) => e.addEventListener(type, function(event) { if (new Function("event", "with(this){" + code + "}").call(this, event) === false) event.preventDefault(); })));
      for (let i = 0; i < scripts.length; i++) {
        const item = scripts[i], marker = document.querySelector('[data-preview-script="' + i + '"]'), script = document.createElement("script");
        script.nonce = channel; if (item.module) script.type = "module";
        try {
          if (item.src || item.module) {
            script.src = item.src ? await resourceURL(item.src, baseURL, item.module ? "module" : "asset")
              : URL.createObjectURL(new Blob([await moduleCode(item.code, baseURL)], { type: "text/javascript" }));
            const loaded = new Promise((resolve, reject) => { script.onload = resolve; script.onerror = () => reject(new Error("Script could not load")); });
            marker.replaceWith(script); await loaded;
          } else { script.textContent = item.code; marker.replaceWith(script); }
        } catch (e) { warn(e); }
      }
    }
    document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true }));
    window.dispatchEvent(new Event("load"));
    tell("ready");
  })().catch(warn);
}
