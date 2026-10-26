import {
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  CornerDownLeft,
  Globe,
  MessageSquare,
  Network,
  ShieldCheck,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Markdown, { type Components } from "react-markdown";
import { Rnd } from "react-rnd";
import remarkGfm from "remark-gfm";
import type { AgentName, CodeRun, Layout, Source } from "../../shared/messages";
import { splitAnswer, useQAStore, useSystemStore } from "../stores";
import { MermaidDiagram } from "./MermaidDiagram";

const MARGIN = 24;
const SIZES: Record<Layout, { width: number; height: number }> = {
  text: { width: 420, height: 360 },
  code: { width: 560, height: 520 },
  diagram: { width: 660, height: 620 },
};

const AGENTS: Record<AgentName, { label: string; icon: LucideIcon; tone: string }> = {
  answer: { label: "Answer", icon: MessageSquare, tone: "text-zinc-300 bg-white/10" },
  technical: { label: "Technical", icon: Code2, tone: "text-emerald-200 bg-emerald-400/15" },
  design: { label: "Design", icon: Network, tone: "text-violet-200 bg-violet-400/15" },
  research: { label: "Research", icon: Globe, tone: "text-sky-200 bg-sky-400/15" },
};

type HastNode = { type: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HastNode[] };

const textOf = (node: HastNode | undefined): string =>
  node?.value ?? (node?.children ?? []).map(textOf).join("");

// Tailwind has no typography plugin here, so style the markdown elements directly.
const markdown: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  strong: ({ children }) => <strong className="font-semibold text-sky-300">{children}</strong>,
  em: ({ children }) => <em className="text-zinc-400">{children}</em>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-sky-300 underline">
      {children}
    </a>
  ),
  pre: ({ children, node }) => {
    // ```mermaid blocks become live diagrams instead of code.
    const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "code");
    const classes = code?.properties?.className;
    if (Array.isArray(classes) && classes.includes("language-mermaid")) {
      return <MermaidDiagram chart={textOf(code).trim()} />;
    }
    return (
      <pre className="mayami-scroll-x mb-2 overflow-x-auto rounded-lg bg-black/50 p-3 text-[12px] leading-relaxed last:mb-0">
        {children}
      </pre>
    );
  },
  code: ({ children, className }) => (
    <code className={`font-mono ${className ? "" : "rounded bg-white/10 px-1 py-0.5 text-[12px]"}`}>{children}</code>
  ),
};

interface Props {
  onAsk: (text: string) => void;
}

export function QADisplay({ onAsk }: Props) {
  const items = useQAStore((s) => s.items);
  const activeId = useQAStore((s) => s.activeId);
  const step = useQAStore((s) => s.step);
  const lastError = useSystemStore((s) => s.lastError);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const rnd = useRef<Rnd>(null);
  const sizedFor = useRef<string>("");

  const index = items.findIndex((q) => q.id === activeId);
  const active = index >= 0 ? items[index] : null;
  const { summary, details } = splitAnswer(active?.answer ?? "");

  // The agent picks the layout: grow the window for code or diagrams, once per answer, so
  // a size the user chose afterwards isn't overridden.
  useEffect(() => {
    if (!active || !rnd.current) return;
    const key = `${active.id}:${active.layout}`;
    if (sizedFor.current === key || active.layout === "text") return;
    sizedFor.current = key;
    const size = SIZES[active.layout];
    const width = Math.min(size.width, window.innerWidth - 2 * MARGIN);
    const height = Math.min(size.height, window.innerHeight - 140 - MARGIN);
    rnd.current.updateSize({ width, height });
    rnd.current.updatePosition({ x: Math.max(MARGIN, window.innerWidth - width - MARGIN), y: 140 });
  }, [active]);

  const copy = async () => {
    if (!active?.answer) return;
    await navigator.clipboard.writeText(active.answer);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onAsk(text);
    setDraft("");
  };

  const agent = active ? AGENTS[active.agent] : null;

  return (
    <Rnd
      ref={rnd}
      default={{
        x: Math.max(16, window.innerWidth - SIZES.text.width - MARGIN),
        y: 140,
        ...SIZES.text,
      }}
      minWidth={300}
      minHeight={180}
      bounds="parent"
      dragHandleClassName="mayami-drag"
      className="pointer-events-auto"
    >
      <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-edge bg-glass shadow-2xl backdrop-blur-md">
        <header className="mayami-drag flex cursor-grab items-start gap-2 border-b border-edge px-4 py-3 active:cursor-grabbing">
          <div className="flex-1">
            {agent && (
              <span className={`mb-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ${agent.tone}`}>
                <agent.icon size={11} />
                {agent.label} agent
              </span>
            )}
            <p className="text-[13px] font-semibold leading-snug text-white">
              {active ? active.question : "Listening for the next question..."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 text-zinc-400">
            <IconButton title="Previous" disabled={index <= 0} onClick={() => step(-1)}>
              <ChevronLeft size={15} />
            </IconButton>
            <span className="min-w-8 text-center text-[11px] tabular-nums">
              {items.length ? `${index + 1}/${items.length}` : ""}
            </span>
            <IconButton title="Next" disabled={index < 0 || index >= items.length - 1} onClick={() => step(1)}>
              <ChevronRight size={15} />
            </IconButton>
            <IconButton title="Copy answer" disabled={!active?.answer} onClick={copy}>
              {copied ? <Check size={15} className="text-emerald-400" /> : <Copy size={14} />}
            </IconButton>
          </div>
        </header>

        {active?.status && (
          <div className="flex items-center gap-2 border-b border-edge bg-white/[0.03] px-4 py-1.5 text-[11.5px] text-zinc-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
            {active.status}
          </div>
        )}

        <div className="mayami-scroll-y flex-1 overflow-y-auto px-4 py-3 text-[13.5px] leading-relaxed text-zinc-200">
          {active ? (
            <>
              {summary && <p className="mb-3 text-[14px] font-medium text-white">{summary}</p>}
              {details && (
                <Markdown remarkPlugins={[remarkGfm]} components={markdown}>
                  {details}
                </Markdown>
              )}
              {!active.done && !active.answer && !active.status && <span className="text-zinc-500">Thinking...</span>}
              {!active.done && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-sky-300/80 align-middle" />}
              {active.codeRuns.length > 0 && <CodeRuns runs={active.codeRuns} />}
              {active.sources.length > 0 && <Sources sources={active.sources} />}
            </>
          ) : (
            <p className="text-zinc-500">Answers appear here as soon as the interviewer finishes a question.</p>
          )}
          {lastError && <p className="mt-3 text-xs text-rose-300">{lastError}</p>}
        </div>

        <form onSubmit={submit} className="flex items-center gap-2 border-t border-edge px-3 py-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type a question to answer manually"
            className="flex-1 rounded-lg bg-white/5 px-3 py-1.5 text-[12.5px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:bg-white/10"
          />
          <IconButton title="Ask" type="submit" disabled={!draft.trim()}>
            <CornerDownLeft size={14} />
          </IconButton>
        </form>
      </div>
    </Rnd>
  );
}

function CodeRuns({ runs }: { runs: CodeRun[] }) {
  const last = runs[runs.length - 1];
  const Icon = last.ok ? ShieldCheck : ShieldAlert;
  return (
    <details className="mt-3 rounded-lg border border-edge bg-black/30 text-[12px]">
      <summary className={`flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 font-medium ${last.ok ? "text-emerald-300" : "text-amber-300"}`}>
        <Icon size={14} />
        {last.ok ? "Verified in sandbox" : "Last sandbox run failed"}
        <span className="font-normal text-zinc-500">
          &middot; {runs.length} run{runs.length > 1 ? "s" : ""}
        </span>
      </summary>
      <pre className="mayami-scroll-x max-h-40 overflow-auto border-t border-edge px-3 py-2 font-mono text-[11.5px] text-zinc-300">
        {last.output.trim() || "(no output)"}
      </pre>
    </details>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  return (
    <div className="mt-3 border-t border-edge pt-2">
      <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Sources</p>
      <ol className="list-decimal space-y-0.5 pl-5 text-[12px]">
        {sources.slice(0, 5).map((s) => (
          <li key={s.url}>
            <a href={s.url} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
              {s.title}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function IconButton({
  children,
  title,
  disabled,
  onClick,
  type = "button",
}: {
  children: React.ReactNode;
  title: string;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
