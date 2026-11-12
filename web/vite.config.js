import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PDF support is lazy; fonts/CMaps/WASM are published, never downloaded by
// the initial chat bundle and never fetched from a third-party CDN.
const pdfRoot = path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
const pdfVersion = JSON.parse(fs.readFileSync(path.join(pdfRoot, "package.json"), "utf8")).version;
const pdfFolders = ["cmaps", "standard_fonts", "wasm", "iccs"];
function pdfAssets() {
  return { name: "pdf-preview-assets",
    generateBundle() {
      for (const folder of pdfFolders) for (const name of fs.readdirSync(path.join(pdfRoot, folder))) {
        const file = path.join(pdfRoot, folder, name);
        if (fs.statSync(file).isFile()) this.emitFile({ type: "asset", fileName: `pdfjs/${pdfVersion}/${folder}/${name}`, source: fs.readFileSync(file) });
      }
    },
    configureServer(server) {
      server.middlewares.use(`/pdfjs/${pdfVersion}`, (req, res, next) => {
        try {
          const relative = decodeURIComponent(new URL(req.url, "http://localhost").pathname).slice(1);
          if (!new RegExp(`^(?:${pdfFolders.join("|")})/[^/]+$`).test(relative)) return next();
          res.setHeader("Content-Type", relative.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
          res.end(fs.readFileSync(path.join(pdfRoot, relative)));
        } catch { next(); }
      });
    },
  };
}
export default defineConfig({
  plugins: [react(), pdfAssets()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
