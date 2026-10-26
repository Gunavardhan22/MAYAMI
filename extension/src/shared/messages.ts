import type { Settings } from "./settings";

export type Speaker = "interviewer" | "candidate";
export type AgentName = "answer" | "technical" | "design" | "research";
export type Layout = "text" | "code" | "diagram";

export interface CodeRun {
  code: string;
  output: string;
  ok: boolean;
}

export interface Source {
  title: string;
  url: string;
}

/** Events the backend sends over the WebSocket (JSON text frames). */
export type ServerEvent =
  | { type: "ready" }
  | { type: "transcript_partial"; speaker: Speaker; payload: string }
  | { type: "transcript_final"; speaker: Speaker; payload: string }
  | { type: "question"; id: number; payload: string; agent: AgentName }
  | { type: "answer_chunk"; id: number; payload: string }
  | { type: "answer_reset"; id: number; agent?: AgentName }
  | { type: "status"; id: number; payload: string }
  | { type: "ui"; id: number; layout: Layout }
  | ({ type: "code_run"; id: number } & CodeRun)
  | { type: "sources"; id: number; sources: Source[] }
  | { type: "answer_done"; id: number }
  | { type: "coach"; key: string; level: "info" | "warn"; payload: string; ttl_ms: number }
  | { type: "error"; payload: string };

export type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

export interface SystemState {
  active: boolean;
  tabId: number | null;
  connection: ConnectionStatus;
  /** Microphone is being captured and streamed. */
  micHot: boolean;
  /** Tab audio (the interviewer) is being captured. */
  capturing: boolean;
  detail?: string;
}

export const IDLE_STATE: SystemState = {
  active: false,
  tabId: null,
  connection: "idle",
  micHot: false,
  capturing: false,
};

export type ToBackground = { target: "background" } & (
  | { type: "start"; tabId: number; streamId: string }
  | { type: "stop" }
  | { type: "get-state" }
  | { type: "server-event"; event: ServerEvent }
  | { type: "system"; patch: Partial<SystemState> }
);

export type ToOffscreen = { target: "offscreen" } & (
  | { type: "start"; streamId: string; settings: Settings }
  | { type: "stop" }
  | { type: "ask"; text: string }
  | { type: "set-mic"; enabled: boolean }
);

export type ToOverlay = { target: "overlay" } & (
  | { type: "event"; event: ServerEvent }
  | { type: "system"; state: SystemState }
);

export type ToPopup = { target: "popup"; type: "state"; state: SystemState };

/** Reply to get-state: the session plus whether the asking tab is the captured one. */
export interface StateReply {
  state: SystemState;
  isSessionTab: boolean;
}

export function send(message: ToBackground | ToOffscreen): Promise<unknown> {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}
