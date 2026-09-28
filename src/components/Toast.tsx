import React from "react";
import { useGameTrackStore } from "../store";
import { motion, AnimatePresence } from "motion/react";

/**
 * Toasts are solid boxes in the app's own button language: the accent fill for
 * confirmations, red for errors, a neutral zinc slab for notices. Text wears
 * the fill's ink token, so every theme stays legible without a second colour.
 */
const TYPE_STYLES = {
  success: "bg-brand-accent text-brand-accent-ink hover:bg-brand-accent-hover",
  error: "bg-red-600 text-brand-on-color hover:bg-red-500",
  info: "bg-zinc-800 text-white hover:bg-zinc-700",
} as const;

export const Toast: React.FC = () => {
  const toasts = useGameTrackStore((state) => state.toasts);
  const dismissToast = useGameTrackStore((state) => state.dismissToast);
  const pauseToast = useGameTrackStore((state) => state.pauseToast);
  const resumeToast = useGameTrackStore((state) => state.resumeToast);

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col items-end gap-2.5 pointer-events-none">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, x: 48 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 32, transition: { duration: 0.16, ease: "easeIn" } }}
            transition={{ type: "spring", stiffness: 480, damping: 34 }}
            onClick={() => dismissToast(toast.id)}
            onMouseEnter={() => pauseToast(toast.id)}
            onMouseLeave={() => resumeToast(toast.id)}
            role={toast.type === "error" ? "alert" : "status"}
            aria-live={toast.type === "error" ? "assertive" : "polite"}
            className={`pointer-events-auto will-change-transform overflow-hidden cursor-pointer select-none w-[calc(100vw-3rem)] sm:w-auto sm:max-w-[340px] ${TYPE_STYLES[toast.type]}`}
          >
            <div className="px-4 py-3">
              <p className="text-[13px] font-sans font-semibold leading-snug">
                {toast.message}
              </p>

              {/* Actions inherit the fill's ink rather than picking a colour, so
                  the same markup works on the accent, red and zinc slabs
                  without a variant per type. Underlined rather than boxed: the
                  toast is already a box. Each dismisses the toast as it runs —
                  the toast sits above the modals at z-100, so leaving it up
                  would park it on top of whatever it just opened. */}
              {toast.actions && toast.actions.length > 0 && (
                <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
                  {toast.actions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      title={action.title}
                      onClick={(e) => {
                        e.stopPropagation();
                        dismissToast(toast.id);
                        action.onClick();
                      }}
                      className={`text-left text-[11px] font-black uppercase tracking-wider underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-current focus-visible:outline-offset-2 ${
                        action.tone === "secondary" ? "opacity-60 hover:opacity-100" : "hover:opacity-75"
                      }`}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="toast-progress" style={{ animationDuration: `${toast.duration}ms` }} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
export default Toast;
