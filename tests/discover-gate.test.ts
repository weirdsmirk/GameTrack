// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useGameTrackStore } from "../src/store";
import type { IGDBGame } from "../src/types";

/**
 * The gate that reveals the Discover page.
 *
 * This is here because that gate has now broken twice, both times silently.
 *
 * 1. It required `trendingGames.length > 0`, which cannot tell an empty result
 *    apart from a request still in flight. Since IGDB credentials are OPTIONAL
 *    here, a fresh install settles on an empty feed — and a failed request settles
 *    empty too. Either way the user got "Loading page" for the rest of the
 *    session, with no error and no way out but a reload.
 *
 * 2. The replacement, `!hasMoreTrending`, was worse, because that flag means
 *    "is there another page", not "did the request finish". It is `true` before
 *    the first request and is only ever cleared by a request that *succeeds* with
 *    a short or empty page. So the ordinary case — a full first page of 24
 *    results — left it `true`, the gate shut, and Discover never opened even
 *    though the data arrived perfectly. Every failure path (429, network error,
 *    abort) left it `true` too, and because the view carrying the error message
 *    was itself never rendered, the user got a bare spinner instead of the error
 *    explaining it.
 *
 * The fix is `trendingSettled`, set by every terminal path of `fetchTrending`.
 * These tests pin that invariant: whatever the response, the request finishing is
 * never inferred from a field about pagination.
 */

const PAGE_SIZE = 24;

const igdbGame = (n: number): IGDBGame => ({
  igdb_id: n,
  title: `Game ${n}`,
  year: 2020,
  genres: ["Action"],
  synopsis: "",
  poster_url: "",
  critic_score: null,
});

/** Mirror of the `discover` case of App's page gate. Keep in step with App.tsx. */
const gateOpen = () => {
  const s = useGameTrackStore.getState();
  return !s.loadingLists && !s.loadingDiscover && s.trendingSettled;
};

/**
 * The gate as it was written before `trendingSettled` existed: `!hasMoreTrending`.
 * Kept here only so the reason for the replacement is asserted rather than
 * remembered — see the full-page test.
 */
const paginationFlagGate = () => !useGameTrackStore.getState().hasMoreTrending;

const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response);

beforeEach(() => {
  // No localStorage reset needed: vitest's jsdom does not expose one, and the
  // store guards every touch, so the discover cache is simply absent. That is
  // the first-visit state these tests want anyway.
  useGameTrackStore.setState({
    trendingGames: [],
    trendingPage: 1,
    hasMoreTrending: true,
    trendingSettled: false,
    trendingGenre: "All",
    discoverGenre: "All",
    discoverError: null,
    discoverCooldownUntil: 0,
    discoverQuery: "",
    hasMoreSearch: true,
    loadingLists: false,
    loadingDiscover: false,
    loadingTrending: false,
    loadingSearch: false,
    showToast: vi.fn(),
  } as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Discover page gate", () => {
  it("opens on a full first page, which is the case the previous gate never passed", async () => {
    // 24 results === exactly one page, so the store records "there is more" and
    // the old `!hasMoreTrending` gate evaluated false here. This is the common
    // case, not an edge case, which is why the page appeared broken to everyone.
    const fetchMock = respond(Array.from({ length: PAGE_SIZE }, (_, i) => igdbGame(i + 1)));
    vi.stubGlobal("fetch", fetchMock);

    await useGameTrackStore.getState().fetchTrending();

    const s = useGameTrackStore.getState();
    expect(s.trendingGames).toHaveLength(PAGE_SIZE);
    expect(s.hasMoreTrending).toBe(true);
    expect(s.trendingSettled).toBe(true);
    expect(gateOpen()).toBe(true);

    // The root cause, asserted rather than left in a comment: the replaced gate
    // was false here. Data arrived, the page stayed behind a spinner anyway —
    // and because a full first page is the *normal* case, not an edge case, this
    // is why Discover looked broken to everyone rather than to someone with an
    // unusual dataset. If this ever becomes true, the old gate would have been
    // fine and the reasoning in the note above is wrong.
    expect(paginationFlagGate()).toBe(false);
  });

  it("opens on a short page", async () => {
    vi.stubGlobal("fetch", respond([igdbGame(1), igdbGame(2), igdbGame(3)]));
    await useGameTrackStore.getState().fetchTrending();

    const s = useGameTrackStore.getState();
    expect(s.hasMoreTrending).toBe(false);
    expect(s.trendingSettled).toBe(true);
    expect(gateOpen()).toBe(true);
  });

  it("opens on an empty result — unconfigured IGDB is a settled answer, not a pending one", async () => {
    vi.stubGlobal("fetch", respond([]));
    await useGameTrackStore.getState().fetchTrending();

    const s = useGameTrackStore.getState();
    expect(s.trendingGames).toHaveLength(0);
    expect(s.hasMoreTrending).toBe(false);
    expect(s.trendingSettled).toBe(true);
    expect(gateOpen()).toBe(true);
  });

  it("opens on a 429, parking the feed instead of hammering it", async () => {
    vi.stubGlobal("fetch", respond(null, 429, { "retry-after": "30" }));
    await useGameTrackStore.getState().fetchTrending();

    const s = useGameTrackStore.getState();
    expect(s.discoverCooldownUntil).toBeGreaterThan(Date.now());
    expect(s.discoverError).toBeNull();
    expect(s.trendingSettled).toBe(true);
    expect(gateOpen()).toBe(true);
  });

  it("opens on a server error, and reports it so the view can offer a retry", async () => {
    vi.stubGlobal("fetch", respond(null, 500));
    await useGameTrackStore.getState().fetchTrending();

    const s = useGameTrackStore.getState();
    expect(s.discoverError).toMatch(/temporarily unavailable/i);
    // This is the pair that matters: the gate opening is the only reason the
    // error text can ever be seen, since it lives in the view that was gated.
    expect(s.trendingSettled).toBe(true);
    expect(gateOpen()).toBe(true);
  });

  it("opens on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await useGameTrackStore.getState().fetchTrending();

    const s = useGameTrackStore.getState();
    expect(s.discoverError).toMatch(/temporarily unavailable/i);
    expect(s.trendingSettled).toBe(true);
    expect(gateOpen()).toBe(true);
  });

  it("reopens the gate if a fresh fetch fails after a good one", async () => {
    vi.stubGlobal("fetch", respond(Array.from({ length: PAGE_SIZE }, (_, i) => igdbGame(i + 1))));
    await useGameTrackStore.getState().fetchTrending();
    expect(gateOpen()).toBe(true);

    vi.stubGlobal("fetch", respond(null, 500));
    await useGameTrackStore.getState().fetchTrending();

    const s = useGameTrackStore.getState();
    // The previously loaded feed must survive the failure — showing an empty page
    // because a refresh failed would destroy work the user can still read.
    expect(s.trendingGames).toHaveLength(PAGE_SIZE);
    expect(s.trendingSettled).toBe(true);
    expect(gateOpen()).toBe(true);
  });

  it("closes the gate while a fresh fetch is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => (release = r));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => pending));

    const inFlight = useGameTrackStore.getState().fetchTrending();
    expect(gateOpen()).toBe(false);

    release({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve([igdbGame(1)]),
    });
    await inFlight;
    expect(gateOpen()).toBe(true);
  });

  it("does not re-close the gate on load-more, which would slam the loader up mid-scroll", async () => {
    vi.stubGlobal("fetch", respond(Array.from({ length: PAGE_SIZE }, (_, i) => igdbGame(i + 1))));
    await useGameTrackStore.getState().fetchTrending();
    expect(gateOpen()).toBe(true);

    // A load-more over an already-visible feed must leave the view alone. If
    // this reset the flag, the whole page would flip back to "Loading page" every
    // time the user scrolled to the bottom.
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => (release = r));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => pending));
    const loadMore = useGameTrackStore.getState().fetchTrending(true);

    expect(useGameTrackStore.getState().trendingSettled).toBe(true);
    release({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(Array.from({ length: PAGE_SIZE }, (_, i) => igdbGame(100 + i))),
    });
    await loadMore;

    const s = useGameTrackStore.getState();
    expect(s.trendingGames).toHaveLength(PAGE_SIZE * 2);
    expect(gateOpen()).toBe(true);
  });

  it("re-closes the gate on a genre switch, so the new filter never shows the old feed", async () => {
    vi.stubGlobal("fetch", respond(Array.from({ length: PAGE_SIZE }, (_, i) => igdbGame(i + 1))));
    await useGameTrackStore.getState().fetchTrending();
    expect(gateOpen()).toBe(true);

    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => (release = r));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => pending));
    useGameTrackStore.getState().setDiscoverGenre("RPG");

    expect(gateOpen()).toBe(false);
    release({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve([igdbGame(1)]),
    });
    await new Promise((r) => setTimeout(r, 0));

    const s = useGameTrackStore.getState();
    expect(s.discoverGenre).toBe("RPG");
    expect(s.trendingGenre).toBe("RPG");
    expect(gateOpen()).toBe(true);
  });
});
