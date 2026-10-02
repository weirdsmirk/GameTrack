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

/**
 * Everything `activeTab` can be: the menu pages, plus `wishlist`.
 *
 * `wishlist` has no menu position, so it is absent from `TABS` and therefore
 * from `TabId` — but it is a real destination the app navigates to. Written
 * inline in the store's state interface it appeared twice, which is how the
 * `TabId` alias below ended up exported and unused while the union it was meant
 * to express was maintained by hand in two places.
 */
export type ActiveTab = TabId | "wishlist";

/**
 * The tabs that may be restored from storage on reload.
 *
 * Derived from `TABS` rather than listed again. It was previously a hand-kept
 * copy of the same four ids, and the two lists had to agree without anything
 * making them: add a tab to the menu and the new page silently failed to survive
 * a reload, with no error — it just always came back on CENTRAL.
 */
export const RESTORABLE_TABS: readonly TabId[] = TABS.map((t) => t.id);
