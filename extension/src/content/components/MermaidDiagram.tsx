import { Minus, Plus, RotateCcw } from "lucide-react";
import { memo, useEffect, useId, useState } from "react";

type MermaidApi = typeof import("mermaid").default;
let loader: Promise<MermaidApi> | null = null;

// Mermaid is large, so it's only loaded the first time a diagram appears.
function loadMermaid(): Promise<MermaidApi> {
  loader ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      themeVariables: { fontSize: "13px", primaryColor: "#1e293b", lineColor: "#7dd3fc" },
      flowchart: { curve: "basis", padding: 12 },
    });
    return mermaid;
  });
  return loader;
}

interface Props {
  chart: string;
}

/** Renders a Mermaid chart that may still be streaming in: it only re-renders once the
 *  text parses, so a half-written diagram keeps showing the last good version. */
export const MermaidDiagram = memo(function MermaidDiagram({ chart }: Props) {
  const id = `mayami-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const mermaid = await loadMermaid();
      if (!(await mermaid.parse(chart, { suppressErrors: true }))) {
        if (!cancelled) setFailed(true);
        return;
      }
      try {
        const { svg } = await mermaid.render(id, chart);
        if (!cancelled) {
          setSvg(svg);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }, 150); // let a burst of streamed chunks settle first
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chart, id]);

  if (!svg) {
    return (
      <div className="mb-3 grid h-40 place-items-center rounded-xl border border-dashed border-edge text-xs text-zinc-500">
        {failed ? "Drawing the diagram..." : "Loading diagram..."}
      </div>
    );
  }

  return (
    <div className="relative mb-3 rounded-xl border border-edge bg-black/30">
      <div className="absolute right-1.5 top-1.5 z-10 flex gap-0.5 rounded-lg bg-black/60 p-0.5 text-zinc-300">
        <ZoomButton title="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
          <Minus size={13} />
        </ZoomButton>
        <ZoomButton title="Reset zoom" onClick={() => setZoom(1)}>
          <RotateCcw size={12} />
        </ZoomButton>
        <ZoomButton title="Zoom in" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
          <Plus size={13} />
        </ZoomButton>
      </div>
      <div className="mayami-scroll-x mayami-scroll-y max-h-[420px] overflow-auto p-3">
        <div
          className="mayami-diagram origin-top-left transition-transform"
          style={{ transform: `scale(${zoom})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
});

function ZoomButton({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button type="button" title={title} onClick={onClick} className="grid h-6 w-6 place-items-center rounded-md hover:bg-white/15">
      {children}
    </button>
  );
}
