// Offscreen document: captures tab + mic audio, downsamples it to 16 kHz mono int16 PCM in an
// AudioWorklet, and streams it to the backend over one WebSocket. Each binary frame is
// prefixed with a one-byte channel id: 0 = interviewer (tab audio), 1 = candidate (mic).
// The socket reconnects with exponential backoff; audio captured while it is down is dropped.
import type { ServerEvent, SystemState, ToOffscreen } from "../shared/messages";
import type { Settings } from "../shared/settings";

const PCM_RATE = 16000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15000;
// Close codes the server uses for bad credentials or profile: retrying won't help.
const FATAL_CLOSE_CODES = new Set([1008]);

const Channel = { interviewer: 0, candidate: 1 } as const;

let settings: Settings | null = null;
let ws: WebSocket | null = null;
let stopped = true;
let attempt = 0;
let retryTimer: number | undefined;

let playbackCtx: AudioContext | null = null; // plays the captured tab back to the user
let pcmCtx: AudioContext | null = null; // 16 kHz context feeding the worklets
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let micNodes: AudioNode[] = [];

function report(patch: Partial<SystemState>) {
  chrome.runtime.sendMessage({ target: "background", type: "system", patch }).catch(() => {});
}

function relay(event: ServerEvent) {
  chrome.runtime.sendMessage({ target: "background", type: "server-event", event }).catch(() => {});
}

/** Connect a stream to a PCM worklet that sends frames for `channel`. Returns the nodes. */
function pipe(stream: MediaStream, channel: number): AudioNode[] {
  const ctx = pcmCtx!;
  const source = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, "pcm-chunker");
  worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const pcm = new Uint8Array(e.data);
    const frame = new Uint8Array(pcm.length + 1);
    frame[0] = channel;
    frame.set(pcm, 1);
    ws.send(frame);
  };
  // A muted path to the destination keeps the worklet being pulled by the audio graph.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(worklet).connect(mute).connect(ctx.destination);
  return [source, worklet, mute];
}

async function setMic(enabled: boolean) {
  if (enabled && !micStream) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      micNodes = pipe(micStream, Channel.candidate);
    } catch {
      relay({ type: "error", payload: "Microphone unavailable. Grant it once on the MAYAMI options page." });
      micStream = null;
    }
  } else if (!enabled && micStream) {
    micNodes.forEach((n) => n.disconnect());
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
    micNodes = [];
  }
  report({ micHot: micStream !== null });
}

function connect() {
  if (stopped || !settings) return;
  const url = new URL(settings.serverUrl.replace(/\/+$/, "") + "/ws");
  url.searchParams.set("profile", settings.profileId);
  if (settings.apiKey) url.searchParams.set("token", settings.apiKey);

  report({ connection: attempt === 0 ? "connecting" : "reconnecting" });
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  ws = socket;

  socket.onopen = () => {
    attempt = 0;
    report({ connection: "connected", detail: undefined });
  };
  socket.onmessage = (e) => {
    try {
      relay(JSON.parse(e.data as string) as ServerEvent);
    } catch {
      /* ignore malformed frames */
    }
  };
  socket.onclose = (e) => {
    if (ws !== socket || stopped) return;
    ws = null;
    if (FATAL_CLOSE_CODES.has(e.code)) {
      report({ connection: "error", detail: e.reason || "Server rejected the connection (check API key / profile)." });
      return;
    }
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt) * (0.75 + Math.random() * 0.5);
    attempt++;
    report({ connection: "reconnecting", detail: `Reconnecting in ${Math.round(delay / 1000)}s...` });
    retryTimer = self.setTimeout(connect, delay);
  };
}

async function start(streamId: string, s: Settings) {
  stop();
  stopped = false;
  settings = s;
  attempt = 0;

  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } as MediaTrackConstraints,
  });
  // Capture ends if the tab navigates away or is closed; without this the session would
  // look live while hearing nothing.
  tabStream.getAudioTracks()[0]?.addEventListener("ended", () => {
    if (stopped) return;
    stop();
    report({ connection: "error", capturing: false, micHot: false, detail: "Tab audio capture ended. Start again on the meeting tab." });
  });
  // Capturing a tab mutes it for the user; route the audio back to the speakers.
  playbackCtx = new AudioContext();
  playbackCtx.createMediaStreamSource(tabStream).connect(playbackCtx.destination);

  pcmCtx = new AudioContext({ sampleRate: PCM_RATE });
  await pcmCtx.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
  pipe(tabStream, Channel.interviewer);
  report({ capturing: true });

  if (s.captureMic) await setMic(true);
  connect();
}

function stop() {
  stopped = true;
  clearTimeout(retryTimer);
  if (ws) {
    const socket = ws;
    ws = null;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
    socket.close();
  }
  micStream?.getTracks().forEach((t) => t.stop());
  tabStream?.getTracks().forEach((t) => t.stop());
  playbackCtx?.close();
  pcmCtx?.close();
  micStream = tabStream = null;
  playbackCtx = pcmCtx = null;
  micNodes = [];
}

chrome.runtime.onMessage.addListener((msg: ToOffscreen) => {
  if (msg.target !== "offscreen") return;
  switch (msg.type) {
    case "start":
      start(msg.streamId, msg.settings).catch((err) => {
        stop();
        report({ connection: "error", capturing: false, detail: String(err?.message ?? err) });
      });
      break;
    case "stop":
      stop();
      break;
    case "ask":
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ask", text: msg.text }));
      break;
    case "set-mic":
      if (!stopped) setMic(msg.enabled);
      break;
  }
});
