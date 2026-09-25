import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Buttons } from "./Buttons";

interface BackToTopProps {
  /** Ref to the scrollable container (the app's <main> element). */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** How far (px) the user must scroll before the button appears. */
  showAfter?: number;
}

export const BackToTop: React.FC<BackToTopProps> = ({ scrollContainerRef, showAfter = 600 }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => setVisible(el.scrollTop > showAfter);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef, showAfter]);

  const scrollToTop = () => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 28 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40"
        >
          <Buttons
            variant="primary"
            onClick={scrollToTop}
            aria-label="Back to top"
            title="Back to top"
            className="px-3 py-1.5 text-[11px]"
          >
            Back to top
          </Buttons>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default BackToTop;
