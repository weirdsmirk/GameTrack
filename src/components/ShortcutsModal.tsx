import React, { useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useGameTrackStore } from "../store";
import { TABS } from "../tabs";
import { Keyboard, X } from "lucide-react";
import { useModalA11y } from "../hooks/useModalA11y";
import { KeyRow } from "./KeyRow";

/**
 * The keyboard cheat sheet. Rows are the same Option shortcuts the keydown
 * handler in `App` dispatches, numbered off `TABS` so a page's digit cannot
 * drift from its position in the menu. The last three are the older
 * shortcuts, still bound, so they belong here too — a cheat sheet that
 * omits working keys is worse than none.
 *
 * "ALT" is spelled out rather than drawn as ⌥: the app does not sniff the
 * platform, and the word reads as the same physical key on macOS and
 * everywhere else, where the glyph would not.
 */
const ROWS: { keys: string[]; label: string }[] = [
  ...TABS.map((tab, i) => ({ keys: ["ALT", String(i + 1)], label: tab.label })),
  { keys: ["ALT", ","], label: "SETTINGS" },
  { keys: ["/"], label: "LIBRARY + SEARCH" },
  { keys: ["G", "L"], label: "LIBRARY" },
  { keys: ["G", "D"], label: "CENTRAL" }
];

export const ShortcutsModal: React.FC = React.memo(() => {
  const { isShortcutsOpen, setShortcutsOpen } = useGameTrackStore();

  const modalRef = useModalA11y(isShortcutsOpen);

  useEffect(() => {
    if (!isShortcutsOpen) return;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShortcutsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isShortcutsOpen, setShortcutsOpen]);

  return (
    <AnimatePresence>
      {isShortcutsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
            onClick={() => setShortcutsOpen(false)}
            className="absolute inset-0 bg-black/90"
          />

          <motion.div
            ref={modalRef}
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            role="dialog"
            aria-modal="true"
            style={{ willChange: "transform" }}
            aria-labelledby="shortcuts-modal-title"
            className="relative w-full max-w-xs bg-brand-bg border border-brand-border text-white shadow-2xl z-10"
          >
            <div className="flex items-center justify-between border-b border-brand-border p-5">
              <div className="flex items-center gap-2 min-w-0">
                <Keyboard className="w-4 h-4 text-brand-accent shrink-0" />
                <h3 id="shortcuts-modal-title" className="text-sm font-black uppercase tracking-widest text-white truncate">
                  Shortcuts
                </h3>
              </div>
              <button
                onClick={() => setShortcutsOpen(false)}
                aria-label="Close (Esc)"
                className="w-[34px] h-[34px] rounded-none bg-zinc-950 border border-brand-border text-brand-muted hover:text-white transition-colors cursor-pointer flex items-center justify-center shrink-0"
                title="Close (Esc)"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="p-5 space-y-3">
              <p className="text-[9px] uppercase tracking-wider text-brand-muted leading-relaxed">
                // Digits follow the menu order. G chords are typed in sequence.
              </p>

              <div className="border border-brand-border divide-y divide-brand-border">
                {ROWS.map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="text-[11px] font-black uppercase tracking-wider text-white truncate">
                      {row.label}
                    </span>
                    <KeyRow keys={row.keys} />
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
});

export default ShortcutsModal;
