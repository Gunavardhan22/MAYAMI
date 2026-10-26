import { memo } from "react";
import type { Speaker } from "../../shared/messages";

interface Props {
  text: string;
  speaker: Speaker;
  live?: boolean;
}

export const TranscriptPill = memo(function TranscriptPill({ text, speaker, live = false }: Props) {
  const tone =
    speaker === "interviewer"
      ? "border-sky-400/25 bg-sky-400/10 text-sky-50"
      : "border-violet-400/25 bg-violet-400/10 text-violet-100";
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[12.5px] ${tone} ${
        live ? "border-dashed opacity-80" : ""
      }`}
    >
      <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wider opacity-60">
        {speaker === "interviewer" ? "Them" : "You"}
      </span>
      {text}
    </span>
  );
});
