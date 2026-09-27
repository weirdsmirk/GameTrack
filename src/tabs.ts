/**
 * The navigation destinations, in menu order. Three things read this list and
 * must agree on the order: the menu in `App`, the Option+1..4 shortcuts (index
 * +1 is the digit), and the cheat-sheet modal. Keeping one list is why the
 * shortcut for a page cannot drift from that page's position in the menu.
 *
 * `wishlist` is deliberately absent — it is reached from the dashboard, not
 * from the menu, so it has no menu position and no digit.
 */
export const TABS = [
  { id: "dashboard", label: "CENTRAL" },
  { id: "discover", label: "DISCOVER" },
  { id: "library", label: "LIBRARY" },
  { id: "analytics", label: "ANALYTICS" }
] as const;

export type TabId = (typeof TABS)[number]["id"];
