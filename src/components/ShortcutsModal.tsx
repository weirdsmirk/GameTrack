import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useGameTrackStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import {
  SHORTCUT_ACTIONS, FIXED_SHORTCUTS, bindingKeys, isBindable, isRebound,
  type ShortcutActionId,
} from "../shortcuts";
import { Keyboard, X, RotateCcw, Pencil, Check } from "lucide-react";
import { useModalA11y } from "../hooks/useModalA11y";
import { KeyRow } from "./KeyRow";
import { lockBodyScroll } from "../utils/scrollLock";

/**
 * The keyboard cheat sheet, and the place to rebind it.
 *
 * Reads its rows from `shortcuts.ts` rather than repeating them, which is the
 * point: the bindings used to be written once in this file and once in the
 * keydown handler, and the two copies drifted — the handler's `G` chords and
 * the `/` search were added to one and forgotten in the other. There is now one
 * list, and the sheet cannot fall out of step with what the app listens for.
 *
 * The editable rows capture the next real keypress rather than asking the user
 * to type into a field. There is no text input here to type into: a shortcut is
 * a physical key, and a text field would give the user a character to type
 * instead of a key to press — and on a US layout Option+1 is `¡`, so a typed
 * "1" is not what the handler matches. Capture sidesteps the whole question.
 */
export const ShortcutsModal: React.FC = React.memo(() => {
  // Selector, not the whole store — see ActivePlayingConflictModal for why the
  // permanently-mounted modals must not subscribe to everything.
  const { isShortcutsOpen, setShortcutsOpen, shortcuts, setShortcut, resetShortcuts } =
    useGameTrackStore(useShallow((s) => ({
      isShortcutsOpen: s.isShortcutsOpen,
      setShortcutsOpen: s.setShortcutsOpen,
      shortcuts: s.shortcuts,
      setShortcut: s.setShortcut,
      resetShortcuts: s.resetShortcuts,
    })));

  const modalRef = useModalA11y(isShortcutsOpen);

  /** The row currently recording a keypress, if any. */
  const [capturing, setCapturing] = useState<ShortcutActionId | null>(null);

  useEffect(() => {
    if (!isShortcutsOpen) return;
    const releaseScrollLock = lockBodyScroll();

    const handleKeyDown = (e: KeyboardEvent) => {
      // While a row is recording, the next bindable keypress is the binding and
      // nothing else happens. Escape backs out without changing anything, which
      // is why `isBindable` rejects it — a capture the user cannot leave is a
      // trap.
      if (capturing) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          setCapturing(null);
          return;
        }
        if (!isBindable(e)) return;
        setShortcut(capturing, e.code);
        setCapturing(null);
        return;
      }
      if (e.key === "Escape") setShortcutsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      releaseScrollLock();
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isShortcutsOpen, setShortcutsOpen, capturing, setShortcut]);

  // Closing mid-capture would leave the row stuck showing "press a key" for a
  // sheet that is no longer on screen, so the mode is cleared on the way out.
  useEffect(() => {
    if (!isShortcutsOpen) setCapturing(null);
  }, [isShortcutsOpen]);

  const anyRebound = SHORTCUT_ACTIONS.some((a) => isRebound(shortcuts, a));

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
            /* Wider than the old `max-w-xs`: a rebind control needs room for a
               label, a keycap and an affordance on one line, and the fixed rows
               below are two-key chords that were already cramped. Capped well
               below the viewport so the sheet still scrolls rather than growing
               off a short screen. */
            className="relative w-full max-w-md bg-brand-bg border border-brand-border text-white shadow-2xl z-10 max-h-[90dvh] flex flex-col"
          >
            <div className="flex items-center justify-between border-b border-brand-border p-5 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Keyboard className="w-4 h-4 text-brand-accent shrink-0" />
                <h3 id="shortcuts-modal-title" className="text-sm font-black uppercase tracking-widest text-white truncate">
                  Shortcuts
                </h3>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {/* Only rendered when something is actually off its default —
                    a reset that does nothing is noise on a pristine sheet. */}
                {anyRebound && (
                  <button
                    onClick={resetShortcuts}
                    aria-label="Reset all shortcuts to defaults"
                    title="Reset all shortcuts to defaults"
                    className="h-[34px] px-3 bg-zinc-950 border border-brand-border text-brand-muted hover:text-white hover:border-brand-accent/50 transition-colors cursor-pointer flex items-center justify-center gap-1.5 text-[10px] font-black uppercase tracking-wider"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reset
                  </button>
                )}
                <button
                  onClick={() => setShortcutsOpen(false)}
                  aria-label="Close (Esc)"
                  className="w-[34px] h-[34px] rounded-none bg-zinc-950 border border-brand-border text-brand-muted hover:text-white transition-colors cursor-pointer flex items-center justify-center shrink-0"
                  title="Close (Esc)"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="p-5 space-y-5 overflow-y-auto overscroll-contain">
              <p className="text-[9px] uppercase tracking-wider text-brand-muted leading-relaxed">
                // Select a shortcut, then press the key you want. Esc cancels.
              </p>

              {/* The editable set. Rows are buttons rather than divs so they are
                  reachable by keyboard and announce as controls; the recorded
                  key is also announced in the accessible name, so a screen
                  reader reads the current binding rather than just the label. */}
              <div className="border border-brand-border divide-y divide-brand-border">
                {SHORTCUT_ACTIONS.map((action) => {
                  const isCapturing = capturing === action.id;
                  const rebound = isRebound(shortcuts, action);
                  const keys = bindingKeys(shortcuts[action.id], action);
                  return (
                    <div key={action.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-[11px] font-black uppercase tracking-wider text-white truncate min-w-0">
                        {action.label}
                      </span>
                      <button
                        type="button"
                        onClick={() => setCapturing(isCapturing ? null : action.id)}
                        aria-label={`${action.label} shortcut: ${keys.join(" ")}. ${isCapturing ? "Press a key to assign, or Escape to cancel" : "Select to change"}`}
                        className={`shrink-0 h-7 min-w-[5.5rem] px-2.5 flex items-center justify-center gap-2 border transition-colors duration-150 cursor-pointer focus:outline-none focus-visible:outline-2 focus-visible:outline-brand-accent ${
                          isCapturing
                            ? "bg-brand-accent text-black border-brand-accent"
                            : rebound
                              ? "bg-zinc-950 border-brand-accent/50 text-white hover:border-brand-accent"
                              : "bg-zinc-950 border-brand-border text-white/60 hover:text-white hover:border-brand-accent/40"
                        }`}
                      >
                        {isCapturing ? (
                          <span className="text-[10px] font-black uppercase tracking-wider flex items-center gap-1.5">
                            <Pencil className="w-3 h-3 shrink-0" />
                            Press a key
                          </span>
                        ) : (
                          <KeyRow keys={keys} dim={false} />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* The fixed keys, in their own block and visibly not editable.
                  They are real and working, so hiding them would make the sheet
                  a lie — but a bare `/` and two typed `G` chords are a different
                  interaction from Option-plus-a-key, so they are listed rather
                  than offered to the rebind control. */}
              <div>
                <p className="text-[9px] uppercase tracking-wider text-brand-muted mb-2">
                  Fixed
                </p>
                <div className="border border-brand-border divide-y divide-brand-border">
                  {FIXED_SHORTCUTS.map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-[11px] font-black uppercase tracking-wider text-brand-muted truncate min-w-0">
                        {row.label}
                      </span>
                      <KeyRow keys={row.keys} className="opacity-40" dim={false} />
                    </div>
                  ))}
                </div>
              </div>

              {anyRebound && (
                <p className="text-[9px] uppercase tracking-wider text-brand-muted leading-relaxed flex items-start gap-1.5">
                  <Check className="w-3 h-3 shrink-0 mt-px text-brand-accent" />
                  Changed shortcuts are saved on this device only.
                </p>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
});

export default ShortcutsModal;
