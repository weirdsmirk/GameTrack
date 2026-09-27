import React, { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

// The loader stays up for at least this long so quick (cached) loads still
// feel deliberate, and never longer than MAX_WAIT so a hanging fetch cannot
// trap the app on a blank screen.
const MIN_DISPLAY = 1000;
const MAX_WAIT = 5000;
const FADE_MS = 500;

interface PageLoaderProps {
  /** One boolean per data source the app depends on. When all are true the
   *  boot screen fades out and the app reveals. */
  checks: boolean[];
  onComplete?: () => void;
}

// The visual boot screen itself lives in index.html (inline-styled so it
// paints dark before the stylesheet even loads — no white flash on reload).
// This component only decides WHEN it goes away.
export const PageLoader: React.FC<PageLoaderProps> = ({ checks, onComplete }) => {
  const reduce = useReducedMotion();
  const mountedAt = useRef(Date.now());
  const finishedRef = useRef(false);

  const ready = checks.every(Boolean);

  const finish = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;

    const el = document.getElementById("boot-screen");
    if (el) {
      if (reduce) {
        el.remove();
      } else {
        el.classList.add("boot-screen-hide");
        window.setTimeout(() => el.remove(), FADE_MS + 50);
      }
    }
    onComplete?.();
  };

  // Fade the label in only once Inter is actually loaded, so it appears
  // fully-formed (like the theme-changer label) with no font-swap glitch
  // mid-load.
  useEffect(() => {
    let cancelled = false;
    const show = () => {
      if (cancelled || finishedRef.current) return;
      document.getElementById("boot-label")?.classList.add("show");
    };
    if (typeof document.fonts?.ready?.then === "function") {
      document.fonts.ready.then(show).catch(show);
    } else {
      show();
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Fade out once every check passes AND the minimum display time has elapsed.
  useEffect(() => {
    if (finishedRef.current || !ready) return;
    const wait = Math.max(0, MIN_DISPLAY - (Date.now() - mountedAt.current));
    const timer = setTimeout(finish, wait);
    return () => clearTimeout(timer);
  }, [ready]);

  // Safety cap: never sit on a blank screen longer than this.
  useEffect(() => {
    const timer = setTimeout(finish, MAX_WAIT);
    return () => clearTimeout(timer);
  }, []);

  // Reduced-motion users skip the loader entirely.
  useEffect(() => {
    if (reduce && !finishedRef.current) finish();
  }, [reduce]);

  return null;
};

export default PageLoader;