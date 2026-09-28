// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import AnalyticsView from "../src/components/AnalyticsView";
import { useGameTrackStore } from "../src/store";
import type { Game } from "../src/types";

// AnalyticsView reads the real zustand store. Seed it with data shaped like
// the real API response so the recharts branches actually render.
//
// Completion dates are relative to "now" rather than hardcoded, because the
// chart's window is defined as the six calendar months ending this month. A
// fixed timestamp would silently fall out of that window as time passes and the
// test would start asserting a different thing than it was written for.
const now = new Date();
const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 15).getTime();
const threeYearsAgo = new Date(now.getFullYear() - 3, 4, 10).getTime();

/** A complete, well-typed game with every field overridable, so each fixture
    row states only the thing that row is actually about. */
const game = (over: Partial<Game> = {}): Game => ({
  id: 0, title: "Untitled", status: "backlog", playtime: 0, hide_playtime: 0,
  date_added: 1786353000000, date_completed: null,
  created_at: 1786353000000, updated_at: 1786353000000,
  genres: [], igdb_id: null, year: null, synopsis: "", poster_url: "",
  critic_score: null, owned_platforms: [], personal_rating: null,
  ...over,
});

beforeAll(() => {
  useGameTrackStore.setState({
    games: [
      game({ id: 1, title: "God of War", status: "completed", playtime: 42.5, date_completed: twoMonthsAgo, genres: ["Adventure"], igdb_id: 19560, year: 2018, critic_score: 94, owned_platforms: ["pc"], personal_rating: 9 }),
      game({ id: 2, title: "Wallpaper Engine", status: "backlog", playtime: 0.5, owned_platforms: ["steam"] }),
      game({ id: 3, title: "The Witcher 3", status: "playing", playtime: 8, genres: ["RPG"], igdb_id: 1, year: 2015, critic_score: 93 }),
      // Marked completed but never dated. The chart counts recorded completion
      // dates only, so this must not appear — filing it under "now" would be a
      // guess about when it finished. It is the one case where the chart
      // deliberately totals fewer than the `completedGames` figure.
      game({ id: 4, title: "Hidden Hours", status: "completed", playtime: 900, hide_playtime: 1 }),
      // Dated, but three years back — outside the six-month window, so it must
      // be dropped rather than clamped into the oldest bucket.
      game({ id: 5, title: "Ancient Finish", status: "completed", playtime: 12, date_completed: threeYearsAgo }),
      // The real-world case behind a 7-where-6 bug: dated recently, but sitting
      // in backlog. The server stamps `date_completed` when a title enters
      // completed and never clears it on the way out, so a moved game keeps a
      // stale date. Counting it reported a completion the library does not
      // claim, so a date alone must not qualify.
      game({ id: 6, title: "Stale Date", status: "backlog", playtime: 20, date_completed: Date.now() }),
    ],
    summary: { total_games: 3, active_games: 1, completed_games: 1, total_playtime_hours: 51, average_playtime_per_game: 17, last_updated: Date.now() },
    fetchAnalytics: async () => {},
    setSettingsOpen: () => {},
  });
});

/**
 * The chart's accessible name lists every bucket as "MMM YYYY: n", which makes
 * its whole content assertable in jsdom — where recharts itself paints nothing.
 */
async function readBuckets() {
  const chart = await screen.findByRole("img", { name: /last 6 calendar months/i });
  return [
    ...(chart.getAttribute("aria-label") || "").matchAll(/([A-Z]{3} \d{4}): (\d+)/g),
  ].map((m) => ({
    month: m[1] as string,
    count: Number(m[2]),
  }));
}

/** Synchronous reader, for use inside `waitFor` where an async assertion body
    would be awaited twice. */
const chartTotalNow = () => {
  const label =
    document
      .querySelector('div[role="img"][aria-label*="last 6 calendar months"]')
      ?.getAttribute("aria-label") || "";
  return [...label.matchAll(/[A-Z]{3} \d{4}: (\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
};

describe("AnalyticsView runtime", () => {
  // RTL's automatic cleanup only runs when the suite is configured with
  // `globals`, which this one is not. Without this, the second case finds the
  // first case's still-mounted chart and reports a duplicate match.
  afterEach(() => cleanup());

  it("renders cards, charts and lists without crashing", async () => {
    render(<AnalyticsView />);
    expect(await screen.findByRole("heading", { name: "System Analytics" })).toBeTruthy();
    // The telemetry labels are title case in the DOM and uppercased by CSS, so
    // assistive tech is not handed a shouted label. Matched case-insensitively
    // so a casing decision does not break this test.
    expect(screen.getByText(/registry titles/i)).toBeTruthy();
    expect(screen.getByText(/total playtime/i)).toBeTruthy();
    expect(screen.getByText("Games Completed — Last 6 Months")).toBeTruthy();
    expect(screen.getByText("Status Distribution")).toBeTruthy();
    expect(screen.getByText("Most Played Titles")).toBeTruthy();
    expect(screen.getByText("Completed Titles")).toBeTruthy();
    // Note: chart painting can't be asserted in jsdom (no layout engine), but
    // this test proves the view renders without throwing on real-shaped data.
  });

  it("counts only recorded completion dates, over the six months ending this month", async () => {
    render(<AnalyticsView />);
    const buckets = await readBuckets();

    // Six buckets, always — a month with no completions is still on the axis.
    expect(buckets).toHaveLength(6);
    expect(new Set(buckets.map((b) => b.month)).size).toBe(6);

    // The window ends with the current month, which is included even at zero.
    const currentMonth = new Date().toLocaleDateString("en-US", { month: "short" }).toUpperCase();
    expect(buckets[buckets.length - 1]?.month).toMatch(
      new RegExp(`^${currentMonth} \\d{4}$`)
    );

    // Only God of War qualifies. The other three are excluded for three
    // different reasons: completed but undated, completed but dated outside the
    // window, and dated but not completed.
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1);
    expect(buckets.find((b) => b.count === 1)?.month).toBe(
      new Date(twoMonthsAgo).toLocaleDateString("en-US", { month: "short" }).toUpperCase() +
        ` ${new Date(twoMonthsAgo).getFullYear()}`
    );
  });

  it("re-counts when a completion is added to the store", async () => {
    // The chart must be derived from the store, not snapshotted at mount, or it
    // would need a reload to notice a game being finished. Seeding the store
    // directly proves that without writing to the real library.
    const before = useGameTrackStore.getState().games;
    render(<AnalyticsView />);
    const start = (await readBuckets()).reduce((sum, b) => sum + b.count, 0);

    useGameTrackStore.setState((s) => ({
      games: [
        ...s.games,
        game({ id: 99, title: "Just Finished", status: "completed", date_completed: Date.now() }),
      ],
    }));

    // Deliberately no second `render` call. The view subscribes to the store,
    // so the new `games` array has to reach the chart by itself — which is
    // exactly the behaviour that makes the chart live.
    await waitFor(() =>
      expect(chartTotalNow()).toBe(start + 1)
    );

    useGameTrackStore.setState({ games: before });
  });
});
