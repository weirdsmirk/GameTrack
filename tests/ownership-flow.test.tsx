// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import GameDetailsModal from "../src/components/GameDetailsModal";
import { useGameTrackStore } from "../src/store";
import type { Game } from "../src/types";

/**
 * End-to-end walk of the ownership flow through the real component and the real
 * store, with `fetch` stubbed at the boundary.
 *
 * The point of these is the *round trip*: mark a game Not Owned, let the modal
 * close, open it again, and confirm the state came back. Every assertion that
 * only ever inspects freshly-mounted state passes even when reopening resets
 * the form, because a fresh mount is exactly the case that works. The failures
 * these hunt for live in what happens between two openings — which no
 * component-level assertion and no API test can see, because neither of them
 * owns the modal's lifetime.
 */

const ownedGame = (over: Partial<Game> = {}): Game => ({
  id: 1,
  title: "Portal",
  year: 2007,
  igdb_id: null,
  genres: [],
  synopsis: "",
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

/** The rows the fake API holds, and the router over it. */
let serverGames: Game[] = [];
/** Every PUT body the component sent, for asserting on the wire format. */
let puts: Partial<Game>[] = [];

/**
 * Stands in for the Express API with the same normalisation the real one does:
 * a not-owned row comes back with no platforms, because `resolveOwnedPlatforms`
 * drops them server-side. Stubbing the *pre-normalisation* shape here would let
 * a client-side bug hide behind a cooperative server.
 */
function installFetchStub() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    // Matched with a regex rather than endsWith: the PUT path is
    // "/api/games/:id", which does NOT end with "/api/games", so an endsWith
    // check silently routed every save to the 500 fallthrough below.
    const putMatch = url.match(/\/api\/games\/(\d+)$/);
    if (method === "PUT" && putMatch) {
      puts.push(body as Partial<Game>);
      const id = Number(putMatch[1]);
      const existing = serverGames.find((g) => g.id === id);
      if (!existing) return jsonResponse({ error: "not found" }, 404);
      // Mirror the server invariant exactly.
      const ownership = body.ownership_status ?? existing.ownership_status;
      const next: Game = {
        ...existing,
        ...body,
        ownership_status: ownership,
        owned_platforms: ownership === "not_owned" ? [] : (body.owned_platforms ?? existing.owned_platforms),
      } as Game;
      serverGames = serverGames.map((g) => (g.id === id ? next : g));
      return jsonResponse(next);
    }

    if (url.endsWith("/api/analytics")) {
      return jsonResponse({
        summary: {
          total_games: serverGames.length,
          active_games: 0,
          completed_games: 0,
          total_playtime_hours: serverGames.reduce((s, g) => s + g.playtime, 0),
          average_playtime_per_game: 0,
          last_updated: Date.now(),
          owned_games: serverGames.filter((g) => g.ownership_status !== "not_owned").length,
          not_owned_games: serverGames.filter((g) => g.ownership_status === "not_owned").length,
          owned_playtime_hours: 0,
          not_owned_playtime_hours: 0,
        },
        genreAnalytics: [],
        recentActivity: [],
      });
    }

    return jsonResponse({ error: `unstubbed ${method} ${url}` }, 500);
  });
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Reset store + fake server + recorded requests to a known state. */
function seed(games: Game[]) {
  serverGames = games;
  puts = [];
  useGameTrackStore.setState({
    games,
    selectedGame: null,
    customPlatforms: [],
    isAddGameOpen: false,
    fetchAnalytics: async () => {},
    updateCustomOrder: async () => true,
    clearCustomOrder: async () => true,
    deleteGame: async () => true,
    syncGameSynopsis: async () => null,
    syncGamePoster: async () => null,
    resetGamePoster: async () => null,
    resetGameMetadata: async () => null,
    showToast: () => {},
    setAddGameOpen: (v: boolean) => useGameTrackStore.setState({ isAddGameOpen: v }),
    openPlayingConflict: () => {},
    addGame: async () => true,
    addToWishlist: async () => true,
  } as never);
}

const radio = (value: string) =>
  document.querySelector(`input[name="edit-game-ownership"][value="${value}"]`) as HTMLInputElement;

const platformBoxes = () =>
  [...document.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')];

const platformFieldset = () =>
  [...document.querySelectorAll("fieldset")].find((f) =>
    /platform/i.test(f.querySelector("legend")?.textContent ?? "")
  ) as HTMLFieldSetElement;

const openGame = (g: Game) => {
  act(() => {
    useGameTrackStore.setState({ selectedGame: g });
  });
};

const closeGame = () => {
  act(() => {
    useGameTrackStore.setState({ selectedGame: null });
  });
};

/**
 * Put the details modal into edit mode and wait for it to actually be there.
 * The click and the re-render are separate turns of the event loop, so reading a
 * control that only exists in edit mode straight after the click is a race.
 */
const enterEditMode = async () => {
  fireEvent.click(await screen.findByText("Edit Metadata"));
  await screen.findByText("Apply");
};

/**
 * Save and wait for the store to actually hold the new value.
 *
 * Waiting on the recorded request instead would be a race: `updateGame` records
 * the fetch synchronously but only calls `set()` a microtask later, so a test
 * that asserted on the request and then immediately reopened the modal could read
 * the *pre-save* row — and would blame the component for a bug it does not have.
 * Waiting on the store state is what the user actually sees.
 */
const applyChanges = async (expected: Partial<Game>) => {
  fireEvent.click(await screen.findByText("Apply"));
  await vi.waitFor(() =>
    expect(useGameTrackStore.getState().games[0]).toMatchObject(expected)
  );
};

beforeEach(() => {
  vi.stubGlobal("fetch", installFetchStub());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GameDetailsModal ownership round trip", () => {
  it("retains Not Owned when the modal is closed and reopened on the same game", async () => {
    // THE regression this file exists for. A form re-initialises on open from
    // `selectedGame`, and the only thing that decides whether it re-initialises
    // at all is a ref that is reset when `selectedGame` goes null. Anything that
    // closes the modal without that transition — or that mutates the row in the
    // store while the modal stays mounted — leaves the ref pointing at the old
    // id, and the next open silently keeps whatever the previous session left.
    const g = ownedGame();
    seed([g]);
    render(<GameDetailsModal />);

    // Open, mark Not Owned, save.
    openGame(g);
    await enterEditMode();
    fireEvent.click(radio("not_owned"));
    await applyChanges({ ownership_status: "not_owned" });

    // Close and reopen the SAME game — no page reload, no refetch.
    closeGame();
    openGame(useGameTrackStore.getState().games[0]!);
    await enterEditMode();

    expect(radio("not_owned").checked).toBe(true);
    expect(radio("owned").checked).toBe(false);
  });

  it("retains Not Owned across a close, a store refresh and a reopen", async () => {
    // The re-init guard also skips when the row is *replaced* in the store while
    // the modal is mounted (poster upload, IGDB sync, Steam sync all do this).
    // If ownership were not part of what that refresh carries, or if the guard
    // were keyed on object identity rather than the id, the reopened modal could
    // show a value the server never stored.
    const g = ownedGame();
    seed([g]);
    render(<GameDetailsModal />);

    openGame(g);
    await enterEditMode();
    fireEvent.click(radio("not_owned"));
    await applyChanges({ ownership_status: "not_owned" });

    const stored = useGameTrackStore.getState().games[0]!;
    expect(stored.ownership_status).toBe("not_owned");

    closeGame();
    // A fresh refetch replaces the row object wholesale — new identity, same id.
    openGame({ ...stored, poster_url: "/posters/refreshed.jpg" });
    await enterEditMode();

    expect(radio("not_owned").checked).toBe(true);
  });

  it("retains Owned when the same game is reopened after being marked Not Owned and back", async () => {
    // The inverse direction, and the one that a "sticky not_owned" bug would
    // pass. Ownership is a two-state value with no sticky default, so both
    // transitions have to survive the reopen.
    const g = ownedGame();
    seed([g]);
    render(<GameDetailsModal />);

    openGame(g);
    await enterEditMode();
    fireEvent.click(radio("not_owned"));
    await applyChanges({ ownership_status: "not_owned" });

    closeGame();
    openGame(useGameTrackStore.getState().games[0]!);
    await enterEditMode();
    fireEvent.click(radio("owned"));
    await applyChanges({ ownership_status: "owned" });

    expect(puts[1]).toMatchObject({ ownership_status: "owned" });

    closeGame();
    openGame(useGameTrackStore.getState().games[0]!);
    await enterEditMode();
    expect(radio("owned").checked).toBe(true);
    expect(radio("not_owned").checked).toBe(false);
  });

  it("locks the platform checklist for a not-owned game and unlocks it for an owned one", async () => {
    // The disabled state must be derived from the game's stored ownership on
    // open, not from whatever the previous session of this modal left behind.
    seed([ownedGame({ ownership_status: "not_owned", owned_platforms: [] })]);
    render(<GameDetailsModal />);

    openGame(useGameTrackStore.getState().games[0]!);
    await enterEditMode();
    expect(platformFieldset().disabled).toBe(true);
    expect(platformBoxes().every((b) => b.disabled)).toBe(true);

    // Flipping to Owned re-enables them in place — no reopen needed.
    fireEvent.click(radio("owned"));
    expect(platformFieldset().disabled).toBe(false);
    expect(platformBoxes().every((b) => !b.disabled)).toBe(true);

    // And flipping back locks them again, so the control cannot be left open
    // against a row that cannot store a platform.
    fireEvent.click(radio("not_owned"));
    expect(platformFieldset().disabled).toBe(true);
  });

  it("does not send a platform for a not-owned game, even if one is somehow selected", async () => {
    // Defence in depth on the client: the server also drops it, but a PUT that
    // carries a platform for a not-owned row means some control is still live.
    const g = ownedGame();
    seed([g]);
    render(<GameDetailsModal />);

    openGame(g);
    await enterEditMode();
    // Select a platform while owned, then switch. The selection must be dropped.
    fireEvent.click(platformBoxes()[1]!);
    fireEvent.click(radio("not_owned"));
    await applyChanges({});
    await vi.waitFor(() => expect(puts.length).toBe(1));

    expect(puts[0]).toMatchObject({ ownership_status: "not_owned", owned_platforms: [] });
  });

  it("keeps a not-owned game's platform list empty after saving over it", async () => {
    // Owned → Not Owned on a game that already had a platform. The old tag has
    // to be cleared on the row, not merely hidden by the disabled control,
    // because the library's platform filter and the analytics panel read the
    // stored column directly.
    const g = ownedGame({ owned_platforms: ["steam", "playstation"] });
    seed([g]);
    render(<GameDetailsModal />);

    openGame(g);
    await enterEditMode();
    fireEvent.click(radio("not_owned"));
    await applyChanges({ ownership_status: "not_owned" });

    const stored = useGameTrackStore.getState().games[0]!;
    expect(stored.ownership_status).toBe("not_owned");
    expect(stored.owned_platforms).toEqual([]);
  });

  it("shows the Not Owned badge in the sidebar and hides the platform list", () => {
    seed([ownedGame({ ownership_status: "not_owned", owned_platforms: [] })]);
    render(<GameDetailsModal />);
    openGame(useGameTrackStore.getState().games[0]!);

    // The read view, not the edit form.
    expect(document.body.textContent).toMatch(/not owned/i);
    // A not-owned title has no owned platforms, so the list is withheld rather
    // than printed under a heading that claims otherwise.
    expect(document.body.textContent).not.toMatch(/platforms owned/i);
  });

  it("renders the platform list for an owned game", () => {
    seed([ownedGame({ owned_platforms: ["steam"] })]);
    render(<GameDetailsModal />);
    openGame(useGameTrackStore.getState().games[0]!);

    expect(document.body.textContent).toMatch(/platforms owned/i);
    expect(document.body.textContent).not.toMatch(/not in collection/i);
  });
});

describe("GameDetailsModal ownership staleness", () => {
  it("re-derives ownership when edit mode is re-entered after a cancel", async () => {
    // The form only re-initialises when the *game id* changes, so leaving edit
    // mode and coming back leaves the previous session's ownership in place. For
    // every other field that is a harmless "unsaved edits survive"; for ownership
    // it is not, because the value also gates whether the platform control is
    // open. The read view would say NOT OWNED while the edit form said Owned —
    // a form claiming to offer something the row cannot store.
    seed([ownedGame({ ownership_status: "not_owned", owned_platforms: [] })]);
    render(<GameDetailsModal />);

    openGame(useGameTrackStore.getState().games[0]!);
    await enterEditMode();
    expect(radio("owned").checked).toBe(false);

    // Flip to Owned but never save, then cancel editing.
    fireEvent.click(radio("owned"));
    expect(radio("owned").checked).toBe(true);

    // Cancel editing (the header X while editing) and go back in.
    fireEvent.click(screen.getByLabelText("Cancel editing"));
    await screen.findByText("Edit Metadata");
    await enterEditMode();

    // The stored value is not_owned, so that is what the form must offer again.
    expect(radio("not_owned").checked).toBe(true);
    expect(radio("owned").checked).toBe(false);
    expect(platformFieldset().disabled).toBe(true);
  });

  it("restores the platform checklist after a cancelled edit", async () => {
    // The same staleness, one level down: cancel an edit that added a platform
    // and the reopened form still shows it ticked for a game that has none.
    seed([ownedGame({ owned_platforms: [] })]);
    render(<GameDetailsModal />);

    openGame(useGameTrackStore.getState().games[0]!);
    await enterEditMode();
    const before = platformBoxes().map((b) => b.checked);
    expect(before.every((c) => !c)).toBe(true);

    fireEvent.click(platformBoxes()[0]!);
    expect(platformBoxes()[0]!.checked).toBe(true);

    fireEvent.click(screen.getByLabelText("Cancel editing"));
    await screen.findByText("Edit Metadata");
    await enterEditMode();

    expect(platformBoxes().map((b) => b.checked)).toEqual(before);
  });
});
