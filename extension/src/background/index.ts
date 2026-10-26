// Service worker: owns session state and the offscreen document, and relays messages
// from the offscreen document (audio + WebSocket) to the overlay in the captured tab.
// State lives in storage.session so it survives the worker being suspended.
import {
  IDLE_STATE,
  type StateReply,
  type SystemState,
  type ToBackground,
  type ToOverlay,
  type ToPopup,
} from "../shared/messages";
import { loadSettings } from "../shared/settings";

const OFFSCREEN_URL = "src/offscreen/offscreen.html";

async function getState(): Promise<SystemState> {
  const { session } = await chrome.storage.session.get("session");
  return (session as SystemState | undefined) ?? IDLE_STATE;
}

async function setState(patch: Partial<SystemState>): Promise<SystemState> {
  const state = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ session: state });
  toOverlay(state.tabId, { target: "overlay", type: "system", state });
  const popup: ToPopup = { target: "popup", type: "state", state };
  chrome.runtime.sendMessage(popup).catch(() => {});
  return state;
}

function toOverlay(tabId: number | null, message: ToOverlay) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Capture tab and microphone audio and stream it for transcription.",
  });
}

async function closeOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length) await chrome.offscreen.closeDocument();
}

async function start(tabId: number, streamId: string) {
  const settings = await loadSettings();
  await ensureOffscreen();
  await setState({ ...IDLE_STATE, active: true, tabId, connection: "connecting" });
  chrome.runtime.sendMessage({ target: "offscreen", type: "start", streamId, settings }).catch(() => {});
}

async function stop() {
  chrome.runtime.sendMessage({ target: "offscreen", type: "stop" }).catch(() => {});
  // Give the offscreen document a moment to close the socket cleanly.
  setTimeout(() => closeOffscreen().catch(() => {}), 500);
  await setState({ ...IDLE_STATE, tabId: (await getState()).tabId });
}

chrome.runtime.onMessage.addListener((msg: ToBackground, sender, sendResponse) => {
  if (msg.target !== "background") return;
  (async () => {
    switch (msg.type) {
      case "start":
        await start(msg.tabId, msg.streamId);
        return { ok: true };
      case "stop":
        await stop();
        return { ok: true };
      case "get-state": {
        const state = await getState();
        const reply: StateReply = { state, isSessionTab: sender.tab?.id != null && sender.tab.id === state.tabId };
        return reply;
      }
      case "server-event":
        toOverlay((await getState()).tabId, { target: "overlay", type: "event", event: msg.event });
        return { ok: true };
      case "system": {
        const state = await setState(msg.patch);
        if (msg.patch.connection === "error" && !state.capturing) {
          await stop();
          // Keep the reason so the popup can say why the session ended.
          await setState({ detail: state.detail });
        }
        return { ok: true };
      }
    }
  })()
    .then(sendResponse)
    .catch((err) => {
      console.error(err);
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    });
  return true; // async response
});

// End the session if the captured tab goes away.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.active && state.tabId === tabId) await stop();
});
