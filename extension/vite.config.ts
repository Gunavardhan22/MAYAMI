import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import manifest from "./manifest.config.ts";

export default defineConfig(({ mode }) => {
  // Pre-fill the extension's settings from the backend's .env, so a local build connects
  // without copying the key into the options page by hand.
  const backend = loadEnv(mode, "../backend", "MAYAMI_");

  return {
    plugins: [react(), crx({ manifest })],
    define: {
      __MAYAMI_DEFAULT_SERVER_URL__: JSON.stringify(backend.MAYAMI_SERVER_URL || "ws://localhost:8000"),
      __MAYAMI_DEFAULT_API_KEY__: JSON.stringify(backend.MAYAMI_API_KEY ?? ""),
    },
    build: {
      rollupOptions: {
        // The offscreen document isn't referenced by the manifest, so add it explicitly.
        input: { offscreen: "src/offscreen/offscreen.html" },
      },
      // The content bundle carries React, markdown, motion and drag libraries; it is loaded
      // from the extension package, not the network, so its size doesn't affect latency.
      chunkSizeWarningLimit: 800,
    },
    server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
  };
});
