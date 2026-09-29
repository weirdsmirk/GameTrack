import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessibility for modal dialogs:
 *  - moves focus into the dialog on open,
 *  - traps Tab/Shift+Tab inside it,
 *  - restores focus to the previously focused element on close.
 * Escape handling stays in each modal (it predates this hook).
 */
export function useModalA11y(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const panel = ref.current;
    const prevFocus = document.activeElement as HTMLElement | null;

    /* Filtered for actual visibility, not just for not being `disabled`.
       The selector alone returned hidden elements, and the trap then computed
       its first/last stops from them: the Discover "Add to library" overlay is
       `opacity-0 invisible` until hover, and the Wishlist hover overlay the
       same, so both sat at the ends of the focus list. Tabbing forward from
       the last *real* control wrapped to an invisible one — focus went
       somewhere the user could not see, and Tab from there had to walk the
       hidden elements back out before reaching anything on screen. */
    const isVisible = (el: HTMLElement): boolean => {
      // offsetParent is null for display:none subtrees; the rect check covers
      // the visibility/opacity/zero-size cases the class names express.
      // checkVisibility() would be tidier but is not in every target browser.
      if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") return false;
      if (el.closest('[aria-hidden="true"]')) return false;
      if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0 || el === document.activeElement;
    };

    const getFocusables = () =>
      panel
        ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible)
        : [];

    // Move focus into the dialog (first focusable, or the panel itself so
    // screen readers land on it) — unless focus is already inside, e.g. when
    // a nested dialog closes and returns focus to this panel's trigger.
    if (!panel?.contains(document.activeElement)) {
      const first = getFocusables()[0] ?? panel;
      first?.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = getFocusables();
      if (!focusables.length) {
        if (panel) {
          panel.focus();
          e.preventDefault();
        }
        return;
      }
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (!firstEl || !lastEl) return;
      const active = document.activeElement;
      const isInside = active !== null && panel?.contains(active);
      if (e.shiftKey && (!isInside || active === firstEl)) {
        lastEl.focus();
        e.preventDefault();
      } else if (!e.shiftKey && (!isInside || active === lastEl)) {
        firstEl.focus();
        e.preventDefault();
      }    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      // Restore focus to whatever opened the dialog (no-op if it's gone).
      // preventScroll keeps the page from jumping when focus is returned.
      prevFocus?.focus?.({ preventScroll: true });
    };
  }, [open]);

  return ref;
}
