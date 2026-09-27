import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useGameTrackStore } from "../store";
import { Loader2, LogIn, Joystick, Link2, X } from "lucide-react";
import { useModalA11y } from "../hooks/useModalA11y";

export const AuthModal: React.FC = React.memo(() => {
  const { isAuthOpen, setAuthOpen, steamSettings, saveSteamSettings } = useGameTrackStore();

  const modalRef = useModalA11y(isAuthOpen);

  const [steamProfile, setSteamProfile] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isAuthOpen) return;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAuthOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAuthOpen, setAuthOpen]);

  const handleSteamConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!steamProfile.trim()) return;
    setSubmitting(true);
    try {
      const ok = await saveSteamSettings(steamProfile.trim());
      if (ok) setAuthOpen(false);
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {isAuthOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
            onClick={() => setAuthOpen(false)}
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
            aria-labelledby="auth-modal-title"
            className="relative w-full max-w-sm bg-brand-bg border border-brand-border text-white shadow-2xl z-10"
          >
            <div className="flex items-center justify-between border-b border-brand-border p-5">
              <h3 id="auth-modal-title" className="text-sm font-black uppercase tracking-widest text-white">
                Steam Connect
              </h3>
              <button
                onClick={() => setAuthOpen(false)}
                aria-label="Close (Esc)"
                className="w-[34px] h-[34px] rounded-none bg-zinc-950 border border-brand-border text-brand-muted hover:text-white transition-colors cursor-pointer flex items-center justify-center shrink-0"
                title="Close (Esc)"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {steamSettings?.keySet && steamSettings?.steamId ? (
              <div className="p-6 space-y-4">
                <p className="text-[11px] uppercase tracking-widest text-emerald-400 font-bold">
                  // Steam link active
                </p>

                <div className="flex items-center gap-3 px-3 py-2.5 bg-zinc-950/60 border border-brand-border">
                  {steamSettings.avatarUrl ? (
                    <img src={steamSettings.avatarUrl} alt="" className="w-9 h-9 object-cover" />
                  ) : (
                    <div className="w-9 h-9 bg-zinc-900 border border-brand-border flex items-center justify-center">
                      <Joystick className="w-4 h-4 text-brand-accent" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-[11px] text-white uppercase font-black tracking-wider truncate">
                      {steamSettings.steamName || "Steam account"}
                    </p>
                    <p className="text-[8px] text-brand-muted uppercase tracking-wider mt-0.5 truncate">
                      {steamSettings.profile}
                    </p>
                  </div>
                  <span className="shrink-0 w-2 h-2 bg-emerald-500 animate-[pulse_2s_ease-in-out_infinite]" />
                </div>

                <button
                  type="button"
                  onClick={() => setAuthOpen(false)}
                  className="w-full flex items-center justify-center gap-2 py-3 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink text-xs font-black uppercase tracking-widest transition-all cursor-pointer rounded-none border border-transparent"
                >
                  <LogIn className="w-4 h-4" />
                  Enter Registry
                </button>
              </div>
            ) : (
              <form onSubmit={handleSteamConnect} className="p-6 space-y-4">
                <p className="text-[11px] uppercase tracking-widest text-brand-muted font-bold">
                  Steam is required to enter the registry.
                </p>

                {steamSettings?.keySet && !steamSettings?.steamId && (
                  <p className="px-3 py-2 border border-amber-500/40 bg-amber-500/10 text-[11px] uppercase tracking-widest text-amber-400 font-bold">
                    // API key detected on server — enter your profile to link
                  </p>
                )}

                <div className="space-y-1">
                  <label htmlFor="auth-steam-profile" className="block text-[8px] uppercase tracking-widest text-brand-muted font-bold">
                    Steam Profile URL or ID64
                  </label>
                  <input
                    id="auth-steam-profile"
                    type="text"
                    required
                    autoComplete="off"
                    value={steamProfile}
                    onChange={(e) => setSteamProfile(e.target.value)}
                    placeholder="https://steamcommunity.com/id/yourname"
                    className="w-full px-3 py-2.5 bg-zinc-950 border border-brand-border text-xs focus:outline-none focus:border-brand-accent text-white"
                  />
                </div>

                <p className="text-[8px] text-brand-muted uppercase tracking-wider leading-relaxed">
                  Can't find your URL? Open Steam → click your username → "View my profile" → the page URL is your
                  profile URL. Or grab it here:
                </p>
                <a
                  href="https://steamcommunity.com/my/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-3 py-2 bg-transparent border border-brand-border hover:border-brand-accent/60 text-brand-accent text-[11px] font-sans font-black uppercase tracking-widest transition-all cursor-pointer"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  steamcommunity.com/my/
                </a>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-2 py-3 bg-brand-accent hover:bg-brand-accent-hover disabled:opacity-50 text-brand-accent-ink text-xs font-black uppercase tracking-widest transition-all cursor-pointer rounded-none border border-transparent"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Joystick className="w-4 h-4" />}
                  Connect Steam
                </button>

                <p className="text-center text-[8px] text-brand-muted uppercase tracking-wider">
                  // API key lives in .env on the server — never in the browser
                </p>
              </form>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
});

export default AuthModal;