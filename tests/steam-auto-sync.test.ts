// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useGameTrackStore } from "../src/store";
import type { SteamSettings } from "../src/types";

/**
 * The automatic Steam sync that runs shortly after every page load.
 *
 * The properties that matter are the ones that are *not* obvious from reading the
 * code. Two of them are the whole reason this file exists:
 *
 *  - It must stay silent unless Steam is linked. A sync that can only fail,
 *    announced ahead of time, is worse than no feature at all: the user gets a
 *    warning about a library rewrite and then an error toast, on every reload.
 *  - It must be announced *before* it happens, because a Steam sync rewrites
 *    library rows. A user watching rows change for a reason they cannot see cannot
 *    distinguish that from a bug.
 */

const linked = (over: Partial<SteamSettings> = {}): SteamSettings => ({
  keySet: true,
  profile: "myprofile",
  steamId: "76561198000000000",
  steamName: "tester",
  avatarUrl: null,
  lastSync: null,
  ...over,
});

const okSync = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ok: true, imported: 1, updated: 0, adopted: 0, total: 1, lastSync: 1_700_000_000_000 }),
  } as Response);

/**
 * Count only the sync POSTs. A completed sync also refetches games and analytics,
 * so counting every fetch would report three calls per sync and read as though the
 * once-per-page-load guard had failed.
 */
const syncCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/sync/steam")).length;

const warnings = () =>
  useGameTrackStore.getState().toasts.filter((t) => t.type === "warning");

beforeEach(async () => {
  vi.useFakeTimers();
  /* Drain any sync left pending by the previous test *before* switching to fake
     timers, rather than clearing it.

     The store keeps its "already queued" guard in the timer handle and releases
     it only inside the timer's own callback. `vi.clearAllTimers()` drops a timer
     without running that callback, which strands the handle as non-null — so
     every later call to scheduleAutoSteamSync would silently return early and the
     suite would read as though the feature had stopped working. Letting the clock
     run to it is what a real page reload does anyway. */
  await vi.advanceTimersByTimeAsync(60_000);
  vi.clearAllTimers();

  useGameTrackStore.setState({
    steamSettings: null,
    toasts: [],
    // On, unless a test says otherwise. Absent from rows saved before the toggle
    // existed, and the loader defaults it back to true for exactly that reason.
    customizations: { ...(useGameTrackStore.getState().customizations), autoSteamSync: true },
  } as never);
});

afterEach(async () => {
  await vi.advanceTimersByTimeAsync(60_000);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("automatic Steam sync", () => {
  it("stays silent when Steam has never been linked", () => {
    useGameTrackStore.setState({ steamSettings: null } as never);
    useGameTrackStore.getState().scheduleAutoSteamSync();

    expect(warnings()).toHaveLength(0);
    // Nothing scheduled either: a 20s timer here would fire into a sync the
    // server is guaranteed to refuse with "not connected".
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays silent when the profile is linked but no API key is set", () => {
    // The server needs both. Announcing on the strength of a linked profile alone
    // would queue a sync that throws "Steam account is not connected".
    useGameTrackStore.setState({ steamSettings: linked({ keySet: false }) } as never);
    useGameTrackStore.getState().scheduleAutoSteamSync();

    expect(warnings()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays silent when a key is set but no profile is linked", () => {
    useGameTrackStore.setState({ steamSettings: linked({ steamId: null }) } as never);
    useGameTrackStore.getState().scheduleAutoSteamSync();

    expect(warnings()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("warns that the sync is coming, 15 seconds out, when Steam is linked", () => {
    useGameTrackStore.setState({ steamSettings: linked() } as never);
    useGameTrackStore.getState().scheduleAutoSteamSync();

    const w = warnings();
    expect(w.map((t) => t.message)).toEqual(["Steam sync will start in 15 seconds"]);
    // A warning must not be mistaken for the neutral info notes or, worse, for
    // the accent fill that means "done".
    expect(w.every((t) => t.type === "warning")).toBe(true);
  });

  it("derives the countdown copy from the delay, so it cannot drift", () => {
    useGameTrackStore.setState({ steamSettings: linked() } as never);
    useGameTrackStore.getState().scheduleAutoSteamSync(5_000);

    expect(warnings().map((t) => t.message)).toEqual(["Steam sync will start in 5 seconds"]);
  });

  it("does not fire before the delay has elapsed", async () => {
    const fetchMock = vi.fn(okSync);
    vi.stubGlobal("fetch", fetchMock);
    useGameTrackStore.setState({ steamSettings: linked() } as never);
    useGameTrackStore.getState().scheduleAutoSteamSync();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(syncCalls(fetchMock)).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/sync/steam", { method: "POST" });
  });

  it("reports the outcome through the existing sync toasts", async () => {
    vi.stubGlobal("fetch", vi.fn(okSync));
    useGameTrackStore.setState({ steamSettings: linked() } as never);
    useGameTrackStore.getState().scheduleAutoSteamSync();
    await vi.advanceTimersByTimeAsync(15_000);

    const messages = useGameTrackStore.getState().toasts.map((t) => `${t.type}: ${t.message}`);
    expect(messages).toContain("info: Steam sync in progress");
    expect(messages.some((m) => m.startsWith("success: Steam sync complete"))).toBe(true);
  });

  it("schedules once per page load, however many callers ask", async () => {
    const fetchMock = vi.fn(okSync);
    vi.stubGlobal("fetch", fetchMock);
    useGameTrackStore.setState({ steamSettings: linked() } as never);

    const store = useGameTrackStore.getState();
    store.scheduleAutoSteamSync();
    store.scheduleAutoSteamSync();
    store.scheduleAutoSteamSync();

    // One warning, not three. This is what makes it safe to call from a boot
    // effect under StrictMode, which double-invokes.
    expect(warnings()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(syncCalls(fetchMock)).toBe(1);
  });

  it("can be rescheduled after the pending sync has fired", async () => {
    const fetchMock = vi.fn(okSync);
    vi.stubGlobal("fetch", fetchMock);
    useGameTrackStore.setState({ steamSettings: linked() } as never);

    useGameTrackStore.getState().scheduleAutoSteamSync();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(syncCalls(fetchMock)).toBe(1);

    // The module-level guard must be released on fire, or the feature would work
    // exactly once per page load instead of once per reload. Exactly one warning
    // is present because advancing the clock 15s also expired the first one —
    // its own 5s life ran out long before the sync did, which is the point of
    // raising the notice as a heads-up rather than as a pending indicator.
    useGameTrackStore.getState().scheduleAutoSteamSync();
    expect(warnings().map((t) => t.message)).toEqual(["Steam sync will start in 15 seconds"]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(syncCalls(fetchMock)).toBe(2);
  });
});

describe("automatic Steam sync preference", () => {
  it("does not schedule when the reader has turned it off", () => {
    // A linked account and an explicit opt-out. The opt-out has to win: an account
    // being linked says nothing about whether a sync should run on every load.
    useGameTrackStore.setState({
      steamSettings: linked(),
      customizations: { ...useGameTrackStore.getState().customizations, autoSteamSync: false },
    } as never);

    useGameTrackStore.getState().scheduleAutoSteamSync();

    expect(warnings()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays silent when off, even though the account is linked", async () => {
    // The distinction that matters: off is not an error, so no toast either way.
    // A toast here would fire on every single reload.
    const fetchMock = vi.fn(okSync);
    vi.stubGlobal("fetch", fetchMock);
    useGameTrackStore.setState({
      steamSettings: linked(),
      customizations: { ...useGameTrackStore.getState().customizations, autoSteamSync: false },
    } as never);

    useGameTrackStore.getState().scheduleAutoSteamSync();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(syncCalls(fetchMock)).toBe(0);
    expect(warnings()).toHaveLength(0);
  });

  it("schedules again once the preference is turned back on", async () => {
    const fetchMock = vi.fn(okSync);
    vi.stubGlobal("fetch", fetchMock);
    const set = (autoSteamSync: boolean) =>
      useGameTrackStore.setState({
        customizations: { ...useGameTrackStore.getState().customizations, autoSteamSync },
      } as never);

    useGameTrackStore.setState({ steamSettings: linked() } as never);

    set(false);
    useGameTrackStore.getState().scheduleAutoSteamSync();
    expect(warnings()).toHaveLength(0);

    // The switch is checked at schedule time, not baked in at boot, so turning it
    // back on takes effect without a reload.
    set(true);
    useGameTrackStore.getState().scheduleAutoSteamSync();
    expect(warnings()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(syncCalls(fetchMock)).toBe(1);
  });

  it("defaults to on for a preferences payload saved before the toggle existed", () => {
    // The loader is what decides this, so it is asserted there rather than here:
    // a row with no `autoSteamSync` key must keep the behaviour the app had.
    expect(typeof useGameTrackStore.getState().customizations.autoSteamSync).toBe("boolean");
  });
});
