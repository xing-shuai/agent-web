// JSDOM stub: any Terminal API surface resolves to a no-op/disposable so
// TerminalPanel mounts and opens its connection without a real canvas.
const noop = () => {};
const disposable = { dispose: noop };
export class Terminal {
  constructor() {
    this.cols = 80;
    this.rows = 24;
    this.modes = {};
    this.options = {};
    this.textarea = { addEventListener: noop, removeEventListener: noop, focus: noop, style: {} };
    this.element = { addEventListener: noop, removeEventListener: noop, querySelector: () => null, style: {} };
    const active = new Proxy({ viewportY: 0, baseY: 0, length: 0, getLine: () => null },
      { get: (t, p) => (p in t ? t[p] : String(p).startsWith("on") ? () => disposable : noop) });
    this.buffer = new Proxy({ active }, { get: (t, p) => (p in t ? t[p] : String(p).startsWith("on") ? () => disposable : noop) });
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        if (value !== undefined) return value;
        if (String(prop).startsWith("on")) return () => disposable;
        return noop;
      },
    });
  }
}
export default Terminal;
