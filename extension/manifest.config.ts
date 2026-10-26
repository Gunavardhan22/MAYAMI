import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };
import { MEETING_MATCHES } from "./src/shared/meetings.ts";

export default defineManifest({
  manifest_version: 3,
  name: "MAYAMI",
  version: pkg.version,
  description: "Real-time, resume-grounded answer suggestions during browser-based interviews.",
  minimum_chrome_version: "116",
  permissions: ["tabCapture", "offscreen", "storage", "activeTab"],
  background: { service_worker: "src/background/index.ts", type: "module" },
  action: { default_popup: "src/popup/popup.html", default_title: "MAYAMI" },
  options_page: "src/options/options.html",
  content_scripts: [{ matches: MEETING_MATCHES, js: ["src/content/index.tsx"], run_at: "document_idle" }],
});
