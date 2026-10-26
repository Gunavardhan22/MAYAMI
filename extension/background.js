// Service worker: owns session state, the offscreen document, and relays messages
// between the offscreen document (audio + WebSocket) and the overlay in the captured tab.
import { loadSettings } from "./settings.js";

const OFFSCREEN_URL = "offscreen.html";

async function getState() {
  const { session } = await chrome.storage.session.get("session");
  return session ?? { active: false, tabId: null, status: "idle" };
}

async function setState(patch) {
  const session = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ session });
  chrome.runtime.sendMessage({ target: "popup", type: "state", session }).catch(() => {});
  return session;
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Capture tab and microphone audio and stream it for transcription.",
  });
}

async function closeOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) await chrome.offscreen.closeDocument();
}

function toTab(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { target: "overlay", ...message }).catch(() => {});
}

async function start(tabId, streamId) {
  const settings = await loadSettings();
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await ensureOffscreen();
  await setState({ active: true, tabId, status: "connecting" });
  toTab(tabId, { type: "status", status: "connecting" });
  chrome.runtime.sendMessage({ target: "offscreen", type: "start", streamId, settings }).catch(() => {});
}

async function stop() {
  const { tabId } = await getState();
  chrome.runtime.sendMessage({ target: "offscreen", type: "stop" }).catch(() => {});
  // Give the offscreen document a moment to close the socket cleanly.
  setTimeout(closeOffscreen, 500);
  toTab(tabId, { type: "status", status: "stopped" });
  await setState({ active: false, status: "idle" });
}

async function onConnection(status, detail) {
  const { tabId } = await getState();
  toTab(tabId, { type: "status", status, detail });
  if (status === "closed" || status === "error") {
    await setState({ active: false, status });
    setTimeout(closeOffscreen, 500);
  } else {
    await setState({ status });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "background") return;
  (async () => {
    switch (msg.type) {
      case "start":
        await start(msg.tabId, msg.streamId);
        break;
      case "stop":
        await stop();
        break;
      case "get-state":
        return getState();
      case "ask": // overlay -> offscreen
        chrome.runtime.sendMessage({ target: "offscreen", type: "ask", text: msg.text }).catch(() => {});
        break;
      case "server-event": // offscreen -> overlay
        toTab((await getState()).tabId, { type: "event", event: msg.event });
        break;
      case "connection":
        await onConnection(msg.status, msg.detail);
        break;
    }
    return { ok: true };
  })()
    .then(sendResponse)
    .catch((err) => {
      console.error(err);
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    });
  return true; // async response
});

// Stop if the captured tab goes away.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.active && state.tabId === tabId) await stop();
});
