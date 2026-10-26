import { Mic, MicOff, PhoneOff } from "lucide-react";
import { Rnd } from "react-rnd";
import type { ConnectionStatus } from "../../shared/messages";
import { useSystemStore } from "../stores";

const STATUS: Record<ConnectionStatus, { label: string; dot: string }> = {
  idle: { label: "Idle", dot: "bg-zinc-500" },
  connecting: { label: "Connecting", dot: "bg-amber-400 animate-pulse" },
  connected: { label: "Live", dot: "bg-emerald-400" },
  reconnecting: { label: "Reconnecting", dot: "bg-amber-400 animate-pulse" },
  disconnected: { label: "Offline", dot: "bg-zinc-500" },
  error: { label: "Error", dot: "bg-rose-500" },
};

interface Props {
  onToggleMic: (enabled: boolean) => void;
  onEnd: () => void;
}

export function ControlPanel({ onToggleMic, onEnd }: Props) {
  const connection = useSystemStore((s) => s.connection);
  const micHot = useSystemStore((s) => s.micHot);
  const capturing = useSystemStore((s) => s.capturing);
  const status = STATUS[connection];

  return (
    <Rnd
      default={{ x: Math.max(16, window.innerWidth / 2 - 170), y: 16, width: "auto", height: "auto" }}
      enableResizing={false}
      bounds="parent"
      cancel="button"
      className="pointer-events-auto"
    >
      <div className="flex cursor-grab select-none items-center gap-3 rounded-full border border-edge bg-glass py-1.5 pl-4 pr-1.5 shadow-2xl backdrop-blur-md active:cursor-grabbing">
        <span className="text-[13px] font-semibold tracking-wide text-white">MAYAMI</span>

        <span className="flex items-center gap-1.5 text-xs text-zinc-400">
          <span className={`h-2 w-2 rounded-full ${status.dot}`} />
          {status.label}
        </span>

        <span
          title={capturing ? "Capturing tab audio" : "Not capturing"}
          className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-400"
        >
          <span className={`h-2 w-2 rounded-full ${capturing ? "animate-pulse bg-rose-500" : "bg-zinc-600"}`} />
          Rec
        </span>

        <button
          type="button"
          onClick={() => onToggleMic(!micHot)}
          title={micHot ? "Stop sending your microphone" : "Send your microphone"}
          className={`grid h-8 w-8 place-items-center rounded-full transition-colors ${
            micHot ? "bg-white/10 text-white hover:bg-white/20" : "bg-transparent text-zinc-500 hover:bg-white/10"
          }`}
        >
          {micHot ? <Mic size={15} /> : <MicOff size={15} />}
        </button>

        <button
          type="button"
          onClick={onEnd}
          title="End session"
          className="flex h-8 items-center gap-1.5 rounded-full bg-rose-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-rose-500"
        >
          <PhoneOff size={14} />
          End
        </button>
      </div>
    </Rnd>
  );
}
