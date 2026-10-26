const toggle = document.getElementById("toggle");
const statusEl = document.getElementById("status");

const LABELS = {
  idle: "Idle",
  connecting: "Connecting...",
  live: "Listening on captured tab",
  closed: "Disconnected",
  error: "Connection error",
};

function render(session) {
  statusEl.textContent = LABELS[session.status] ?? session.status;
  toggle.textContent = session.active ? "Stop" : "Start on this tab";
  toggle.classList.toggle("stop", session.active);
}

async function refresh() {
  render(await chrome.runtime.sendMessage({ target: "background", type: "get-state" }));
}

toggle.addEventListener("click", async () => {
  const session = await chrome.runtime.sendMessage({ target: "background", type: "get-state" });
  if (session.active) {
    await chrome.runtime.sendMessage({ target: "background", type: "stop" });
    return refresh();
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    // Must be called from the popup (a user gesture on this tab) to be allowed.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await chrome.runtime.sendMessage({ target: "background", type: "start", tabId: tab.id, streamId });
    if (res && !res.ok) throw new Error(res.error);
  } catch (err) {
    statusEl.textContent = `Could not start: ${err.message ?? err}`;
    return;
  }
  refresh();
});

document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target === "popup" && msg.type === "state") render(msg.session);
});

refresh();
