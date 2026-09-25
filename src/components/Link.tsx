import React from "react";

/**
 * Minimal client-side link.
 *
 * The app has no router; App only reads window.location on mount, so a plain
 * <a href> would trigger a full document reload just to open a legal page.
 * This pushes history state and fires popstate, which App listens for, so
 * navigation stays in the SPA.
 *
 * Modified clicks and non-primary buttons fall through to the browser so
 * "open in new tab" keeps working.
 */
export const Link: React.FC<{
  to: string;
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
}> = ({ to, className, children, ...rest }) => {
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (window.location.pathname === to) return;
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <a href={to} onClick={onClick} className={className} {...rest}>
      {children}
    </a>
  );
};

export default Link;
