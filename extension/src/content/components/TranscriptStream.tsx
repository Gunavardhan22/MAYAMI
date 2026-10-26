import { useEffect, useRef } from "react";
import { Rnd } from "react-rnd";
import { useTranscriptionStore } from "../stores";
import { TranscriptPill } from "./TranscriptPill";

export function TranscriptStream() {
  const pills = useTranscriptionStore((s) => s.pills);
  const partials = useTranscriptionStore((s) => s.partials);
  const scroller = useRef<HTMLDivElement>(null);
  const live = (["interviewer", "candidate"] as const).filter((sp) => partials[sp]);

  // Keep the newest words in view: scroll to the right edge whenever content grows.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [pills, partials]);

  return (
    <Rnd
      default={{ x: Math.max(16, window.innerWidth / 2 - 320), y: 72, width: 640, height: 52 }}
      minWidth={280}
      enableResizing={{ left: true, right: true }}
      bounds="parent"
      className="pointer-events-auto"
    >
      <div className="flex h-full cursor-grab items-center rounded-2xl border border-edge bg-glass px-2 shadow-2xl backdrop-blur-md active:cursor-grabbing">
        <div ref={scroller} className="mayami-scroll-x flex w-full items-center gap-1.5 overflow-x-auto py-1">
          {pills.length === 0 && live.length === 0 && (
            <span className="px-2 text-xs text-zinc-500">Waiting for the conversation to start...</span>
          )}
          {pills.map((p) => (
            <TranscriptPill key={p.id} text={p.text} speaker={p.speaker} />
          ))}
          {live.map((sp) => (
            <TranscriptPill key={`live-${sp}`} text={partials[sp]!} speaker={sp} live />
          ))}
        </div>
      </div>
    </Rnd>
  );
}
