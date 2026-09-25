import React from "react";
import { Link } from "./Link";
import { LEGAL_ORDER } from "./LegalView";

/**
 * Closing brand statement for the app shell.
 *
 * The registry opened on "YOUR LIBRARY. / ONE REGISTRY." on the landing
 * page and closes on the same two lines here, so the library reads as a
 * bounded record rather than an endless feed. Deliberately carries no counts
 * and no links — the dashboard already reports state, and the nav already
 * navigates. This is a signature, not a second information layer.
 *
 * Fully static. The blinking caret that used to follow the wordmark is gone:
 * with a literal underscore in GAMETRACK_ it read as a second cursor, and a
 * footer that animated while the identical navbar wordmark did not was
 * inconsistent anyway.
 */
export const AppFooter: React.FC = () => {
  return (
    /* The rule is a pseudo-element rather than border-t so it can break out of
       the page gutter. The negatives mirror the content wrapper's own padding
       (px-6, md:px-12), so the line lands exactly on the viewport edges at
       every breakpoint. It still lands inside the wrapper's padding box, so the
       wrapper's overflow-x-hidden does not clip it. */
    <footer className="relative mt-24 pt-10 before:absolute before:top-0 before:-left-6 before:-right-6 md:before:-left-12 md:before:-right-12 before:h-px before:bg-brand-border before:content-['']">
      <div className="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
        {/* The statement carries its own weight — no label above it. */}
        <p className="text-4xl sm:text-5xl lg:text-6xl font-black tracking-tighter leading-[0.92] text-white">
          YOUR LIBRARY.
          <br />
          <span className="text-brand-accent">ONE REGISTRY.</span>
        </p>

        <div className="flex flex-col items-start gap-5 lg:items-end shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl font-black tracking-tighter leading-none">
              <span className="text-white">GAME</span>
              <span className="text-brand-accent">TRACK</span>
              <span className="text-brand-accent">_</span>
            </span>
          </div>

          {/* Legal links. Sans-serif rather than the mono micro-label the
              local-database line above used to carry: these are body-copy
              destinations, not telemetry, and read better as plain UI text.
              Wrapped in <nav> for the landmark. */}
          <nav aria-label="Legal" className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {LEGAL_ORDER.map((doc) => (
              <Link
                key={doc.slug}
                to={`/${doc.slug}`}
                className="font-sans text-xs font-semibold text-zinc-400 hover:text-brand-accent transition-colors"
              >
                {doc.title}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
};

export default AppFooter;
