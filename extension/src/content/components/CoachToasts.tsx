import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Info, X } from "lucide-react";
import { useCoachStore } from "../stores";

/** Floating delivery alerts from the Coach agent, stacked under the control bar. */
export function CoachToasts() {
  const alerts = useCoachStore((s) => s.alerts);
  const dismiss = useCoachStore((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed left-1/2 top-[136px] flex -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {alerts.map((a) => (
          <motion.div
            key={a.key}
            layout
            initial={{ opacity: 0, y: -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className={`pointer-events-auto flex items-center gap-2.5 rounded-full border py-2 pl-3.5 pr-2 text-[13px] font-medium shadow-2xl backdrop-blur-md ${
              a.level === "warn"
                ? "border-amber-400/40 bg-amber-500/90 text-black"
                : "border-sky-400/30 bg-sky-500/85 text-white"
            }`}
          >
            {a.level === "warn" ? <AlertTriangle size={15} /> : <Info size={15} />}
            {a.message}
            <button
              type="button"
              title="Dismiss"
              onClick={() => dismiss(a.key)}
              className="grid h-5 w-5 place-items-center rounded-full hover:bg-black/15"
            >
              <X size={12} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
