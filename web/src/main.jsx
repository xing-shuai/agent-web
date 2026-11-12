import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { apply as applyTheme } from "./theme.js";
import { applyUi } from "./ui.js";
import { applyLang } from "./i18n.js";
import App from "./App.jsx";
import "./styles.css";

applyTheme();
applyUi();
applyLang();
createRoot(document.getElementById("root")).render(<App />);

// Installability only — sw.js performs no caching.
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
