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
}

export interface BackupInfo {
  name: string;
  created_at: number;
  size: number;
}

export interface DuplicateGroup {
  key: string;
  reason: string;
  games: { id: number; title: string; year: number | null; status: string; playtime: number }[];
}

export interface StorageStats {
  dbSize: number;
  walSize: number;
  gameCount: number;
  posterCount: number;
  posterSize: number;
  backupCount: number;
  backupSize: number;
}

export interface BackupSettings {
  enabled: boolean;
  keep: number;
}

export interface PlayingConflict {
  currentGame: Game;
  pendingTitle: string;
  onConfirmSwitch: (action: "backlog" | "completed") => Promise<void> | void;
}

