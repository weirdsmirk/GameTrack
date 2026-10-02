import type { OwnershipStatus } from "./constants";

export interface Game {
  id: number;
  title: string;
  year: number | null;
  igdb_id: number | null;
  genres: string[];
  synopsis: string;
  poster_url: string;
  critic_score: number | null;
  owned_platforms: string[];
  /**
   * Whether this title is in the personal collection. "not_owned" covers games
   * that were played but never held — a friend's console, a shared PC, someone
   * else's copy — and such rows track playtime, rating, status and dates
   * exactly like owned ones. Independent of `owned_platforms`, which records
   * where a title was played/owned and may legitimately be empty for either.
   * Always sent by the API; use `isOwned()` from constants rather than reading
   * it directly so pre-migration payloads still read as owned.
   */
  ownership_status: OwnershipStatus;
  status: "backlog" | "playing" | "completed" | "endless";
  playtime: number; // hours (fractional)
  personal_rating: number | null;
  date_added: number;
  date_completed: number | null;
  created_at: number;
  updated_at: number;
  hide_playtime?: number; // 1 to hide playtime display, 0 or undefined to show
  steam_appid?: number | null;
  custom_order?: number | null; // hand-arranged library position; null = unplaced
  metadata_custom?: number; // 1 when the user edited metadata (title/year/genres/synopsis/score/poster) — Steam sync preserves it
  /**
   * Total playthroughs: the game's own run plus every replay. Always >= 1.
   * Denormalised on the server and refreshed inside the same transaction as any
   * replay change, so a badge can trust it without fetching the runs. Read it
   * through `timesPlayed()` from constants rather than directly, so a payload
   * predating this feature (where the field is absent) still counts as one
   * playthrough instead of reading as zero.
   */
  times_played?: number;
  /** Hours logged across replays only. Playthrough #1 is `playtime`. */
  replay_playtime?: number;
}

/**
 * One playthrough of a game after the first. Runs #2..n live here; the game row
 * itself is run #1 and is never mirrored into this list, so a game's own
 * playtime, status and completion date stay exactly where every existing screen
 * already reads them — which is why adding replays required no change to the
 * status filters, the grid, the duplicate detector or the Steam sync.
 */
export interface Playthrough {
  id: number;
  game_id: number;
  /** Display ordinal — 2 for the first replay. Contiguous by construction. */
  sequence: number;
  status: "backlog" | "playing" | "completed" | "endless";
  playtime: number;
  personal_rating: number | null;
  /** Null both when finished-but-undated and when not finished yet. */
  date_completed: number | null;
  /** Where this run happened. Free text, because a replay is often on a
   *  platform you do not own — hence not constrained to the owned platforms. */
  platform: string | null;
  notes: string;
  created_at: number;
  updated_at: number;
}

export interface LibrarySummary {
  total_games: number;
  active_games: number;
  completed_games: number;
  total_playtime_hours: number;
  average_playtime_per_game: number;
  last_updated: number;
  /**
   * Ownership split of the same registry. `owned_games + not_owned_games ===
   * total_games` and the two playtime figures sum to `total_playtime_hours`, so
   * the split can always be reconciled with the totals beside it.
   */
  owned_games: number;
  not_owned_games: number;
  owned_playtime_hours: number;
  not_owned_playtime_hours: number;
  /**
   * Replay figures. Deliberately reported ALONGSIDE `total_playtime_hours`
   * rather than folded into it: that field has always meant first-playthrough
   * hours and is the numerator behind `average_playtime_per_game`, so widening
   * its meaning silently would inflate an existing stat. The three invariants a
   * view can rely on:
   *
   *   times_played - total_games === replay_runs
   *   total_playtime_hours + replay_playtime_hours === all_playthroughs_hours
   *   replayed_games <= total_games, most_times_played <= times_played
   *
   * Because they reconcile, a screen can label each figure honestly instead of
   * implying the legacy total already accounts for replays.
   */
  times_played: number;
  replayed_games: number;
  most_times_played: number;
  replay_playtime_hours: number;
  replay_runs: number;
  all_playthroughs_hours: number;
}

export interface GenreAnalytics {
  genre: string;
  game_count: number;
  total_playtime: number;
}

export interface NextToPlaySuggestion extends Game {}

export interface IGDBGame {
  igdb_id: number;
  title: string;
  year: number | null;
  genres: string[];
  synopsis: string;
  poster_url: string;
  critic_score: number | null;
  owned_platforms?: string[];
}

export interface DiscoverLists {
  topThisMonth: IGDBGame[];
  bestAllTime: IGDBGame[];
  newReleases: IGDBGame[];
  mostHyped: IGDBGame[];
}

export interface WishlistItem {
  id: number;
  igdb_id: number | null;
  title: string;
  year: number | null;
  genres: string[];
  synopsis: string;
  poster_url: string;
  critic_score: number | null;
  owned_platforms: string[];
  date_added: number;
}

/**
 * Manual (self-entered) wishlist entry — everything IGDBGame carries, except
 * `igdb_id` is optional since hand-typed games were never in the database.
 */
export interface ManualWishlistEntry {
  igdb_id: number | null;
  title: string;
  year: number | null;
  genres?: string[];
  synopsis?: string;
  poster_url?: string;
  critic_score?: number | null;
  owned_platforms?: string[];
}

export interface SteamSettings {
  keySet: boolean;
  profile: string;
  steamId: string | null;
  steamName: string | null;
  avatarUrl: string | null;
  lastSync: number | null;
}

import type { ThemeId } from "./themes";

export interface CustomizationSettings {
  theme: ThemeId;
  libraryColumns: number; // 3, 4, 5, 6, 7
  discoverColumns: number; // 3, 4, 5, 6, 7
  showPlaytimeBadge: boolean;
  showRatingBadge: boolean;
  /**
   * Whether the one-time keyboard-shortcut hint may still be shown. Set false
   * by the hint's own Dismiss, which is permanent; the toggle in Settings puts
   * it back. Server-persisted with the rest of the preferences so clearing the
   * browser cache does not resurrect a hint the reader deliberately closed.
   */
  showShortcutHint: boolean;
}

export interface PlayingConflict {
  currentGame: Game;
  pendingTitle: string;
  onConfirmSwitch: (action: "backlog" | "completed") => Promise<void> | void;
}

