import React from "react";

/**
 * The app's one loading indicator: a bare ring with a single accent arc
 * turning inside it. No box, no label, no fill — the loader sits on top of
 * whatever it is covering, so anything it draws competes with the content
 * underneath. Square corners and a 2px stroke match the button language.
 *
 * `motion-safe:` so a reduced-motion user gets the same static arc rather than
 * a spinning one, and the arc is still unmistakably a progress indicator.
 */
export const Spinner: React.FC<{ size?: number; label?: string; className?: string }> = ({
  size = 28,
  label = "Loading",
  className = "",
}) => (
  <span role="status" aria-label={label} className={`inline-flex ${className}`}>
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      className="motion-safe:animate-spin"
      style={{ animationDuration: "0.9s" }}
    >
      <circle cx="20" cy="20" r="16" stroke="var(--brand-border)" strokeWidth="2" />
      <circle
        cx="20"
        cy="20"
        r="16"
        stroke="var(--brand-accent)"
        strokeWidth="2"
        strokeLinecap="butt"
        strokeDasharray="26 100"
      />
    </svg>
  </span>
);

export default Spinner;
