// Content script entry (meeting sites only). Mounts the React overlay inside a closed
// Shadow DOM so the meeting page's CSS can't reach it and Tailwind can't leak out.
// The overlay is mounted while a session is active on this tab and torn down when it ends.
import { createRoot, type Root } from "react-dom/client";
import { send, type StateReply, type SystemState, type ToOverlay } from "../shared/messages";
import { App } from "./App";
import { useQAStore, useSystemStore, useTranscriptionStore } from "./stores";
import css from "./styles.css?inline";

let mounted: { root: Root; host: HTMLElement } | null = null;

function mount() {
  if (mounted) return;
  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = css;
  const container = document.createElement("div");
  container.className = "mayami-root";
  shadow.append(style, container);

  // Keep typing in the overlay from triggering the meeting's keyboard shortcuts.
  for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => e.stopPropagation());

  document.documentElement.appendChild(host);
  const root = createRoot(container);
  root.render(<App onExited={unmount} />);
  mounted = { root, host };
}

function unmount() {
  if (!mounted || useSystemStore.getState().active) return;
  mounted.root.unmount();
  mounted.host.remove();
  mounted = null;
  // However the session ended (End button, popup, closed tab), start the next one clean.
  useTranscriptionStore.getState().reset();
  useQAStore.getState().reset();
}

function sync(state: SystemState) {
  useSystemStore.getState().apply(state);
  if (state.active) mount();
}

// The service worker only messages the captured tab, so any active state here is ours.
chrome.runtime.onMessage.addListener((msg: ToOverlay) => {
  if (msg.target === "overlay" && msg.type === "system") sync(msg.state);
});

send({ target: "background", type: "get-state" }).then((reply) => {
  const r = reply as StateReply | undefined;
  if (r?.isSessionTab) sync(r.state);
});
