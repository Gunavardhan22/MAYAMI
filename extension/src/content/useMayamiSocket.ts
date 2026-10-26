// Connection hook for the overlay. The WebSocket itself lives in the offscreen document
// (that's where the captured tab audio is, and it keeps the socket out of the meeting
// page's CSP); this hook owns the overlay's side of the lifecycle: it syncs state on mount,
// feeds server events into the stores, and exposes the session controls.
import { useCallback, useEffect } from "react";
import { IDLE_STATE, send, type ServerEvent, type StateReply, type ToOverlay } from "../shared/messages";
import { useCoachStore, useQAStore, useSystemStore, useTranscriptionStore } from "./stores";

let errorTimer: ReturnType<typeof setTimeout> | undefined;

function dispatch(event: ServerEvent) {
  // getState() writes don't re-render this hook's component; only subscribers re-render.
  const transcript = useTranscriptionStore.getState();
  const qa = useQAStore.getState();
  switch (event.type) {
    case "transcript_partial":
      transcript.setPartial(event.speaker, event.payload);
      break;
    case "transcript_final":
      transcript.addFinal(event.speaker, event.payload);
      break;
    case "question":
      qa.startQuestion(event.id, event.payload, event.agent);
      break;
    case "answer_chunk":
      qa.update(event.id, (q) => ({ answer: q.answer + event.payload }));
      break;
    case "answer_reset":
      // The router handed this question to a specialist; drop the general draft.
      qa.update(event.id, (q) => ({
        answer: "",
        done: false,
        status: null,
        codeRuns: [],
        sources: [],
        agent: event.agent ?? q.agent,
      }));
      break;
    case "status":
      qa.update(event.id, () => ({ status: event.payload }));
      break;
    case "ui":
      qa.update(event.id, () => ({ layout: event.layout }));
      break;
    case "code_run":
      qa.update(event.id, (q) => ({ codeRuns: [...q.codeRuns, { code: event.code, output: event.output, ok: event.ok }] }));
      break;
    case "sources":
      qa.update(event.id, (q) => ({ sources: [...q.sources, ...event.sources] }));
      break;
    case "answer_done":
      qa.update(event.id, () => ({ done: true, status: null }));
      break;
    case "coach":
      useCoachStore.getState().push({ key: event.key, level: event.level, message: event.payload }, event.ttl_ms);
      break;
    case "error":
      showError(event.payload);
      break;
  }
}

function showError(message: string) {
  useSystemStore.getState().setError(message);
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => useSystemStore.getState().setError(null), 8000);
}

export function useMayamiSocket() {
  useEffect(() => {
    const listener = (msg: ToOverlay) => {
      if (msg.target !== "overlay") return;
      if (msg.type === "event") dispatch(msg.event);
      else if (msg.type === "system") {
        useSystemStore.getState().apply(msg.state);
        if (msg.state.detail && msg.state.connection === "error") showError(msg.state.detail);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    send({ target: "background", type: "get-state" }).then((reply) => {
      if (reply) useSystemStore.getState().apply((reply as StateReply).state);
    });
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const ask = useCallback((text: string) => send({ target: "offscreen", type: "ask", text }), []);
  const setMic = useCallback((enabled: boolean) => send({ target: "offscreen", type: "set-mic", enabled }), []);
  const end = useCallback(() => {
    send({ target: "background", type: "stop" });
    // Hide immediately rather than waiting for the worker's state broadcast; the exit
    // animation then unmounts the React root.
    useSystemStore.getState().apply(IDLE_STATE);
    useTranscriptionStore.getState().reset();
    useQAStore.getState().reset();
  }, []);

  return { ask, setMic, end };
}
