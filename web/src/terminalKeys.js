/** Match xterm's normal/application cursor modes instead of always sending CSI. */
export function terminalKeySequence(key, modes = {}, ctrl = false) {
  const cursor = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" }[key];
  if (cursor) return ctrl ? `\x1b[1;5${cursor}` : `\x1b${modes.applicationCursorKeysMode ? "O" : "["}${cursor}`;
  const tilde = { pageUp: 5, pageDown: 6, delete: 3 }[key];
  if (tilde) return `\x1b[${tilde}${ctrl ? ";5" : ""}~`;
  return { interrupt: "\x03", tab: "\t", escape: "\x1b" }[key] || "";
}

/** One-shot Ctrl applies to an ASCII key, never arbitrary IME/pasted text. */
export function ctrlCharacter(text) {
  if (text.length !== 1) return null;
  if (text === " ") return "\x00";
  if (text === "?") return "\x7f";
  const code = text.charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  return null;
}
