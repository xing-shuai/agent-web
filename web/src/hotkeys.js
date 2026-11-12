// Canonical keyboard-shortcut helpers. A spec looks like "Ctrl+Shift+Space":
// modifiers in fixed order (Ctrl, Alt, Shift, Meta) then the key name derived
// from event.code (layout-independent: KeyX→X, DigitN→N, Space, F1–F12,
// Backquote→`, etc.). formatHotkey returns null for modifier-only presses and
// unknown codes; matchHotkey compares an event against a canonical spec.

// Set while the settings recorder captures a new combo, so the global
// quick-chat listener (registered earlier on the same target) stays out.
export const hotkeyRecording = { active: false };

const NAMED_CODES = {
  Space: "Space", Tab: "Tab", Enter: "Enter", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
  Escape: "Escape",
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
};

export function keyNameOf(code) {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return NAMED_CODES[code] || null;
}

export function formatHotkey(e) {
  const key = keyNameOf(e?.code);
  if (!key) return null;
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(key);
  return parts.join("+");
}

export function matchHotkey(e, spec) {
  if (!e || !spec) return false;
  return formatHotkey(e) === spec;
}
