// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import AnalyticsView from "../src/components/AnalyticsView";
import { useGameTrackStore } from "../src/store";

// AnalyticsView reads the real zustand store. Seed it with data shaped like
// the real API response so the recharts branches actually render.
beforeAll(() => {
  useGameTrackStore.setState({
    games: [
      { id: 1, title: "God of War", status: "completed", playtime: 42.5, hide_playtime: 0, date_added: 1786353000000, date_completed: 1786353000000, created_at: 1786353000000, updated_at: 1786353000000, genres: ["Adventure"], igdb_id: 19560, year: 2018, synopsis: "x", poster_url: "", critic_score: 94, owned_platforms: ["pc"], personal_rating: 9 },
      { id: 2, title: "Wallpaper Engine", status: "backlog", playtime: 0.5, hide_playtime: 0, date_added: 1786353000000, date_completed: null, created_at: 1786353000000, updated_at: 1786353000000, genres: [], igdb_id: null, year: null, synopsis: "", poster_url: "", critic_score: null, owned_platforms: ["steam"], personal_rating: null },
      { id: 3, title: "The Witcher 3", status: "playing", playtime: 8, hide_playtime: 0, date_added: 1786353000000, date_completed: null, created_at: 1786353000000, updated_at: 1786353000000, genres: ["RPG"], igdb_id: 1, year: 2015, synopsis: "", poster_url: "", critic_score: 93, owned_platforms: [], personal_rating: null },
    ],
    genreAnalytics: [
      { genre: "Adventure", game_count: 2, total_playtime: 42.5 },
      { genre: "RPG", game_count: 1, total_playtime: 8 },
    ],
    summary: { total_games: 3, active_games: 1, completed_games: 1, total_playtime_hours: 51, average_playtime_per_game: 17, last_updated: Date.now() },
    fetchAnalytics: async () => {},
    setSettingsOpen: () => {},
  });
});

describe("AnalyticsView runtime", () => {
  it("renders cards, charts and lists without crashing", async () => {
    render(<AnalyticsView />);
    expect(await screen.findByRole("heading", { name: "System Analytics" })).toBeTruthy();
    // The telemetry labels are title case in the DOM and uppercased by CSS, so
    // assistive tech is not handed a shouted label. Matched case-insensitively
    // so a casing decision does not break this test.
    expect(screen.getByText(/registry titles/i)).toBeTruthy();
    expect(screen.getByText(/total telemetry hours/i)).toBeTruthy();
    expect(screen.getByText("Genre Telemetry Share")).toBeTruthy();
    expect(screen.getByText("Status Distribution")).toBeTruthy();
    expect(screen.getByText("Most Played Titles")).toBeTruthy();
    expect(screen.getByText("Completed Titles")).toBeTruthy();
    // Note: chart painting can't be asserted in jsdom (no layout engine), but
    // this test proves the view renders without throwing on real-shaped data.
  });
});
