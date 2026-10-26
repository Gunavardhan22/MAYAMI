import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import manifest from "./manifest.config.ts";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
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
});
