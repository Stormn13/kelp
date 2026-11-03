import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Three windows, three entry points: the full app, the overlay panel, and the
// untouched vanilla desk pet. The pet is deliberately not a React entry.
export default defineConfig({
  root: "src",
  plugins: [react()],
  server: { port: 1420, strictPort: true },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // noVNC 1.7 probes WebCodecs with top-level await, which the default es2020
    // target cannot transpile. ES2022 is where top-level await landed, and every
    // Tauri webview (WebView2, WKWebView, WebKitGTK) supports it.
    target: "es2022",
    rollupOptions: {
      input: {
        main: "src/index.html",
        overlay: "src/overlay.html",
        pet: "src/pet.html",
      },
    },
  },
});
