// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import GameDetailsModal from "../src/components/GameDetailsModal";
import { useGameTrackStore } from "../src/store";
import type { Game } from "../src/types";

/**
 * Where the details modal's controls live, and the shape of the delete
 * confirmation.
 *
 * These are layout contracts rather than behaviour, but the behaviour hangs off
 * them: Delete being reachable mid-edit, or the confirmation replacing the
 * button that opened it, are both mistakes that are easy to reintroduce and
 * hard to notice. Asserted against the rendered DOM because "is it in the
 * header or the sidebar" is not expressible any other way.
 *
 * The two regions are located by walking up from something known to be inside
 * them, not by matching Tailwind classes — those get reordered freely, and a
 * selector that pins them fails for reasons that have nothing to do with what
 * the test is checking.
 */

const game = (over: Partial<Game> = {}): Game => ({
  id: 1,
  title: "Portal",
  year: 2007,
  igdb_id: null,
  genres: [],
  synopsis: "A test synopsis.",
  poster_url: "",
  critic_score: null,
  owned_platforms: ["steam"],
  ownership_status: "owned",
  status: "backlog",
  playtime: 3,
  personal_rating: 9,
  date_added: 1_700_000_000_000,
  date_completed: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  hide_playtime: 0,
  custom_order: null,
  metadata_custom: 0,
  ...over,
});

let deleteCalls: number[] = [];

function stubStore(games: Game[]) {
  deleteCalls = [];
  useGameTrackStore.setState({
    games,
    selectedGame: null,
    customPlatforms: [],
    isAddGameOpen: false,
    fetchAnalytics: async () => {},
    fetchGames: async () => {},
    setAddGameOpen: () => {},
    setActiveTab: () => {},
    openPlayingConflict: () => {},
    showToast: () => {},
    updateCustomOrder: async () => true,
    clearCustomOrder: async () => true,
    syncGameSynopsis: async () => null,
    syncGamePoster: async () => null,
    resetGamePoster: async () => null,
    resetGameMetadata: async () => null,
    deleteGame: async (id: number) => {
      deleteCalls.push(id);
      return true;
    },
  } as never);
}

/**
 * Open the modal on a game the way the library does — by putting it in the
 * store. There is no LibraryView in this file, so there is no card to click.
 */
function open(g: Game) {
  act(() => {
    useGameTrackStore.setState({ selectedGame: g });
  });
}

/**
 * The two regions, found by walking up from something known to be inside them
 * rather than by matching utility classes — those are reordered freely and a
 * selector that pins them produces failures that mean nothing when the design
 * moves. `#details-modal-title` sits two levels below the sidebar column (h3 →
 * the title group → the column), and the header's caption is a direct child of
 * the header bar.
 */
/**
 * The panel is laid out as two columns, so the sidebar is the sibling of the
 * column the header lives in — identified by holding the title, which is in
 * the sidebar and nowhere else. (Anchoring on the poster instead stops a level
 * short: the element wrapping both poster and title does not also hold the
 * action row.)
 */
const sidebar = () => {
  // header → details column → panel. The panel's two children are the sidebar
  // and the details column.
  const panel = header().parentElement!.parentElement!;
  const h3 = document.getElementById("details-modal-title")!;
  return [...panel.children].find((c) => c.contains(h3))!;
};

const header = () => {
  const caption = [...document.querySelectorAll("p")].find((p) =>
    /TITLE CONTROL PANEL|^EDIT METADATA$/i.test((p.textContent ?? "").trim())
  );
  return caption!.parentElement!;
};

const byText = (text: RegExp) =>
  [...document.querySelectorAll("button")].filter((b) => text.test(b.textContent?.trim() ?? ""));

const deleteButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label^="Delete "]')!;

const confirmDialog = () => document.querySelector('[aria-labelledby="delete-modal-title"]');

/**
 * AnimatePresence keeps a dismissed child mounted until its exit animation
 * finishes, so "the dialog closed" is not observable on the same tick as the
 * click that closed it. Waited for rather than asserted immediately.
 */
const waitForDialogGone = () =>
  waitFor(() => expect(confirmDialog()).toBeNull());

const enterEdit = () => fireEvent.click(screen.getByText("Edit Metadata"));

beforeEach(() => {
  stubStore([game()]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Details modal control placement", () => {
  it("puts Edit Metadata and Delete in the sidebar, not the header", () => {
    render(<GameDetailsModal />);
    open(game());

    const edit = byText(/^Edit Metadata$/)[0]!;
    const del = deleteButton();

    expect(sidebar().contains(edit)).toBe(true);
    expect(sidebar().contains(del)).toBe(true);
    // Directly beside one another, so the two are read as a pair.
    expect(edit.parentElement).toBe(del.parentElement);

    expect(header().contains(edit)).toBe(false);
    expect(header().contains(del)).toBe(false);
  });

  it("leaves the header with only Close while reading", () => {
    render(<GameDetailsModal />);
    open(game());
    const labels = [...header().querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") || b.textContent?.trim()
    );
    expect(labels).toEqual(["Close (Esc)"]);
  });

  it("gives Delete an accessible name naming the game", () => {
    // Icon-only, so the visible label is gone — the name is what carries it.
    render(<GameDetailsModal />);
    open(game());
    expect(deleteButton().getAttribute("aria-label")).toBe("Delete Portal");
    expect(deleteButton().textContent?.trim()).toBe("");
  });

  it("offers one Save, in the sidebar row while editing", () => {
    render(<GameDetailsModal />);
    open(game());
    enterEdit();

    // Exactly one. A duplicate Save is two places to look for the same button
    // and one more thing to keep in step, so the sidebar row is the only copy.
    const saves = byText(/^Save$|^Saving…$/);
    expect(saves).toHaveLength(1);
    expect(sidebar().contains(saves[0]!)).toBe(true);

    // And it is the row's own control, not a leftover read-mode button.
    expect(byText(/^Edit Metadata$/)).toHaveLength(0);
  });

  it("leaves the header with only Close while editing too", () => {
    render(<GameDetailsModal />);
    open(game());
    enterEdit();
    const labels = [...header().querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") || b.textContent?.trim()
    );
    expect(labels).toEqual(["Cancel editing"]);
  });

  it("hides Delete while editing, so it cannot discard unsaved edits", () => {
    render(<GameDetailsModal />);
    open(game());
    expect(deleteButton()).not.toBeNull();

    enterEdit();
    expect(deleteButton()).toBeNull();
    expect(byText(/^Edit Metadata$/)).toHaveLength(0);
  });

  it("puts Reset directly above the synopsis rather than in the header", () => {
    render(<GameDetailsModal />);
    open(game({ igdb_id: 1234 }));
    enterEdit();

    const reset = byText(/reset metadata to defaults/i)[0]!;
    expect(reset).toBeDefined();
    expect(header().contains(reset)).toBe(false);

    // Above the synopsis, not merely somewhere in the form.
    const synopsisLabel = screen.getByText("Game Synopsis / Description");
    expect(reset.compareDocumentPosition(synopsisLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("disables Reset with a reason when there is no provider link to reset to", () => {
    render(<GameDetailsModal />);
    open(game({ igdb_id: null }));
    enterEdit();

    const reset = byText(/reset metadata to defaults/i)[0] as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    expect(reset.getAttribute("title")).toMatch(/no igdb link/i);
  });
});

describe("Delete confirmation dialog", () => {
  beforeEach(() => {
    render(<GameDetailsModal />);
    open(game());
  });

  it("opens as a dialog rather than swapping the button in place", () => {
    fireEvent.click(deleteButton());

    expect(confirmDialog()).not.toBeNull();
    // The button that opened it is still there, so the way back is visible.
    expect(deleteButton()).not.toBeNull();
    expect(byText(/^Confirm Delete$/)).toHaveLength(0);
  });

  it("names the game and what is lost with it", () => {
    fireEvent.click(deleteButton());
    const body = document.getElementById("delete-modal-body")!.textContent ?? "";
    expect(body).toContain("Portal");
    expect(body).toMatch(/playtime/i);
    expect(body).toMatch(/cannot be undone/i);
  });

  it("focuses Cancel, never the destructive action", () => {
    fireEvent.click(deleteButton());
    expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
  });

  it("does not delete until confirmed, and not at all when cancelled", async () => {
    fireEvent.click(deleteButton());
    fireEvent.click(byText(/^Cancel$/)[0]!);

    expect(deleteCalls).toEqual([]);
    await waitForDialogGone();
  });

  it("deletes and closes the whole modal once confirmed", async () => {
    fireEvent.click(deleteButton());
    fireEvent.click(byText(/^Delete Game$/)[0]!);

    await waitFor(() => expect(deleteCalls).toEqual([1]));
    await waitForDialogGone();
    expect(useGameTrackStore.getState().selectedGame).toBeNull();
  });

  it("closes on Escape without deleting", async () => {
    fireEvent.click(deleteButton());
    expect(confirmDialog()).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitForDialogGone();
    expect(deleteCalls).toEqual([]);
    // Escape peels back one layer, not two: the details modal stays open.
    expect(screen.queryByText("TITLE CONTROL PANEL")).not.toBeNull();
  });

  it("closes on a backdrop click without deleting", async () => {
    fireEvent.click(deleteButton());
    const backdrop = confirmDialog()!.parentElement!;
    fireEvent.click(backdrop);
    await waitForDialogGone();
    expect(deleteCalls).toEqual([]);
  });
});
