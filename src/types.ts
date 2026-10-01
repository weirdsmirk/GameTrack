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

export interface DuplicateGroup {
  key: string;
  reason: string;
  games: { id: number; title: string; year: number | null; status: string; playtime: number }[];
}

export interface PlayingConflict {
  currentGame: Game;
  pendingTitle: string;
  onConfirmSwitch: (action: "backlog" | "completed") => Promise<void> | void;
}

