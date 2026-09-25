import { create } from "zustand";
import {
  Game, LibrarySummary,
  GenreAnalytics, NextToPlaySuggestion,
  IGDBGame, SteamSettings, DiscoverLists, CustomizationSettings, WishlistItem, ManualWishlistEntry,
  PlayingConflict, PlaytimeEntry
} from "./types";
import { isThemeId, applyTheme, applyThemeWithReboot } from "./themes";
import { Platform, slugifyPlatformLabel, mergeCustomPlatforms, igdbGenreNamesFor } from "./constants";

export interface ToastItem {
  id: number;
  message: string;
  type: "success" | "error" | "info";
  /** Optional secondary line — keeps the title short and scannable. */
  description?: string;
  duration: number;
}

// One auto-dismiss timer per toast, so the queue can pause/resume/dismiss
// individual notifications without affecting the others.
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
const toastDeadlines = new Map<number, number>();
let toastIdCounter = 0;

function scheduleToastDismiss(
  id: number,
  duration: number,
  set: (fn: (state: GameTrackState) => Partial<GameTrackState>) => void
) {
  const deadline = Date.now() + duration;
  toastDeadlines.set(id, deadline);
  toastTimers.set(
    id,
    setTimeout(() => {
      toastTimers.delete(id);
      toastDeadlines.delete(id);
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    }, duration)
  );
}

// Abort the previous /api/discover/search when a new one starts, so stale
// responses can never clobber fresher results.
let searchController: AbortController | null = null;
// Same supersede pattern for the trending feed: a fresh (page-1) fetch —
// genre switch, tab mount, reconnect — aborts whatever is in flight instead
// of being dropped by a busy-guard.
let trendingController: AbortController | null = null;

/** Default cool-down when the API throttles us without a Retry-After header. */
const DISCOVER_COOLDOWN_MS = 15_000;

/**
 * Fixed trending page size. Deliberately NOT derived from the column
 * customization: the setting is re-fetched from the server after boot, and a
 * moving page size makes the cached feed's page math overlap (page 2 requested
 * with a smaller limit re-delivers items page 1 already showed). appendUnique
 * then filters all of them as duplicates, so the grid never grows while
 * hasMoreTrending stays true — "scroll to load more" appeared dead until a
 * hard refresh re-synced the math.
 */
const TRENDING_PAGE_SIZE = 24;

/**
 * How long to wait before touching /api/discover again after a 429. Returns 0
 * when the response was not a throttle. Honours `Retry-After` (seconds).
 */
function discoverCooldownFrom(res: Response): number {
  if (res.status !== 429) return 0;
  const retryAfter = Number.parseInt(res.headers.get("retry-after") || "", 10);
  const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : DISCOVER_COOLDOWN_MS / 1000;
  return Math.min(60, seconds) * 1000;
}

/** Append a page without ever repeating a game already on screen. */
function appendUnique(existing: IGDBGame[], incoming: IGDBGame[]): IGDBGame[] {
  const seen = new Set(existing.map((g) => g.igdb_id ?? g.title));
  const additions = incoming.filter((g) => {
    const key = g.igdb_id ?? g.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...existing, ...additions];
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Extract the server's JSON `{ error }` message for friendlier toasts. */
async function getApiError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") return new Error(body.error);
  } catch { /* not JSON */ }
  return new Error(fallback);
}

// fetchAnalytics silently drops a refresh that arrives while one is in flight
// (e.g. an add/delete during an initial analytics load). Queue the latest
// request and replay it once the current one settles so refreshes are never lost.
let analyticsRefetchQueued = false;

async function syncGameField(id: number, igdbId: number, field: "synopsis" | "poster_url", set: (fn: (state: GameTrackState) => Partial<GameTrackState>) => void) {
  try {
    const res = await fetch(`/api/discover/game/${igdbId}`);
    if (res.ok) {
      const data = await res.json();
      if (data[field]) {
        // Internal provider refresh — must NOT mark the row as user-customized
        // (metadata_custom: 0 tells the PUT handler to leave the flag alone).
        const putRes = await fetch(`/api/games/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: data[field], metadata_custom: 0 }),
        });
        if (!putRes.ok) return null; // don't apply a value the server rejected
        set((state: GameTrackState) => ({
          games: state.games.map((g: Game) => g.id === id ? { ...g, [field]: data[field] } : g),
          selectedGame: state.selectedGame?.id === id ? { ...state.selectedGame, [field]: data[field] } : state.selectedGame,
        }));
        return data[field];
      }
    }
  } catch (err) {
    console.error(`Failed to sync game ${field}:`, err);
  }
  return null;
}

interface GameTrackState {
  activeTab: "dashboard" | "library" | "discover" | "wishlist";
  setActiveTab: (tab: "dashboard" | "library" | "discover" | "wishlist") => void;
  selectedGame: Game | null;
  setSelectedGame: (game: Game | null) => void;
  isAddGameOpen: boolean;
  setAddGameOpen: (open: boolean) => void;
  isSettingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  playingConflict: PlayingConflict | null;
  openPlayingConflict: (conflict: PlayingConflict) => void;
  closePlayingConflict: () => void;

  games: Game[];
  loadingGames: boolean;
  lastGamesFetch: number;
  gamesError: string | null;
  filters: { status: string; platform: string; sort: string; search: string; hideCompleted: boolean; hideEndless: boolean };
  setFilter: (key: "status" | "platform" | "sort" | "search" | "hideCompleted" | "hideEndless", value: string | boolean) => void;
  resetFilters: () => void;
  fetchGames: (force?: boolean) => Promise<void>;
  addGame: (gameData: Partial<Game>) => Promise<boolean>;
  updateGame: (id: number, gameData: Partial<Game>) => Promise<boolean>;
  deleteGame: (id: number) => Promise<boolean>;
  deleteGames: (ids: number[]) => Promise<boolean>;
  updateCustomOrder: (ids: number[]) => Promise<boolean>;
  clearCustomOrder: () => Promise<boolean>;
  syncGameSynopsis: (id: number, igdbId: number) => Promise<string | null>;
  syncGamePoster: (id: number, igdbId: number) => Promise<string | null>;
  resetGamePoster: (id: number) => Promise<string | null>;
  resetGameMetadata: (id: number) => Promise<Game | null>;

  trendingGames: IGDBGame[];
  discoverSearchResults: IGDBGame[];
  discoverQuery: string;
  /** Selected Discover genre filter ("" = all genres). */
  discoverGenre: string;
  /** Genre the currently loaded trending list was fetched with. */
  trendingGenre: string;
  loadingDiscover: boolean;
  discoverError: string | null;
  trendingPage: number;
  searchPage: number;
  hasMoreTrending: boolean;
  hasMoreSearch: boolean;
  /** Epoch ms until which /api/discover must not be called (0 = clear). */
  discoverCooldownUntil: number;
  setDiscoverGenre: (genre: string) => void;
  discoverLists: DiscoverLists | null;
  loadingLists: boolean;
  lastListsFetch: number;
  lastTrendingFetch: number;
  fetchTrending: (loadMore?: boolean) => Promise<void>;
  searchDiscover: (query: string, loadMore?: boolean) => Promise<void>;
  fetchDiscoverLists: () => Promise<void>;
  addGameFromIgdb: (igdbGame: IGDBGame) => Promise<boolean>;

  wishlist: WishlistItem[];
  loadingWishlist: boolean;
  lastWishlistFetch: number;
  fetchWishlist: (force?: boolean) => Promise<void>;
  addToWishlist: (igdbGame: IGDBGame | ManualWishlistEntry) => Promise<boolean>;
  removeFromWishlist: (id: number) => Promise<boolean>;
  removeWishlistItems: (ids: number[], silent?: boolean) => Promise<boolean>;
  ownWishlistItem: (id: number) => Promise<boolean>;

  summary: LibrarySummary | null;
  genreAnalytics: GenreAnalytics[];
  suggestions: NextToPlaySuggestion[];
  recentActivity: Game[];
  loadingAnalytics: boolean;
  lastAnalyticsFetch: number;
  fetchAnalytics: () => Promise<void>;
  fetchSuggestions: () => Promise<void>;

  importLibraryJSON: (jsonData: unknown) => Promise<{ success: boolean; imported?: number; error?: string }>;
  wipeLibrary: () => Promise<boolean>;
  exportLibraryJSON: () => Promise<boolean>;
  exportDatabase: () => Promise<boolean>;
  restoreBackupFile: (file: File) => Promise<boolean>;
  toasts: ToastItem[];
  showToast: (message: string, type?: "success" | "error" | "info", description?: string, duration?: number) => void;
  dismissToast: (id: number) => void;
  pauseToast: (id: number) => void;
  resumeToast: (id: number) => void;

  steamSettings: SteamSettings | null;
  fetchSteamSettings: () => Promise<void>;
  saveSteamSettings: (profile: string) => Promise<boolean>;
  syncSteamLibrary: () => Promise<{ ok: boolean; imported?: number; updated?: number; adopted?: number; total?: number; error?: string } | null>;

  customPlatforms: Platform[];
  fetchCustomPlatforms: () => Promise<void>;
  addCustomPlatform: (label: string) => Promise<boolean>;
  removeCustomPlatform: (id: string) => Promise<boolean>;
  _saveCustomPlatforms: (platforms: Platform[]) => Promise<boolean>;

  gameHistory: PlaytimeEntry[];
  historyGameId: number | null;
  fetchGameHistory: (gameId: number) => Promise<void>;

  searchFocusToken: number;
  requestSearchFocus: () => void;

  isAuthOpen: boolean;
  setAuthOpen: (open: boolean) => void;

  customizations: CustomizationSettings;
  fetchCustomizations: () => Promise<void>;
  updateCustomizations: (partial: Partial<CustomizationSettings>) => void;
}

const TAB_KEY = "gametrack_active_tab";
// Wishlist is a full page but has no sidebar entry (it's opened from the
// Library header), so it must never be restored on reload.
const VALID_TABS = ["dashboard", "library", "discover"] as const;

function getInitialTab(): GameTrackState["activeTab"] {
  const stored = typeof window !== "undefined" && window.localStorage ? localStorage.getItem(TAB_KEY) : null;
  return (VALID_TABS as readonly string[]).includes(stored || "") ? stored as GameTrackState["activeTab"] : "dashboard";
}

const FILTERS_KEY = "gametrack_library_filters";
const DEFAULT_FILTERS = { status: "", platform: "", sort: "recent", search: "", hideCompleted: false, hideEndless: false };

function loadSavedFilters(): GameTrackState["filters"] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FILTERS_KEY) || "");
    return {
      status: typeof parsed.status === "string" ? parsed.status : DEFAULT_FILTERS.status,
      platform: typeof parsed.platform === "string" ? parsed.platform : DEFAULT_FILTERS.platform,
      sort: typeof parsed.sort === "string" ? parsed.sort : DEFAULT_FILTERS.sort,
      search: typeof parsed.search === "string" ? parsed.search : DEFAULT_FILTERS.search,
      hideCompleted: parsed.hideCompleted === true,
      hideEndless: parsed.hideEndless === true,
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

const CUSTOMIZATIONS_KEY = "gametrack_customization_settings";
const DEFAULT_CUSTOMIZATIONS: CustomizationSettings = {
  theme: "noir",
  libraryColumns: 5,
  discoverColumns: 6,
  showPlaytimeBadge: true,
  showRatingBadge: true,
  density: "comfortable",
};

function loadSavedCustomizations(): CustomizationSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOMIZATIONS_KEY) || "");
    return {
      theme: isThemeId(parsed.theme) ? parsed.theme : DEFAULT_CUSTOMIZATIONS.theme,
      libraryColumns: [3, 4, 5, 6, 7].includes(parsed.libraryColumns) ? parsed.libraryColumns : 5,
      discoverColumns: [3, 4, 5, 6, 7].includes(parsed.discoverColumns) ? parsed.discoverColumns : 6,
      showPlaytimeBadge: typeof parsed.showPlaytimeBadge === "boolean" ? parsed.showPlaytimeBadge : true,
      showRatingBadge: typeof parsed.showRatingBadge === "boolean" ? parsed.showRatingBadge : true,
      density: parsed.density === "compact" ? "compact" : "comfortable",
    };
  } catch {
    return DEFAULT_CUSTOMIZATIONS;
  }
}

// Apply the persisted theme before React mounts to avoid a flash of the
// default theme. Safe to run at module scope: this store is client-only.
const initialCustomizations = loadSavedCustomizations();
applyTheme(initialCustomizations.theme);

// Cache the last analytics payload so a reload paints instantly instead of
// flashing loading states while /api/analytics is in flight. Refreshed on
// every successful fetch.
const ANALYTICS_CACHE_KEY = "gametrack_analytics_cache";

function loadCachedAnalytics() {
  try {
    const raw = localStorage.getItem(ANALYTICS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.savedAt !== "number" ||
      typeof parsed.summary?.total_games !== "number" ||
      !Array.isArray(parsed.genreAnalytics) ||
      !Array.isArray(parsed.recentActivity)
    ) {
      return null;
    }
    return parsed as {
      savedAt: number;
      summary: LibrarySummary;
      genreAnalytics: GenreAnalytics[];
      recentActivity: Game[];
    };
  } catch {
    return null;
  }
}

const cachedAnalytics = loadCachedAnalytics();

// Cache the last Discover payload (trending feed + curated lists) so a reload
// paints cards instantly instead of waiting on IGDB round-trips. Refreshed on
// every successful fetch.
const DISCOVER_CACHE_KEY = "gametrack_discover_cache";

function loadCachedDiscover() {
  try {
    const raw = localStorage.getItem(DISCOVER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.savedAt !== "number" ||
      !Array.isArray(parsed.trendingGames) ||
      (parsed.discoverLists !== null && typeof parsed.discoverLists !== "object")
    ) {
      return null;
    }
    // A cache written by a different pagination scheme resumes with the wrong
    // page math (overlapping windows starve appendUnique) — start fresh.
    if (parsed.trendingPageSize !== TRENDING_PAGE_SIZE) return null;
    return parsed as {
      savedAt: number;
      trendingGames: IGDBGame[];
      trendingPage: number;
      hasMoreTrending: boolean;
      trendingPageSize: number;
      // Missing on caches written before genre filtering existed ("" = all).
      trendingGenre?: string;
      discoverLists: DiscoverLists | null;
    };
  } catch {
    return null;
  }
}

const cachedDiscover = loadCachedDiscover();

function saveDiscoverCache(snapshot: {
  savedAt: number;
  trendingGames: IGDBGame[];
  trendingPage: number;
  hasMoreTrending: boolean;
  trendingGenre: string;
  discoverLists: DiscoverLists | null;
}) {
  try {
    localStorage.setItem(DISCOVER_CACHE_KEY, JSON.stringify({
      ...snapshot,
      trendingPageSize: TRENDING_PAGE_SIZE,
    }));
  } catch {
    /* storage full or unavailable — cache is best-effort */
  }
}

export const useGameTrackStore = create<GameTrackState>((set, get) => ({
  activeTab: getInitialTab(),
  setActiveTab: (tab) => {
    if (tab !== "wishlist") {
      if (typeof window !== "undefined" && window.localStorage) localStorage.setItem(TAB_KEY, tab);
    }
    set({ activeTab: tab, selectedGame: null });
  },
  selectedGame: null,
  setSelectedGame: (game) => {
    // Note: synopsis/poster enrichment happens in GameDetailsModal's own
    // effect — firing it here too would double-PATCH the same game on open.
    set({ selectedGame: game });
  },
  isAddGameOpen: false,
  setAddGameOpen: (open) => set({ isAddGameOpen: open }),
  isSettingsOpen: false,
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),
  playingConflict: null,
  openPlayingConflict: (conflict) => set({ playingConflict: conflict }),
  closePlayingConflict: () => set({ playingConflict: null }),

  customizations: initialCustomizations,
  fetchCustomizations: async () => {
    try {
      const res = await fetch("/api/settings/customizations");
      if (!res.ok) return;
      const data = await res.json();
      if (!data || typeof data !== "object") return;
      const next = {
        ...get().customizations,
        ...data,
      } as CustomizationSettings;
      localStorage.setItem(CUSTOMIZATIONS_KEY, JSON.stringify(next));
      set({ customizations: next });
      if (isThemeId(next.theme)) applyTheme(next.theme);
    } catch (err) {
      console.error("Failed to fetch customization settings:", err);
    }
  },
  updateCustomizations: (partial) => {
    const next = { ...get().customizations, ...partial };
    localStorage.setItem(CUSTOMIZATIONS_KEY, JSON.stringify(next));
    set({ customizations: next });
    if (partial.theme && isThemeId(partial.theme)) {
      applyThemeWithReboot(partial.theme);
    }
    void fetch("/api/settings/customizations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).catch((err) => console.error("Failed to persist customization settings:", err));
  },

  games: [],
  loadingGames: false,
  lastGamesFetch: 0,
  gamesError: null,
  filters: loadSavedFilters(),
  setFilter: (key, value) => {
    set((state) => {
      const filters = { ...state.filters, [key]: value };
      try {
        localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
      } catch {
        /* ignore */
      }
      return { filters };
    });
  },
  resetFilters: () => {
    try {
      localStorage.removeItem(FILTERS_KEY);
    } catch {
      /* ignore */
    }
    set({ filters: DEFAULT_FILTERS });
  },

  fetchGames: async (force = false) => {
    // Skip refetches within 60s of the last successful load — Tab switches,
    // boot preloads and component remounts all land on this guard.
    if (!force && get().games.length > 0 && Date.now() - get().lastGamesFetch < 60_000) return;
    set({ loadingGames: true, gamesError: null });
    try {
      const res = await fetch("/api/games");
      if (!res.ok) throw new Error("Failed to fetch games");
      const data = await res.json();
      set({ games: data, lastGamesFetch: Date.now() });
    } catch (err: unknown) {
      set({ gamesError: getErrorMessage(err) || "Error loading games" });
      get().showToast(getErrorMessage(err) || "Error loading games", "error");
    } finally {
      set({ loadingGames: false });
    }
  },

  addGame: async (gameData) => {
    try {
      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gameData),
      });
      if (!res.ok) throw await getApiError(res, "Failed to add game");
      const data = await res.json();

      set((state) => ({ games: [data, ...state.games] }));
      get().fetchAnalytics();
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error adding game", "error");
      return false;
    }
  },

  updateGame: async (id, gameData) => {
    try {
      const res = await fetch(`/api/games/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gameData),
      });
      if (!res.ok) throw await getApiError(res, "Failed to update game");
      const data = await res.json();

      set((state) => ({
        games: state.games.map((g) => (g.id === id ? data : g)),
        selectedGame: state.selectedGame?.id === id ? data : state.selectedGame,
      }));
      get().fetchAnalytics();
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error updating game", "error");
      return false;
    }
  },

  deleteGame: async (id) => {
    try {
      const res = await fetch(`/api/games/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete game");

      set((state) => ({
        games: state.games.filter((g) => g.id !== id),
        selectedGame: state.selectedGame?.id === id ? null : state.selectedGame,
      }));
      get().showToast("Game removed from library", "info");
      get().fetchAnalytics();
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error deleting game", "error");
      return false;
    }
  },

  deleteGames: async (ids) => {
    try {
      const res = await fetch("/api/games/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        if (res.status === 404) {
          let count = 0;
          for (const id of ids) {
            const singleRes = await fetch(`/api/games/${id}`, { method: "DELETE" });
            if (singleRes.ok) count++;
          }
          const idSet = new Set(ids);
          set((state) => ({
            games: state.games.filter((g) => !idSet.has(g.id)),
            selectedGame: state.selectedGame && idSet.has(state.selectedGame.id) ? null : state.selectedGame,
          }));
          get().showToast(`Deleted ${count} ${count === 1 ? "game" : "games"}`, "info");
          get().fetchAnalytics();
          return true;
        }
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Failed to delete games");
      }
      const idSet = new Set(ids);
      set((state) => ({
        games: state.games.filter((g) => !idSet.has(g.id)),
        selectedGame: state.selectedGame && idSet.has(state.selectedGame.id) ? null : state.selectedGame,
      }));
      get().showToast(`Deleted ${ids.length} ${ids.length === 1 ? "game" : "games"}`, "info");
      get().fetchAnalytics();
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error deleting games", "error");
      return false;
    }
  },

  updateCustomOrder: async (ids) => {
    try {
      const res = await fetch("/api/games/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw await getApiError(res, "Failed to save game order");
      const data = await res.json();

      const position = new Map<number, number>(ids.map((id, index) => [id, index]));
      set((state) => ({
        games: data as Game[],
        selectedGame: state.selectedGame?.id != null && position.has(state.selectedGame.id)
          ? { ...state.selectedGame, custom_order: position.get(state.selectedGame.id)! }
          : state.selectedGame,
      }));
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error saving game order", "error");
      return false;
    }
  },

  clearCustomOrder: async () => {
    try {
      const res = await fetch("/api/games/order", { method: "DELETE" });
      if (!res.ok) throw await getApiError(res, "Failed to reset game order");
      const data = await res.json();
      set((state) => ({
        games: data as Game[],
        selectedGame: state.selectedGame?.id != null
          ? { ...state.selectedGame, custom_order: null }
          : state.selectedGame,
      }));
      get().showToast("Custom order reset", "info");
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error resetting game order", "error");
      return false;
    }
  },

  syncGameSynopsis: (id, igdbId) => syncGameField(id, igdbId, "synopsis", set),
  syncGamePoster: (id, igdbId) => syncGameField(id, igdbId, "poster_url", set),

  // Restore the game's default poster: Steam-owned rows go back to the Steam
  // CDN artwork, IGDB-linked rows refetch the IGDB cover, anything else is
  // blanked (the UI renders the curated fallback for empty poster URLs).
  resetGamePoster: async (id) => {
    const game = get().games.find((g) => g.id === id) ??
      (get().selectedGame?.id === id ? get().selectedGame : undefined);
    let poster: string | null;
    if (game?.steam_appid != null) {
      poster = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${game.steam_appid}/library_600x900.jpg`;
    } else if (game?.igdb_id != null) {
      poster = await get().syncGamePoster(id, game.igdb_id);
    } else {
      poster = "";
    }
    if (poster === null) return null; // IGDB fetch failed — keep current poster
    // Steam/blank paths go through updateGame directly; syncGamePoster already
    // persisted + updated the store for the IGDB path.
    if (game?.igdb_id == null || game?.steam_appid != null) {
      const ok = await get().updateGame(id, { poster_url: poster });
      if (!ok) return null;
    }
    return poster;
  },

  // Restore every metadata field (title/year/genres/synopsis/score/poster) to
  // the IGDB defaults — Steam rows get the Steam poster back. User data
  // (status, playtime, rating, platforms) is preserved server-side.
  resetGameMetadata: async (id) => {
    try {
      const res = await fetch(`/api/games/${id}/reset-metadata`, { method: "POST" });
      if (!res.ok) throw await getApiError(res, "Failed to reset metadata");
      const data: Game = await res.json();
      set((state) => ({
        games: state.games.map((g) => (g.id === id ? data : g)),
        selectedGame: state.selectedGame?.id === id ? data : state.selectedGame,
      }));
      get().showToast("Metadata reset to defaults", "success", data.title);
      return data;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Failed to reset metadata", "error");
      return null;
    }
  },

  // ── Discover (IGDB) ───────────────────────────────────────────
  trendingGames: cachedDiscover?.trendingGames ?? [],
  discoverSearchResults: [],
  discoverQuery: "",
  discoverGenre: cachedDiscover?.trendingGenre ?? "",
  trendingGenre: cachedDiscover?.trendingGenre ?? "",
  loadingDiscover: false,
  discoverError: null,
  trendingPage: cachedDiscover?.trendingPage ?? 1,
  searchPage: 1,
  hasMoreTrending: cachedDiscover?.hasMoreTrending ?? true,
  hasMoreSearch: true,
  discoverCooldownUntil: 0,
  discoverLists: cachedDiscover?.discoverLists ?? null,
  loadingLists: false,
  lastListsFetch: cachedDiscover?.savedAt ?? 0,
  lastTrendingFetch: cachedDiscover?.savedAt ?? 0,

  fetchDiscoverLists: async () => {
    if (get().loadingLists) return;
    set({ loadingLists: true });
    try {
      const res = await fetch("/api/discover/lists");
      if (!res.ok) throw new Error("Failed to load curated lists");
      const data = await res.json();
      const ts = Date.now();
      set({ discoverLists: data, lastListsFetch: ts });
      saveDiscoverCache({
        savedAt: ts,
        trendingGames: get().trendingGames,
        trendingPage: get().trendingPage,
        hasMoreTrending: get().hasMoreTrending,
        trendingGenre: get().trendingGenre,
        discoverLists: data,
      });
    } catch (err: unknown) {
      console.error("Failed to load curated lists:", err);
      get().showToast("Could not load curated lists. The registry is temporarily unreachable.", "error");
    } finally {
      set({ loadingLists: false });
    }
  },

  fetchTrending: async (loadMore = false) => {
    // A fresh (page-1) request supersedes whatever is in flight instead of
    // being dropped by a busy-guard — that guard is what deadlocked genre
    // switches (the switch's fetch was discarded while a load-more was
    // running, leaving an empty feed nothing would ever refill).
    if (loadMore && get().loadingDiscover) return;
    // Still cooling down after a 429 — retrying now would only throttle harder.
    if (Date.now() < get().discoverCooldownUntil) return;
    const nextPage = loadMore ? get().trendingPage + 1 : 1;
    if (loadMore && !get().hasMoreTrending) return;

    const genre = get().discoverGenre;

    // Sequence requests: a new page-1 fetch aborts the previous in-flight one
    // so a slow stale response can never overwrite fresher results.
    if (!loadMore) {
      trendingController?.abort();
    }
    const controller = new AbortController();
    trendingController = controller;

    set({ loadingDiscover: true, discoverError: null });
    try {
      // Genre filtering runs server-side over the whole ranked pool, so every
      // page delivered here already matches the active filter. The page size
      // is fixed (see TRENDING_PAGE_SIZE) so cached-feed page math stays valid.
      const genreParam = igdbGenreNamesFor(genre).join(",");
      const res = await fetch(
        `/api/discover/trending?page=${nextPage}&limit=${TRENDING_PAGE_SIZE}` +
        (genreParam ? `&genre=${encodeURIComponent(genreParam)}` : ""),
        { signal: controller.signal }
      );
      const cooldown = discoverCooldownFrom(res);
      if (cooldown) {
        // Park the feed instead of hammering: this is what used to leave the
        // "Loading more games..." spinner running forever without new cards.
        set({ discoverCooldownUntil: Date.now() + cooldown });
        get().showToast("Discover is throttled by the server", "info", "Retrying automatically in a few seconds.");
        return;
      }
      if (!res.ok) throw new Error("Failed to load trending games");
      const data = await res.json();
      const results: IGDBGame[] = Array.isArray(data) ? data : [];

      if (controller.signal.aborted) return; // superseded by a newer fetch
      // The user switched genres while this request was in flight — the
      // response belongs to the old filter, so appending it would mix feeds.
      if (get().discoverGenre !== genre) return;

      const hasMore = results.length > 0 && results.length === TRENDING_PAGE_SIZE;
      set((state) => ({
        trendingGames: loadMore ? appendUnique(state.trendingGames, results) : results,
        trendingPage: nextPage,
        trendingGenre: genre,
        hasMoreTrending: hasMore,
        discoverError: null,
      }));
      saveDiscoverCache({
        savedAt: Date.now(),
        trendingGames: get().trendingGames,
        trendingPage: nextPage,
        hasMoreTrending: hasMore,
        trendingGenre: genre,
        discoverLists: get().discoverLists,
      });
      set({ lastTrendingFetch: Date.now() });
    } catch (err: unknown) {
      if (controller.signal.aborted) return; // superseded — not an error
      console.error(err);
      set({
        discoverError: loadMore ? null : "Could not reach the game registry. The discovery service is temporarily unavailable. Please try again in a moment.",
      });
    } finally {
      if (!controller.signal.aborted) set({ loadingDiscover: false });
    }
  },

  /**
   * Switch the Discover genre filter. The loaded feed is dropped immediately so
   * the grid can never show the previous genre's titles, and page 1 of the new
   * filter is fetched right away (the active search, if any, re-runs from the
   * view because its debounce effect depends on this value). The cooldown is
   * cleared too — a 429 parked against the *previous* filter must not make the
   * new one unscrollable.
   */
  setDiscoverGenre: (genre) => {
    if (get().discoverGenre === genre) return;
    // Abort any in-flight request for the previous genre so its response can
    // neither overwrite the new feed nor keep the loader spinning.
    trendingController?.abort();
    searchController?.abort();
    set({
      discoverGenre: genre,
      trendingGames: [],
      trendingGenre: genre,
      trendingPage: 1,
      hasMoreTrending: true,
      // An active search must not show the previous genre's results while the
      // re-queried page 1 is in flight.
      discoverSearchResults: [],
      discoverQuery: "",
      searchPage: 1,
      hasMoreSearch: true,
      discoverCooldownUntil: 0,
      discoverError: null,
      loadingDiscover: false,
    });
    if (!get().discoverQuery.trim()) void get().fetchTrending(false);
  },

  searchDiscover: async (query, loadMore = false) => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      // Clearing the box aborts any in-flight search and releases the loader.
      searchController?.abort();
      searchController = null;
      set({ discoverSearchResults: [], discoverQuery: "", searchPage: 1, hasMoreSearch: true, discoverError: null, loadingDiscover: false });
      return;
    }
    if (Date.now() < get().discoverCooldownUntil) return;
    const nextPage = loadMore ? get().searchPage + 1 : 1;
    if (loadMore && !get().hasMoreSearch) return;

    // Sequence requests: a new search aborts the previous in-flight one so a
    // slow stale response can never overwrite fresher results.
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;

    set({ loadingDiscover: true, discoverError: null });
    try {
      // Genre filtering happens server-side against the whole search pool, so
      // results never shrink to a handful of matches in the loaded window.
      const genreParam = igdbGenreNamesFor(get().discoverGenre).join(",");
      const res = await fetch(
        `/api/discover/search?q=${encodeURIComponent(trimmedQuery)}&page=${nextPage}` +
        (genreParam ? `&genre=${encodeURIComponent(genreParam)}` : ""),
        { signal: controller.signal }
      );
      const cooldown = discoverCooldownFrom(res);
      if (cooldown) {
        set({ discoverCooldownUntil: Date.now() + cooldown });
        return;
      }
      if (!res.ok) throw new Error("Failed to search games");
      const data = await res.json();
      const results: IGDBGame[] = Array.isArray(data) ? data : [];

      if (controller.signal.aborted) return; // superseded by a newer search
      set((state) => ({
        discoverSearchResults: loadMore ? appendUnique(state.discoverSearchResults, results) : results,
        discoverQuery: trimmedQuery,
        searchPage: nextPage,
        // An empty page is the only reliable end marker: the search pool is
        // filtered by genre server-side, so a filtered search often returns
        // fewer than a full page — an exact-equality check against the full
        // page size prematurely ended the feed ("End" right after page 1).
        hasMoreSearch: results.length > 0,
        discoverError: null,
      }));
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      get().showToast(getErrorMessage(err) || "Error searching games", "error");
      set({
        discoverError: loadMore
          ? null
          : "Search failed — the game registry is temporarily unreachable. Please try again in a moment.",
      });
    } finally {
      if (!controller.signal.aborted) set({ loadingDiscover: false });
    }
  },

  addGameFromIgdb: async (igdbGame) => {
    try {
      // Fetch full details from IGDB and merge everything so library entries
      // have the same rich metadata as the library page details modal
      let merged = igdbGame;
      if (igdbGame.igdb_id) {
        try {
          const detailRes = await fetch(`/api/discover/game/${igdbGame.igdb_id}`);
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            merged = { ...igdbGame, ...detailData };
          }
        } catch (e) {
          console.error("Failed to fetch full game details:", e);
        }
      }

      // Check for duplicates
      const existingGame = get().games.find(
        (g) => g.igdb_id === igdbGame.igdb_id || 
               (g.title.toLowerCase() === igdbGame.title.toLowerCase() && !g.igdb_id)
      );
      if (existingGame) {
        throw new Error("This game already exists in your library.");
      }

      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: merged.title,
          year: merged.year,
          igdb_id: merged.igdb_id,
          genres: merged.genres || [],
          synopsis: merged.synopsis || "",
          poster_url: merged.poster_url || "",
          critic_score: merged.critic_score,
          owned_platforms: merged.owned_platforms || [],
          status: "backlog",
          playtime: 0,
          personal_rating: null,
        }),
      });
      if (!res.ok) throw await getApiError(res, "Failed to add game");
      const data = await res.json();

      get().showToast("Added to backlog", "success", data.title);
      set((state) => ({ games: [data, ...state.games] }));
      // Adding to the library should retire the wishlist entry for the same
      // game, if one exists — keeps the two lists from drifting apart.
      const wishlistDup = get().wishlist.find((w) => w.igdb_id === igdbGame.igdb_id);
      if (wishlistDup) {
        await get().removeWishlistItems([wishlistDup.id], true);
      }
      get().fetchAnalytics();
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error adding game", "error");
      return false;
    }
  },

  // ── Wishlist ────────────────────────────────────────────────────
  wishlist: [],
  loadingWishlist: false,
  lastWishlistFetch: 0,

  fetchWishlist: async (force = false) => {
    if (!force && get().wishlist.length > 0 && Date.now() - get().lastWishlistFetch < 60_000) return;
    set({ loadingWishlist: true });
    try {
      const res = await fetch("/api/wishlist");
      if (!res.ok) throw new Error("Failed to fetch wishlist");
      const data = await res.json();
      set({ wishlist: data, lastWishlistFetch: Date.now() });
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error loading wishlist", "error");
    } finally {
      set({ loadingWishlist: false });
    }
  },

  addToWishlist: async (igdbGame: IGDBGame | ManualWishlistEntry) => {
    try {
      // Merge full IGDB details so entries carry the same rich metadata as
      // library rows (poster, synopsis, critic score, platforms). Every
      // IGDB-sourced payload (search/trending/lists/detail) is already fully
      // normalized, so only enrich when a caller passes a partial object.
      let merged = igdbGame;
      const needsEnrichment =
        igdbGame.igdb_id != null && (!igdbGame.synopsis || !igdbGame.poster_url);
      if (needsEnrichment) {
        try {
          const detailRes = await fetch(`/api/discover/game/${igdbGame.igdb_id}`);
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            merged = { ...igdbGame, ...detailData };
          }
        } catch (e) {
          console.error("Failed to fetch full game details:", e);
        }
      }

      const res = await fetch("/api/wishlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: merged.title,
          year: merged.year,
          igdb_id: merged.igdb_id,
          genres: merged.genres || [],
          synopsis: merged.synopsis || "",
          poster_url: merged.poster_url || "",
          critic_score: merged.critic_score,
          owned_platforms: merged.owned_platforms || [],
        }),
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Already in wishlist or library");
      }
      if (!res.ok) throw new Error("Failed to add to wishlist");
      const item = await res.json();

      get().showToast("Added to wishlist", "success", item.title);
      set((state) => ({ wishlist: [item, ...state.wishlist] }));
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error adding to wishlist", "error");
      return false;
    }
  },

  removeFromWishlist: async (id) => {
    try {
      const res = await fetch(`/api/wishlist/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Failed to remove from wishlist");
      }
      set((state) => ({ wishlist: state.wishlist.filter((item) => item.id !== id) }));
      get().showToast("Removed from wishlist", "info");
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error removing from wishlist", "error");
      return false;
    }
  },

  removeWishlistItems: async (ids, silent = false) => {
    try {
      const res = await fetch("/api/wishlist/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        if (res.status === 404) {
          let count = 0;
          for (const id of ids) {
            const singleRes = await fetch(`/api/wishlist/${id}`, { method: "DELETE" });
            if (singleRes.ok) count++;
          }
          const idSet = new Set(ids);
          set((state) => ({
            wishlist: state.wishlist.filter((item) => !idSet.has(item.id)),
          }));
          if (!silent) get().showToast(`Removed ${count} ${count === 1 ? "item" : "items"} from wishlist`, "info");
          return true;
        }
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Failed to remove wishlist items");
      }
      const idSet = new Set(ids);
      set((state) => ({
        wishlist: state.wishlist.filter((item) => !idSet.has(item.id)),
      }));
      if (!silent) get().showToast(`Removed ${ids.length} ${ids.length === 1 ? "item" : "items"} from wishlist`, "info");
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error removing wishlist items", "error");
      return false;
    }
  },

  ownWishlistItem: async (id) => {
    try {
      const res = await fetch(`/api/wishlist/${id}/own`, { method: "POST" });
      if (res.status === 409) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Already in your library");
      }
      if (!res.ok) throw new Error("Failed to move game to library");
      const data = await res.json();

      set((state) => ({
        games: [data.game, ...state.games],
        wishlist: state.wishlist.filter((item) => item.id !== id),
      }));
      get().fetchAnalytics();
      get().showToast("Added to backlog", "success", data.game.title);
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error moving game to library", "error");
      return false;
    }
  },

  // ── Analytics ──────────────────────────────────────────────────
  summary: cachedAnalytics?.summary ?? null,
  genreAnalytics: cachedAnalytics?.genreAnalytics ?? [],
  suggestions: [],
  recentActivity: cachedAnalytics?.recentActivity ?? [],
  loadingAnalytics: false,
  lastAnalyticsFetch: cachedAnalytics?.savedAt ?? 0,

  fetchAnalytics: async () => {
    if (get().loadingAnalytics) {
      analyticsRefetchQueued = true;
      return;
    }
    set({ loadingAnalytics: true });
    try {
      const res = await fetch("/api/analytics");
      if (!res.ok) throw new Error("Failed to fetch analytics");
      const data = await res.json();
      const ts = Date.now();

      set({
        summary: data.summary,
        genreAnalytics: data.genreAnalytics,
        recentActivity: data.recentActivity,
        lastAnalyticsFetch: ts,
      });

      try {
        localStorage.setItem(ANALYTICS_CACHE_KEY, JSON.stringify({
          savedAt: ts,
          summary: data.summary,
          genreAnalytics: data.genreAnalytics,
          recentActivity: data.recentActivity,
        }));
      } catch {
        /* storage full or unavailable — cache is best-effort */
      }
    } catch (err: unknown) {
      console.error("Failed to load analytics:", err);
      get().showToast("Failed to load analytics. Please try again in a moment.", "error");
    } finally {
      set({ loadingAnalytics: false });
      if (analyticsRefetchQueued) {
        analyticsRefetchQueued = false;
        get().fetchAnalytics();
      }
    }
  },

  fetchSuggestions: async () => {
    try {
      const games = get().games;

      let candidates = games.filter((g) => {
        if (g.status !== "backlog") return false;
        const genres = Array.isArray(g.genres) ? g.genres : [];
        const hasExcluded = genres.some((genre) => {
          const lower = genre.toLowerCase();
          return lower.includes("multiplayer") || lower.includes("endless") || lower.includes("co-op") || lower === "mmo" || lower === "massively multiplayer";
        });
        return !hasExcluded;
      });

      if (candidates.length === 0) {
        candidates = games.filter((g) => g.status === "backlog");
      }

      if (candidates.length === 0) {
        candidates = games;
      }

      const shuffled = [...candidates];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = shuffled[i]!;
        shuffled[i] = shuffled[j]!;
        shuffled[j] = temp;
      }
      // Three at a time: the dashboard renders them as a poster row, so the
      // row is filled rather than padded with placeholders.
      const selected = shuffled.slice(0, 3);

      set({ suggestions: selected });
    } catch (err: unknown) {
      console.error("Failed to fetch suggestions:", err);
    }
  },

  // ── Import / Export ────────────────────────────────────────────
  importLibraryJSON: async (jsonData: unknown) => {
    try {
      // Accept either a bare array of games or a `{ games: [...] }` backup wrapper.
      const obj = jsonData as Record<string, unknown> | unknown[];
      const rawGames = Array.isArray(obj)
        ? obj
        : (Array.isArray((obj as Record<string, unknown>)?.games) ? (obj as Record<string, unknown>).games as unknown[] : []);
      if (!rawGames.length) throw new Error("No games found in JSON");

      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ games: rawGames }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Import failed");

      let desc = `${result.imported} games added`;
      if (result.duplicates > 0) desc += ` · ${result.duplicates} duplicates skipped`;
      else if (result.skipped > 0) desc += ` · ${result.skipped} skipped`;
      get().showToast("Library import complete", "success", desc);
      get().fetchGames(true);
      get().fetchAnalytics();
      return { success: true, imported: result.imported };
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      get().showToast(msg || "Library import failed", "error");
      return { success: false, error: msg };
    }
  },

  wipeLibrary: async () => {
    try {
      const res = await fetch("/api/wipe", { method: "DELETE" });
      if (!res.ok) throw new Error("Wipe failed");

      // Drop cached analytics/discover snapshots so stale data from the wiped
      // library can't resurface afterwards (or leak into a fresh library).
      if (typeof window !== "undefined" && window.localStorage) {
        localStorage.removeItem(ANALYTICS_CACHE_KEY);
        localStorage.removeItem(DISCOVER_CACHE_KEY);
      }

      set({ games: [], selectedGame: null, suggestions: [] });
      get().showToast("Library wiped", "success", "All local data cleared");
      get().fetchAnalytics();
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Wipe failed", "error");
      return false;
    }
  },

  exportLibraryJSON: async () => {
    try {
      const res = await fetch("/api/export");
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gametrack-library-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      get().showToast("Library exported", "success", "Backup saved to downloads");
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Library export failed", "error");
      return false;
    }
  },

  // Download the raw SQLite database file — a byte-exact, consistent snapshot
  // (server runs a WAL-aware online backup), for full-fidelity backups.
  exportDatabase: async () => {
    try {
      const res = await fetch("/api/export/db");
      if (!res.ok) throw await getApiError(res, "Database export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gametrack-backup-${new Date().toISOString().slice(0, 10)}.db`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      get().showToast("Database downloaded", "success", "Backup saved to downloads");
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Database export failed", "error");
      return false;
    }
  },

  // Restore a raw SQLite database file picked by the user (the counterpart to
  // exportDatabase). The server swaps it in atomically after taking a safety
  // backup of the current state.
  restoreBackupFile: async (file) => {
    try {
      const res = await fetch("/api/backups/restore-file", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) throw await getApiError(res, "Restore failed");
      // Library identity changed wholesale — refresh everything from scratch.
      await get().fetchGames(true);
      await get().fetchAnalytics();
      await get().fetchWishlist(true);
      await get().fetchCustomPlatforms();
      get().showToast("Database restored", "success", file.name);
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Error restoring database", "error");
      return false;
    }
  },

  // ── Toasts (queue) ─────────────────────────────────────────────
  toasts: [],
  showToast: (message, type = "info", description, duration) => {
    const id = ++toastIdCounter;
    const ms = duration ?? (type === "error" ? 6000 : type === "info" ? 3500 : 4000);
    set((state) => ({ toasts: [...state.toasts, { id, message, type, description, duration: ms }] }));
    scheduleToastDismiss(id, ms, set);
  },
  dismissToast: (id) => {
    toastTimers.delete(id);
    toastDeadlines.delete(id);
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
  pauseToast: (id) => {
    const timer = toastTimers.get(id);
    const deadline = toastDeadlines.get(id);
    if (!timer || deadline === undefined) return;
    clearTimeout(timer);
    toastTimers.delete(id);
    toastDeadlines.set(id, Math.max(0, deadline - Date.now()));
  },
  resumeToast: (id) => {
    const remaining = toastDeadlines.get(id);
    if (remaining === undefined || remaining <= 0 || toastTimers.has(id)) return;
    scheduleToastDismiss(id, remaining, set);
  },

  // ── Steam Sync ────────────────────────────────────────────────
  steamSettings: null,

  fetchSteamSettings: async () => {
    try {
      const res = await fetch("/api/settings/steam");
      if (!res.ok) throw new Error("Failed to fetch Steam settings");
      const data = await res.json();
      set({ steamSettings: data });
    } catch (err) {
      console.error("Failed to fetch Steam settings:", err);
    }
  },

  saveSteamSettings: async (profile) => {
    try {
      const res = await fetch("/api/settings/steam", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || "Failed to connect Steam account");
      }
      const data = await res.json();
      set({ steamSettings: data });
      get().showToast("Steam linked", "success", data.steamName || "connected");
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Failed to connect Steam", "error");
      return false;
    }
  },

  syncSteamLibrary: async () => {
    try {
      const res = await fetch("/api/sync/steam", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Steam sync failed");
      }
      set((state) => ({
        steamSettings: state.steamSettings ? { ...state.steamSettings, lastSync: data.lastSync } : state.steamSettings,
      }));
      get().showToast(
        "Steam sync complete",
        "success",
        `${data.imported} imported · ${data.adopted} adopted · ${data.updated} updated`
      );
      get().fetchGames(true);
      get().fetchAnalytics();
      return { ok: true, imported: data.imported, updated: data.updated, adopted: data.adopted, total: data.total };
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      get().showToast(msg || "Steam sync failed", "error");
      return { ok: false, error: msg };
    }
  },

  // ── Custom Platform Tags ─────────────────────────────────────
  customPlatforms: [],

  fetchCustomPlatforms: async () => {
    try {
      const res = await fetch("/api/settings/platforms");
      if (!res.ok) throw new Error("Failed to fetch custom platforms");
      const data = await res.json();
      set({ customPlatforms: Array.isArray(data.platforms) ? data.platforms : [] });
    } catch (err) {
      console.error("Failed to fetch custom platforms:", err);
    }
  },

  _saveCustomPlatforms: async (platforms: Platform[]) => {
    try {
      const res = await fetch("/api/settings/platforms", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platforms }),
      });
      if (!res.ok) throw new Error("Failed to save custom platforms");
      const data = await res.json();
      set({ customPlatforms: Array.isArray(data.platforms) ? data.platforms : [] });
      return true;
    } catch (err: unknown) {
      get().showToast(getErrorMessage(err) || "Failed to save custom platforms", "error");
      return false;
    }
  },

  addCustomPlatform: async (label) => {
    const trimmed = label.trim();
    if (!trimmed) {
      get().showToast("Tag label is required", "error");
      return false;
    }
    const effective = mergeCustomPlatforms(get().customPlatforms);
    if (effective.some((p) => p.label.toLowerCase() === trimmed.toLowerCase())) {
      get().showToast("That platform tag already exists", "error");
      return false;
    }
    if (get().customPlatforms.length >= 20) {
      get().showToast("Custom tags are capped at 20", "error");
      return false;
    }
    const slug = slugifyPlatformLabel(trimmed);
    if (!slug) {
      get().showToast("Tag label must contain letters or numbers", "error");
      return false;
    }
    const next = [...get().customPlatforms, { id: slug, label: trimmed }];
    const ok = await get()._saveCustomPlatforms(next);
    if (ok) get().showToast("Platform tag added", "success", trimmed);
    return ok;
  },

  removeCustomPlatform: async (id) => {
    const next = get().customPlatforms.filter((p) => p.id !== id);
    const ok = await get()._saveCustomPlatforms(next);
    if (ok) get().showToast("Platform tag removed", "info");
    return ok;
  },

  // ── Playtime history ────────────────────────────────────────
  gameHistory: [],
  historyGameId: null,
  fetchGameHistory: async (gameId) => {
    try {
      const res = await fetch(`/api/games/${gameId}/playtime`);
      if (!res.ok) return;
      const data = await res.json();
      set({ gameHistory: Array.isArray(data.entries) ? data.entries : [], historyGameId: gameId });
    } catch (err) {
      console.error("Failed to fetch playtime history:", err);
    }
  },

  // ── Search focus ─────────────────────────────────────────────
  searchFocusToken: 0,
  requestSearchFocus: () => set((state) => ({ searchFocusToken: state.searchFocusToken + 1 })),

  // ── Local Auth (cosmetic) ────────────────────────────────────
  isAuthOpen: false,
  setAuthOpen: (open) => set({ isAuthOpen: open }),
}));
