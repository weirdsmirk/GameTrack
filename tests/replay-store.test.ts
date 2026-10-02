// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useGameTrackStore } from "../src/store";
import type { Game, Playthrough } from "../src/types";

/**
 * Store-level replay behaviour: the cache, and the concurrency around it.
 *
 * The bug these exist for is a dropped refresh. `addPlaythrough`/`update`/
 * `delete` all finish by asking for a forced refetch, because the server owns
 * the `sequence` numbering (deleting a middle replay renumbers everything after
 * it) and no client can know that. But the details modal mounts a prefetch the
 * instant it opens — so if the user logs a replay while that prefetch is still
 * in flight, the "already loading" guard used to swallow the forced refetch, the
 * stale prefetch response landed afterwards, and the UI showed a list that
 * predated the replay the user had just been told was saved.
 */

const json = (body: unknown, status = 200) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);

const game = (over: Partial<Game> = {}): Game =>
  ({
    id: 1, title: "Test", status: "completed", playtime: 10,
    date_added: 0, date_completed: null, created_at: 0, updated_at: 0,
    genres: [], igdb_id: null, year: null, synopsis: "", poster_url: "",
    critic_score: null, owned_platforms: [], personal_rating: null,
    ownership_status: "owned", times_played: 1, replay_playtime: 0,
    ...over,
  }) as Game;

const run = (over: Partial<Playthrough> = {}): Playthrough => ({
  id: 1, game_id: 1, sequence: 2, status: "completed", playtime: 5,
  personal_rating: null, date_completed: null, platform: null, notes: "",
  created_at: 0, updated_at: 0, ...over,
});

beforeEach(() => {
  useGameTrackStore.setState({
    games: [game()],
    selectedGame: null,
    playthroughs: {},
    loadingPlaythroughs: {},
    summary: null,
    showToast: vi.fn(),
    fetchAnalytics: async () => {},
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("replay cache", () => {
  it("loads once per game, and does not refetch on a second non-forced call", async () => {
    const fetchMock = vi.fn(async () => json({ playthroughs: [run()], times_played: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    await useGameTrackStore.getState().fetchPlaythroughs(1);
    await useGameTrackStore.getState().fetchPlaythroughs(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useGameTrackStore.getState().playthroughs[1]).toHaveLength(1);
  });

  it("refetches when forced even though the list is already cached", async () => {
    const fetchMock = vi.fn(async () => json({ playthroughs: [run()], times_played: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    await useGameTrackStore.getState().fetchPlaythroughs(1);
    await useGameTrackStore.getState().fetchPlaythroughs(1, true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches a game's replays per id and does not leak one game's runs to another", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      json({
        playthroughs: String(u).endsWith("/2/playthroughs") ? [run({ game_id: 2, sequence: 2 })] : [],
        times_played: 2,
      })
    ));

    await useGameTrackStore.getState().fetchPlaythroughs(1);
    await useGameTrackStore.getState().fetchPlaythroughs(2);

    const cache = useGameTrackStore.getState().playthroughs;
    expect(cache[1]).toEqual([]);
    expect(cache[2]).toHaveLength(1);
    expect(cache[2]?.[0]?.game_id).toBe(2);
  });

  it("forgets a deleted game's replays rather than keeping them renderable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ success: true })));
    await useGameTrackStore.getState().fetchPlaythroughs(1);
    expect(useGameTrackStore.getState().playthroughs[1]).toBeDefined();

    await useGameTrackStore.getState().deleteGame(1);

    // The rows are gone with the game (the API cascades). A retained list would
    // be worse than empty: it could reappear against a future game reusing the id.
    expect(useGameTrackStore.getState().playthroughs[1]).toBeUndefined();
  });
});

describe("replay refresh is not dropped by an in-flight load", () => {
  it("still refetches when a replay is added while the initial load is in flight", async () => {
    // The exact race: the modal's prefetch is still open when the POST returns
    // and asks for a forced refresh.
    let releaseFirst!: (v: unknown) => void;
    const firstInFlight = new Promise((r) => { releaseFirst = r; });

    let call = 0;
    const fetchMock = vi.fn(async (u: string, init?: RequestInit) => {
      // 1. the modal's initial prefetch — held open
      if (String(u).includes("/playthroughs") && (init?.method ?? "GET") === "GET" && call++ === 0) {
        await firstInFlight;
        // ...and it was issued BEFORE the POST, so it can only return stale data.
        return json({ playthroughs: [], times_played: 1 });
      }
      if (String(u).includes("/playthroughs") && (init?.method ?? "GET") === "GET") {
        return json({ playthroughs: [run()], times_played: 2 });
      }
      return json({ success: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = useGameTrackStore.getState();
    const initial = store.fetchPlaythroughs(1);          // prefetch, in flight
    await Promise.resolve();                              // let it set loading=true

    const added = store.addPlaythrough(1, { status: "completed", playtime: 5 });
    await Promise.resolve();
    releaseFirst(null);                                   // stale response lands
    await initial;
    await added;

    // The newly logged replay must be present. Before the fix the forced
    // refresh was swallowed by the loading guard, this stale list won, and the
    // row the user had just been told was saved simply never appeared.
    expect(useGameTrackStore.getState().playthroughs[1]).toHaveLength(1);
  });

  it("coalesces two simultaneous non-forced loads into one request", async () => {
    const fetchMock = vi.fn(async () => json({ playthroughs: [], times_played: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const store = useGameTrackStore.getState();
    await Promise.all([store.fetchPlaythroughs(1), store.fetchPlaythroughs(1)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the loading flag when a load fails, so the row cannot hang on a spinner", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "boom" }, 500)));
    await useGameTrackStore.getState().fetchPlaythroughs(1);
    expect(useGameTrackStore.getState().loadingPlaythroughs[1]).toBe(false);
  });

  it("does not raise a toast for a background load of a game the user is not viewing", async () => {
    const toast = vi.fn();
    useGameTrackStore.setState({ selectedGame: null, showToast: toast } as never);
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "boom" }, 500)));

    await useGameTrackStore.getState().fetchPlaythroughs(1);

    // The details modal prefetches for games the user may never open. A toast
    // per prefetch would fire on every card click in the library.
    expect(toast).not.toHaveBeenCalled();
  });
});