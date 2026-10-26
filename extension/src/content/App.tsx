import { AnimatePresence, motion } from "framer-motion";
import { CoachToasts } from "./components/CoachToasts";
import { ControlPanel } from "./components/ControlPanel";
import { QADisplay } from "./components/QADisplay";
import { TranscriptStream } from "./components/TranscriptStream";
import { useSystemStore } from "./stores";
import { useMayamiSocket } from "./useMayamiSocket";

const fade = {
  initial: { opacity: 0, y: -8, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -8, scale: 0.98 },
  transition: { duration: 0.18, ease: "easeOut" },
} as const;

interface Props {
  /** Called once the exit animation finishes after the session ends. */
  onExited: () => void;
}

export function App({ onExited }: Props) {
  const active = useSystemStore((s) => s.active);
  const { ask, setMic, end } = useMayamiSocket();

  return (
    <AnimatePresence onExitComplete={onExited}>
      {active && (
        // Full-screen layer that lets clicks through to the meeting; only the panels take input.
        <motion.div key="overlay" className="pointer-events-none fixed inset-0" {...fade}>
          <ControlPanel onToggleMic={setMic} onEnd={end} />
          <TranscriptStream />
          <QADisplay onAsk={ask} />
          {/* Last, so coaching alerts float above the answer window when it grows. */}
          <CoachToasts />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
