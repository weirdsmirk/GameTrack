import React from "react";
import { motion, useReducedMotion } from "motion/react";
import { Terminal } from "lucide-react";

/**
 * Closing brand statement for the app shell.
 *
 * The registry opened on "YOUR LIBRARY. / ONE REGISTRY." on the landing
 * page and closes on the same two lines here, so the library reads as a
 * bounded record rather than an endless feed. Deliberately carries no counts
 * and no links — the dashboard already reports state, and the nav already
 * navigates. This is a signature, not a second information layer.
 *
 * One authored motion: the caret blinks like a real terminal prompt. It is
 * the only thing that moves, and it stops entirely under reduced-motion.
 */
export const AppFooter: React.FC = () => {
  const reduce = useReducedMotion();

  return (
    <footer className="mt-24 border-t border-brand-border pt-10">
      <div className="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
        {/* The statement carries its own weight — no label above it. */}
        <p className="text-4xl sm:text-5xl lg:text-6xl font-black tracking-tighter leading-[0.92] text-white">
          YOUR LIBRARY.
          <br />
          <span className="text-brand-accent">ONE REGISTRY.</span>
        </p>

        <div className="flex flex-col items-start gap-5 lg:items-end shrink-0">
          <div className="flex items-center gap-2.5">
            <Terminal className="w-4 h-4 text-brand-accent shrink-0" aria-hidden="true" />
            <span className="text-2xl font-black tracking-tighter leading-none">
              <span className="text-white">GAME</span>
              <span className="text-brand-accent">TRACK</span>
            </span>
            <motion.span
              aria-hidden="true"
              className="w-[3px] h-5 bg-brand-accent"
              animate={reduce ? undefined : { opacity: [1, 1, 0, 0] }}
              transition={
                reduce
                  ? undefined
                  : { duration: 1.2, repeat: Infinity, times: [0, 0.5, 0.5, 1], ease: "linear" }
              }
            />
          </div>

          <p className="font-mono text-[11px] font-bold uppercase tracking-widest text-brand-muted">
            // Local database · yours forever
          </p>
        </div>
      </div>
    </footer>
  );
};

export default AppFooter;
