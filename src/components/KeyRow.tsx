import React from "react";

/**
 * A keyboard chord, written as plain dim text — the app's one way of showing a
 * shortcut. Shared by the nav menu (each destination advertises its own digit)
 * and the cheat-sheet modal (the full list), so a key looks the same in both.
 *
 * No boxes: at 10px the label is the content and the chord is a footnote, and
 * a bordered cap beside a 46px row added more weight than the hint deserved.
 * The element is `kbd` so the semantics survive, and it is left readable to
 * assistive tech — a menu button announcing "Central, Alt 1" tells a
 * screen-reader user the shortcut exists, which is the point of showing it.
 *
 * `font-sans` has to sit on the `kbd` itself, not on a wrapper: Tailwind's
 * preflight declares `code, kbd, samp, pre` on the mono stack directly, so a
 * font set on an ancestor is only inherited and loses to it. Without this class
 * these hints are the one place a monospace face survives in an app that is
 * Inter throughout.
 *
 * `dim` is a prop rather than something a caller cancels with its own
 * `opacity-*` class: two opacity utilities in one class list are decided by
 * stylesheet order, not by the order they were written, so passing
 * `opacity-100` to cancel `opacity-50` would work only by accident of how
 * Tailwind happened to emit them. This way there is never a second one.
 */
export const KeyRow: React.FC<{ keys: string[]; className?: string; dim?: boolean }> = ({
  keys,
  className = "",
  dim = true,
}) => (
  <kbd className={`shrink-0 font-sans text-[10px] font-black uppercase tracking-wider ${dim ? "opacity-50" : "opacity-100"} ${className}`}>
    {keys.join(" ")}
  </kbd>
);

export default KeyRow;
