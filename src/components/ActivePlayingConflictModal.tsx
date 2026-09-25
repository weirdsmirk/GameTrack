import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useGameTrackStore } from "../store";
import { Gamepad2 } from "lucide-react";
import { useModalA11y } from "../hooks/useModalA11y";

export const ActivePlayingConflictModal: React.FC = React.memo(() => {
  const { playingConflict, closePlayingConflict, showToast } = useGameTrackStore();
  const modalRef = useModalA11y(Boolean(playingConflict));
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    if (!playingConflict) return;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !processing) {
        closePlayingConflict();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [playingConflict, closePlayingConflict, processing]);

  if (!playingConflict) return null;

  const { currentGame, pendingTitle, onConfirmSwitch } = playingConflict;

  const handleAction = async (action: "backlog" | "completed") => {
    if (processing) return;
    setProcessing(true);
    try {
      await onConfirmSwitch(action);
      closePlayingConflict();
      if (action === "completed") {
        showToast("Game completed", "success", `Now Playing "${pendingTitle}"`);
      } else {
        showToast("Focus switched", "info", `Now Playing "${pendingTitle}"`);
      }
    } catch (err) {
      console.error("Failed to switch playing status:", err);
      showToast("Failed to switch game status", "error");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={() => !processing && closePlayingConflict()}
          className="fixed inset-0 bg-black/80"
        />

        {/* Modal Window */}
        <motion.div
          ref={modalRef}
          initial={{ opacity: 0, scale: 0.96, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 12 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="conflict-modal-title"
          className="relative w-full max-w-lg bg-zinc-950 border border-brand-border text-white shadow-2xl z-10 p-6 sm:p-7 space-y-5"
        >
          {/* Header */}
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 bg-zinc-900 border border-brand-border flex items-center justify-center shrink-0 mt-0.5">
              <Gamepad2 className="w-5 h-5 text-emerald-400" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-mono uppercase tracking-widest text-brand-muted font-bold">
                Active Session
              </p>
              <h3
                id="conflict-modal-title"
                className="text-base sm:text-lg font-black uppercase tracking-tight text-white leading-snug break-words"
              >
                Complete "{currentGame.title}" First
              </h3>
            </div>
          </div>

          {/* Description */}
          <p className="text-xs sm:text-sm text-zinc-300 leading-relaxed font-sans">
            You're currently playing <span className="font-bold text-white uppercase font-mono">"{currentGame.title}"</span>. Finish it first or switch active games to play <span className="font-bold text-brand-accent">"{pendingTitle}"</span>.
          </p>

          {/* Action Buttons */}
          <div className="flex gap-2.5 pt-1">
            <button
              type="button"
              disabled={processing}
              onClick={() => handleAction("backlog")}
              className="flex-1 py-3 px-4 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink font-black text-xs uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-50 text-center"
            >
              Switch Game
            </button>
            <button
              type="button"
              disabled={processing}
              onClick={() => closePlayingConflict()}
              className="py-3 px-5 bg-transparent text-brand-muted hover:text-white border border-brand-border font-bold text-xs uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
});
