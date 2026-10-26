import { send, type ConnectionStatus, type StateReply, type SystemState, type ToPopup } from "../shared/messages";
import { isMeetingUrl } from "../shared/meetings";

const toggle = document.getElementById("toggle") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;

const LABELS: Record<ConnectionStatus, string> = {
  idle: "Idle",
  connecting: "Connecting...",
  connected: "Live on the captured tab",
  reconnecting: "Reconnecting...",
  disconnected: "Disconnected",
  error: "Connection error",
};

let activeTab: chrome.tabs.Tab | undefined;

function render(state: SystemState) {
  toggle.textContent = state.active ? "Stop" : "Start on this tab";
  toggle.classList.toggle("stop", state.active);
  if (!state.active && !isMeetingUrl(activeTab?.url)) {
    toggle.disabled = true;
    statusEl.textContent = "Open a Google Meet, Zoom or Teams tab to start.";
    return;
  }
  toggle.disabled = false;
  const showDetail = state.detail && (state.connection === "error" || !state.active);
  statusEl.textContent = showDetail ? state.detail! : LABELS[state.connection];
}

async function refresh() {
  const reply = (await send({ target: "background", type: "get-state" })) as StateReply | undefined;
  if (reply) render(reply.state);
}

toggle.addEventListener("click", async () => {
  const reply = (await send({ target: "background", type: "get-state" })) as StateReply | undefined;
  if (reply?.state.active) {
    await send({ target: "background", type: "stop" });
    return refresh();
  }
  if (activeTab?.id == null) return;
  try {
    // Must be called from the popup (a user gesture on this tab) to be allowed.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
    await send({ target: "background", type: "start", tabId: activeTab.id, streamId });
  } catch (err) {
    statusEl.textContent = `Could not start: ${(err as Error).message ?? err}`;
    return;
  }
  refresh();
});

document.getElementById("options")!.addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg: ToPopup) => {
  if (msg.target === "popup" && msg.type === "state") render(msg.state);
});

[activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
refresh();
