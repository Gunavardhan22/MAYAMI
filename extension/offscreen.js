// Offscreen document: captures tab + mic audio, encodes it with MediaRecorder (WebM/Opus),
// and streams it to the backend over a single WebSocket. Each binary frame is prefixed with
// a one-byte channel id: 0 = interviewer (tab audio), 1 = candidate (microphone).
const CHUNK_MS = 250;
const MIME = "audio/webm;codecs=opus";

let ws = null;
let audioCtx = null;
let streams = [];
let recorders = [];

function notify(type, payload) {
  chrome.runtime.sendMessage({ target: "background", type, ...payload }).catch(() => {});
}

function record(stream, channel) {
  const recorder = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: 32000 });
  let queue = Promise.resolve(); // keep chunks in order while blobs are read
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    queue = queue.then(async () => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      const body = new Uint8Array(await e.data.arrayBuffer());
      const frame = new Uint8Array(body.length + 1);
      frame[0] = channel;
      frame.set(body, 1);
      ws.send(frame);
    });
  };
  recorder.start(CHUNK_MS);
  recorders.push(recorder);
}

async function start(streamId, settings) {
  stop();
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
  });
  streams.push(tabStream);

  // Capturing a tab mutes it for the user; route the audio back to the speakers.
  audioCtx = new AudioContext();
  audioCtx.createMediaStreamSource(tabStream).connect(audioCtx.destination);

  let micStream = null;
  if (settings.captureMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streams.push(micStream);
    } catch {
      // Mic permission must be granted once from the options page.
      notify("server-event", {
        event: {
          type: "error",
          message: "Microphone unavailable - grant it in MAYAMI options. Continuing with tab audio only.",
        },
      });
    }
  }

  const url = new URL(settings.serverUrl.replace(/\/+$/, "") + "/ws");
  url.searchParams.set("profile", settings.profileId);
  if (settings.apiKey) url.searchParams.set("token", settings.apiKey);

  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    notify("connection", { status: "live" });
    record(tabStream, 0);
    if (micStream) record(micStream, 1);
  };
  ws.onmessage = (e) => {
    try {
      notify("server-event", { event: JSON.parse(e.data) });
    } catch {}
  };
  ws.onerror = () => notify("connection", { status: "error", detail: "Could not reach the MAYAMI server." });
  ws.onclose = (e) => {
    stopMedia();
    notify("connection", { status: "closed", detail: e.reason || undefined });
  };
}

function stopMedia() {
  recorders.forEach((r) => r.state !== "inactive" && r.stop());
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  audioCtx?.close();
  recorders = [];
  streams = [];
  audioCtx = null;
}

function stop() {
  stopMedia();
  if (ws) {
    ws.onclose = ws.onerror = null;
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  }
  ws = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "start") {
    start(msg.streamId, msg.settings).catch((err) =>
      notify("connection", { status: "error", detail: String(err?.message ?? err) }),
    );
  } else if (msg.type === "stop") {
    stop();
  } else if (msg.type === "ask" && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ask", text: msg.text }));
  }
});
