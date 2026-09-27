import { useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query.
 *
 * `useSyncExternalStore` rather than a `useState` + `addEventListener` pair so
 * React reads the query during the first render instead of after an effect:
 * a layout that depends on the viewport would otherwise paint one frame at the
 * wrong size and then reflow. The third argument is the server snapshot; the
 * app renders on the client only, but returning `false` keeps the hook safe to
 * reuse if that ever changes.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false
  );
}

export default useMediaQuery;
