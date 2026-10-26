// Zustand stores. Components subscribe to narrow slices, so a burst of transcript or
// answer chunks only re-renders the component that shows them, not the whole overlay.
import { create } from "zustand";
import {
  IDLE_STATE,
  type AgentName,
  type CodeRun,
  type Layout,
  type Source,
  type Speaker,
  type SystemState,
} from "../shared/messages";

const MAX_PILLS = 60;
const MAX_ANSWERS = 20;

export interface Pill {
  id: number;
  speaker: Speaker;
  text: string;
}

interface TranscriptionState {
  pills: Pill[];
  /** In-progress text per speaker; both people can be mid-sentence at once. */
  partials: Record<Speaker, string | null>;
  setPartial: (speaker: Speaker, text: string) => void;
  addFinal: (speaker: Speaker, text: string) => void;
  reset: () => void;
}

let pillId = 0;
const NO_PARTIALS: Record<Speaker, string | null> = { interviewer: null, candidate: null };

export const useTranscriptionStore = create<TranscriptionState>((set) => ({
  pills: [],
  partials: NO_PARTIALS,
  setPartial: (speaker, text) => set((s) => ({ partials: { ...s.partials, [speaker]: text } })),
  addFinal: (speaker, text) =>
    set((s) => ({
      pills: [...s.pills, { id: ++pillId, speaker, text }].slice(-MAX_PILLS),
      partials: { ...s.partials, [speaker]: null },
    })),
  reset: () => set({ pills: [], partials: NO_PARTIALS }),
}));

export interface QA {
  id: number;
  question: string;
  agent: AgentName;
  /** Raw markdown as streamed: a one-line summary, a blank line, then details. */
  answer: string;
  done: boolean;
  /** What the agent is doing right now, e.g. "Running tests in the sandbox...". */
  status: string | null;
  /** Layout the agent asked for; the answer window resizes to fit it. */
  layout: Layout;
  codeRuns: CodeRun[];
  sources: Source[];
}

/** Split an answer into its headline (first line) and the detailed bullets below it.
 *  The model doesn't always leave a blank line after the headline, so split on the first
 *  line break; a first line that is itself a bullet or code means there is no headline. */
export function splitAnswer(answer: string): { summary: string; details: string } {
  const trimmed = answer.replace(/^\s+/, "");
  const nl = trimmed.indexOf("\n");
  const first = nl === -1 ? trimmed : trimmed.slice(0, nl);
  if (/^\s*([-*•]|\d+\.|```)/.test(first)) return { summary: "", details: trimmed };
  return { summary: first.replace(/\*\*/g, "").trim(), details: nl === -1 ? "" : trimmed.slice(nl + 1).trim() };
}

interface QAState {
  items: QA[];
  activeId: number | null;
  /** True while the user is viewing the newest answer; new questions then take focus. */
  followLatest: boolean;
  startQuestion: (id: number, question: string, agent: AgentName) => void;
  /** Apply a change to one answer; unknown ids are ignored. */
  update: (id: number, change: (q: QA) => Partial<QA>) => void;
  step: (delta: -1 | 1) => void;
  reset: () => void;
}

export const useQAStore = create<QAState>((set) => ({
  items: [],
  activeId: null,
  followLatest: true,
  startQuestion: (id, question, agent) =>
    set((s) => {
      const item: QA = { id, question, agent, answer: "", done: false, status: null, layout: "text", codeRuns: [], sources: [] };
      const items = [...s.items, item].slice(-MAX_ANSWERS);
      return { items, activeId: s.followLatest || s.activeId == null ? id : s.activeId };
    }),
  update: (id, change) => set((s) => ({ items: s.items.map((q) => (q.id === id ? { ...q, ...change(q) } : q)) })),
  step: (delta) =>
    set((s) => {
      const idx = s.items.findIndex((q) => q.id === s.activeId);
      const next = Math.max(0, Math.min(s.items.length - 1, idx + delta));
      return { activeId: s.items[next]?.id ?? null, followLatest: next === s.items.length - 1 };
    }),
  reset: () => set({ items: [], activeId: null, followLatest: true }),
}));

export interface CoachAlert {
  key: string;
  level: "info" | "warn";
  message: string;
}

interface CoachState {
  alerts: CoachAlert[];
  push: (alert: CoachAlert, ttlMs: number) => void;
  dismiss: (key: string) => void;
}

const coachTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useCoachStore = create<CoachState>((set, get) => ({
  alerts: [],
  push: (alert, ttlMs) => {
    // One alert per kind: a repeat replaces the old one and restarts its timer.
    set((s) => ({ alerts: [...s.alerts.filter((a) => a.key !== alert.key), alert] }));
    clearTimeout(coachTimers.get(alert.key));
    coachTimers.set(alert.key, setTimeout(() => get().dismiss(alert.key), ttlMs));
  },
  dismiss: (key) => {
    clearTimeout(coachTimers.get(key));
    coachTimers.delete(key);
    set((s) => ({ alerts: s.alerts.filter((a) => a.key !== key) }));
  },
}));

interface SystemStore extends SystemState {
  lastError: string | null;
  apply: (state: SystemState) => void;
  setError: (message: string | null) => void;
}

export const useSystemStore = create<SystemStore>((set) => ({
  ...IDLE_STATE,
  lastError: null,
  apply: (state) => set({ ...IDLE_STATE, ...state }),
  setError: (lastError) => set({ lastError }),
}));
