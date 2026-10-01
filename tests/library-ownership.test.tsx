// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import LibraryView from "../src/components/LibraryView";
import AddGameModal from "../src/components/AddGameModal";
import { useGameTrackStore } from "../src/store";
import type { Game } from "../src/types";

/**
 * The ownership filter and the controls it gates.
 *
 * Both surfaces read the flag, and both were written against the store's `games`
 * array rather than any local copy, so they can be driven here by seeding the
 * store alone — no server needed. What is worth asserting is the *predicate*:
 * a filter that returns the wrong rows is worse than no filter, because it looks
 * like an answer.
 */

const game = (over: Partial<Game> & Pick<Game, "id" | "title">): Game => ({
  year: 2020,
  igdb_id: null,
  genres: [],
  synopsis: "",
  poster_url: "",
  critic_score: null,
  owned_platforms: [],
  ownership_status: "owned",
  status: "backlog",
  playtime: 0,
  personal_rating: null,
  date_added: 1_700_000_000_000,
  date_completed: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  hide_playtime: 0,
  custom_order: null,
  metadata_custom: 0,
  ...over,
});

/**
 * Minimal store overrides. LibraryView subscribes to a wide slice, so anything
 * it reads has to be present or the selector throws.
 */
function stubStore(over: Record<string, unknown> = {}) {
  useGameTrackStore.setState({
    games: [],
    loadingGames: false,
    loadingAnalytics: false,
    gamesError: null,
    wishlist: [],
    customPlatforms: [],
    customizations: {
      theme: "noir",
      libraryColumns: 5,
      discoverColumns: 6,
      showPlaytimeBadge: true,
      showRatingBadge: true,
      showShortcutHint: false,
    },
    filters: {
      status: "",
      ownership: "",
      platform: "",
      sort: "recent",
      search: "",
      hideCompleted: false,
      hideEndless: false,
    },
    isAddGameOpen: false,
    searchFocusToken: 0,
    fetchGames: async () => {},
    fetchAnalytics: async () => {},
    setSelectedGame: () => {},
    setAddGameOpen: () => {},
    setActiveTab: () => {},
    updateCustomOrder: async () => true,
    clearCustomOrder: async () => true,
    deleteGames: async () => true,
    addGame: async () => true,
    addToWishlist: async () => true,
    fetchSuggestions: async () => {},
    showToast: () => {},
    openPlayingConflict: () => {},
    ...over,
  } as never);
}

/** Titles of the library cards currently rendered, in order. */
const visibleTitles = () =>
  [...document.querySelectorAll<HTMLElement>('[role="button"][aria-label*="View details"]')].map(
    (el) => el.getAttribute("aria-label") ?? ""
  );

const setOwnershipFilter = (value: string) => {
  const select = document.getElementById("filter-ownership") as HTMLSelectElement;
  expect(select).not.toBeNull();
  fireEvent.change(select, { target: { value } });
};

const openFilters = () => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    b.querySelector("svg.lucide-sliders-horizontal")
  );
  expect(btn).toBeDefined();
  fireEvent.click(btn!);
};

const LIBRARY = [
  game({ id: 1, title: "Owned Steam", owned_platforms: ["steam"], status: "completed" }),
  game({ id: 2, title: "Owned Xbox", owned_platforms: ["xbox"], status: "backlog" }),
  game({
    id: 3,
    title: "Borrowed Played",
    ownership_status: "not_owned",
    status: "completed",
    playtime: 9,
  }),
  game({ id: 4, title: "Borrowed Unplayed", ownership_status: "not_owned", status: "backlog" }),
];

beforeEach(() => {
  // localStorage is not available in this environment (Node warns about it), so
  // the store's safeGetItem/safeSetItem no-op and the filters persist in memory
  // only. That is enough to assert the filter value round-trips through
  // setFilter; persistence *to storage* is the store's own concern.
  stubStore({ games: LIBRARY });
});

afterEach(() => {
  cleanup();
});

describe("Library ownership filter", () => {
  it("offers both states plus an all option", () => {
    render(<LibraryView />);
    openFilters();
    const select = document.getElementById("filter-ownership") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "owned", "not_owned"]);
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "All Ownership",
      "Owned",
      "Not Owned",
    ]);
  });

  it("shows every title by default", () => {
    render(<LibraryView />);
    expect(visibleTitles()).toHaveLength(4);
  });

  it("isolates the not-owned titles", () => {
    render(<LibraryView />);
    setOwnershipFilter("not_owned");
    expect(visibleTitles()).toEqual([
      "View details for Borrowed Played, not owned",
      "View details for Borrowed Unplayed, not owned",
    ]);
  });

  it("isolates the owned titles", () => {
    render(<LibraryView />);
    setOwnershipFilter("owned");
    expect(visibleTitles()).toEqual([
      "View details for Owned Steam",
      "View details for Owned Xbox",
    ]);
  });

  it("composes with the status filter rather than replacing it", () => {
    // The combination is the reason the feature is useful: "completed and not
    // mine" is the finished-but-borrowed pile, which is a question no single
    // axis answers.
    render(<LibraryView />);
    setOwnershipFilter("not_owned");
    fireEvent.change(document.getElementById("filter-status")!, { target: { value: "completed" } });
    expect(visibleTitles()).toEqual(["View details for Borrowed Played, not owned"]);
  });

  it("returns to the full library when the filter is cleared", () => {
    render(<LibraryView />);
    setOwnershipFilter("not_owned");
    expect(visibleTitles()).toHaveLength(2);
    setOwnershipFilter("");
    expect(visibleTitles()).toHaveLength(4);
  });

  it("counts the ownership filter as an active filter and clears it on reset", () => {
    render(<LibraryView />);
    // The badge is the only visible signal that a filter is narrowing the grid,
    // so an ownership filter that filtered without being counted would look
    // like a broken grid rather than an active filter.
    const filterButton = () =>
      [...document.querySelectorAll("button")].find((b) =>
        b.querySelector("svg.lucide-sliders-horizontal")
      )!;

    const badge = () => filterButton().textContent?.replace(/filters/i, "").trim() ?? "";

    expect(badge()).toBe("");
    setOwnershipFilter("not_owned");
    expect(badge()).toBe("1");

    // A second axis stacks, so the count is of filters and not of results.
    fireEvent.change(document.getElementById("filter-status")!, { target: { value: "completed" } });
    expect(badge()).toBe("2");

    fireEvent.click(
      [...document.querySelectorAll("button")].find((b) =>
        /^reset$/i.test(b.textContent?.trim() ?? "")
      )!
    );
    expect(badge()).toBe("");
    expect(visibleTitles()).toHaveLength(4);
  });

  it("marks not-owned cards without disturbing the owned ones", () => {
    render(<LibraryView />);
    const chips = [...document.querySelectorAll("span")].filter((s) =>
      /^Not Owned$/.test(s.textContent?.trim() ?? "")
    );
    // One chip per borrowed title, and no chip on an owned card.
    expect(chips).toHaveLength(2);
    // The accessible name carries it too, so it is not colour-only.
    expect(visibleTitles().filter((t) => t.includes("not owned"))).toHaveLength(2);
  });
});

describe("AddGameModal ownership", () => {
  const setOwnership = (value: string) => {
    const input = document.querySelector(
      `input[name="add-game-ownership"][value="${value}"]`
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.click(input);
  };

  const platformFieldset = () =>
    [...document.querySelectorAll("fieldset")].find((f) =>
      /platform/i.test(f.querySelector("legend")?.textContent ?? "")
    ) as HTMLFieldSetElement;

  const platformBoxes = () =>
    [...document.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')];

  it("defaults to owned with the platform checklist available", () => {
    stubStore({ isAddGameOpen: true, games: [] });
    render(<AddGameModal />);
    const owned = document.querySelector(
      'input[name="add-game-ownership"][value="owned"]'
    ) as HTMLInputElement;
    expect(owned.checked).toBe(true);
    expect(platformFieldset().disabled).toBe(false);
  });

  it("locks the platform checklist when Not Owned is chosen and unlocks it again", () => {
    stubStore({ isAddGameOpen: true, games: [] });
    render(<AddGameModal />);

    setOwnership("not_owned");
    expect(platformFieldset().disabled).toBe(true);
    expect(platformBoxes().every((b) => b.disabled)).toBe(true);
    expect(document.body.textContent).toMatch(/unavailable on a game marked Not Owned/i);

    setOwnership("owned");
    expect(platformFieldset().disabled).toBe(false);
    expect(platformBoxes().every((b) => !b.disabled)).toBe(true);
  });

  it("discards a platform picked before switching to Not Owned", () => {
    stubStore({ isAddGameOpen: true, games: [] });
    render(<AddGameModal />);

    fireEvent.click(platformBoxes()[0]!);
    expect(platformBoxes()[0]!.checked).toBe(true);

    setOwnership("not_owned");
    // Cleared rather than merely hidden, so switching back does not resurrect a
    // platform the user picked while the control was closed.
    expect(platformBoxes().every((b) => !b.checked)).toBe(true);
  });

  it("leaves the platform checklist available for a wishlist entry", () => {
    // A wishlist row is not owned by nature, but its tags mean "available on",
    // and the promotion to the library is what turns them into ownership.
    stubStore({ isAddGameOpen: true, games: [] });
    render(<AddGameModal />);
    const wishlistTab = [...document.querySelectorAll("button")].find((b) =>
      /wishlist/i.test(b.textContent?.trim() ?? "")
    );
    expect(wishlistTab).toBeDefined();
    fireEvent.click(wishlistTab!);

    // No ownership control is offered for the wishlist target at all.
    expect(document.querySelector('input[name="add-game-ownership"]')).toBeNull();
    expect(platformFieldset().disabled).toBe(false);
  });
});
