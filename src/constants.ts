export interface Platform {
  id: string;
  label: string;
}

export const AVAILABLE_PLATFORMS: Platform[] = [
  { id: "steam", label: "Steam" },
  { id: "epic-games", label: "Epic Games" },
  { id: "playstation", label: "PlayStation" },
  { id: "xbox", label: "Xbox" },
  { id: "nintendo", label: "Nintendo" },
  { id: "gog", label: "GOG" },
  { id: "ea-play", label: "EA Play" },
  { id: "rockstar", label: "Rockstar Games" }
];

/** User-defined platform tags (label → slug id), e.g. "Ubisoft Connect" → "ubisoft-connect". */
export function slugifyPlatformLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** Built-in platforms plus the user's custom tags, with collisions filtered out. */
export function mergeCustomPlatforms(custom: Platform[] | null | undefined): Platform[] {
  if (!custom || custom.length === 0) return AVAILABLE_PLATFORMS;
  const defaults = new Set(AVAILABLE_PLATFORMS.map((p) => p.id.toLowerCase()));
  const seen = new Set<string>();
  const merged: Platform[] = [...AVAILABLE_PLATFORMS];
  for (const p of custom) {
    if (!p || !p.id || !p.label) continue;
    const id = p.id.toLowerCase();
    if (defaults.has(id) || seen.has(id)) continue;
    const labelCollides = AVAILABLE_PLATFORMS.some((d) => d.label.toLowerCase() === p.label.toLowerCase());
    if (labelCollides) continue;
    seen.add(id);
    merged.push({ id: p.id, label: p.label });
  }
  return merged;
}

export const FALLBACK_POSTER_URL = "https://images.unsplash.com/photo-1550745165-9bc0b252726f?q=80&w=300&auto=format&fit=crop";

/** Case-insensitive + label-alias platform matching ("Steam" == "steam"). */
export function platformIdMatches(id: string, gamePlatform: string): boolean {
  const a = id.toLowerCase();
  const b = gamePlatform.toLowerCase();
  if (a === b) return true;
  const label = AVAILABLE_PLATFORMS.find((p) => p.id === id)?.label;
  return Boolean(label && label.toLowerCase() === b);
}

/**
 * Shared responsive grid template for the poster-card views (Library,
 * Discover and Wishlist all render the same card shape), keyed by the
 * column-count customization setting.
 */
export function libraryGridClass(cols: number): string {
  switch (cols) {
    case 3:
      return "grid-cols-1 sm:grid-cols-2 md:grid-cols-3";
    case 4:
      return "grid-cols-2 sm:grid-cols-3 md:grid-cols-4";
    case 5:
      return "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5";
    case 7:
      return "grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-7";
    case 6:
    default:
      return "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6";
  }
}

/**
 * Alias map: IGDB platform slugs and store names → canonical app
 * platform ids. The app's platform model is store-centric (Steam, GOG, ...),
 * so generic PC-family slugs map to Steam and console families collapse
 * into their brand-level id.
 */
const PLATFORM_ALIASES: Record<string, string> = {
  // Sony
  "playstation": "playstation",
  "ps1": "playstation",
  "ps2": "playstation",
  "ps3": "playstation",
  "ps4": "playstation",
  "ps5": "playstation",
  "playstation-1": "playstation",
  "playstation-2": "playstation",
  "playstation-3": "playstation",
  "playstation-4": "playstation",
  "playstation-5": "playstation",
  "playstation1": "playstation",
  "playstation2": "playstation",
  "playstation3": "playstation",
  "playstation4": "playstation",
  "playstation5": "playstation",
  "playstation-2-3-4-psp": "playstation",
  "psp": "playstation",
  "playstation-portable": "playstation",
  "ps-vita": "playstation",
  "psvita": "playstation",
  "playstation-vita": "playstation",
  // Xbox
  "xbox": "xbox",
  "xbox-360": "xbox",
  "xbox360": "xbox",
  "xbox-one": "xbox",
  "xboxone": "xbox",
  "xbox-series-x": "xbox",
  "xbox-series-s": "xbox",
  "xbox-series-x|s": "xbox",
  "xbox-classic": "xbox",
  // Nintendo
  "nintendo": "nintendo",
  "nintendo-switch": "nintendo",
  "switch": "nintendo",
  "nintendo-3ds": "nintendo",
  "nintendo-3ds-2ds": "nintendo",
  "3ds": "nintendo",
  "nintendo-ds": "nintendo",
  "ds": "nintendo",
  "nintendo-64": "nintendo",
  "n64": "nintendo",
  "wii": "nintendo",
  "wii-u": "nintendo",
  "wiiu": "nintendo",
  "game-boy": "nintendo",
  "game-boy-advance": "nintendo",
  "game-boy-color": "nintendo",
  "nintendo-2ds": "nintendo",
  "family-computer": "nintendo",
  "super-nintendo": "nintendo",
  "snes": "nintendo",
  "nintendo-entertainment-system": "nintendo",
  "nes": "nintendo",
  // Stores
  "gog": "gog",
  "gog.com": "gog",
  "gog-galaxy": "gog",
  "epic-games-store": "epic-games",
  "epic": "epic-games",
  "egs": "epic-games",
  "origin": "ea-play",
  "ea-app": "ea-play",
  "ea-desktop": "ea-play",
  "ea-app-desktop": "ea-play",
  "rockstar-games-launcher": "rockstar",
  "rockstar": "rockstar",
  "rockstar-launcher": "rockstar",
  // Generic PC family — Steam is the app's catch-all PC store
  "pc": "steam",
  "pc-(microsoft-windows)": "steam",
  "microsoft-windows": "steam",
  "linux": "steam",
  "linux-apple-macintosh-other": "steam",
  "mac": "steam",
  "macos": "steam",
  "macintosh": "steam",
};

/**
 * Normalize a list of external platform slugs/labels into canonical app
 * platform ids. Unknown platforms are kept verbatim (lowercased).
 */
export function normalizePlatformIds(platforms: string[] | null | undefined): string[] {
  if (!platforms) return [];
  const out = new Set<string>();
  for (const p of platforms) {
    if (typeof p !== "string" || !p.trim()) continue;
    const canonical = AVAILABLE_PLATFORMS.find((ap) => platformIdMatches(ap.id, p.trim()));
    if (canonical) {
      out.add(canonical.id);
      continue;
    }
    const key = p.trim().toLowerCase().replace(/\s+/g, "-");
    const alias = PLATFORM_ALIASES[key];
    out.add(alias ?? p.trim().toLowerCase());
  }
  return [...out];
}

export interface StatusOption {
  value: "backlog" | "playing" | "completed" | "endless";
  label: string;
}

export const STATUSES: StatusOption[] = [
  { value: "backlog", label: "Backlog" },
  { value: "playing", label: "Playing" },
  { value: "completed", label: "Completed" },
  { value: "endless", label: "Endless" }
];

export const getStatusLabel = (status: string): string => {
  const match = STATUSES.find(s => s.value === status);
  return match ? match.label : status;
};

/**
 * Status palette, shared by every status surface in the app (poster markers,
 * the logs rail, game details) so a status reads as the same colour
 * everywhere:
 *
 *   completed -> green      playing  -> blue
 *   backlog   -> grey       endless  -> purple
 *
 * Blue is a theme token (`--blue-400/500`), defined per theme alongside the
 * emerald/fuchsia values, so these track the active theme rather than being
 * hardcoded Tailwind defaults. The accent colour is deliberately NOT a status
 * colour any more — it used to stand for "completed", which collided with the
 * accent's job as the brand's action/selection colour.
 */
export const getStatusBadgeColor = (status: string): string => {
  switch (status) {
    case "backlog":
      return "bg-zinc-900 text-zinc-400 border-zinc-800";
    case "playing":
      return "bg-blue-500/10 text-blue-400 border-blue-500/30";
    case "completed":
      return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
    case "endless":
      return "bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/30";
    default:
      return "bg-zinc-900 text-zinc-400 border-zinc-800";
  }
};

/** Solid square marker colors per status — used by the small corner status
 *  badges on Library cards. */
/**
 * Status colour as text only, for places that show the status as a word
 * rather than a badge or a swatch — e.g. the poster hover row, where the
 * status reads as coloured type beside the playtime rather than a pill.
 * Shares the palette with getStatusBadgeColor/getStatusMarkerColor.
 */
export const getStatusTextColor = (status: string): string => {
  switch (status) {
    case "playing":
      return "text-blue-400";
    case "completed":
      return "text-emerald-400";
    case "endless":
      return "text-fuchsia-400";
    case "backlog":
    default:
      return "text-zinc-400";
  }
};

export const getStatusMarkerColor = (status: string): string => {
  switch (status) {
    case "playing":
      return "bg-blue-500 border-blue-500 text-zinc-950";
    case "completed":
      return "bg-emerald-500 border-emerald-500 text-zinc-950";
    case "endless":
      return "bg-fuchsia-500 border-fuchsia-500 text-zinc-950";
    case "backlog":
    default:
      return "bg-zinc-500 border-zinc-500 text-zinc-950";
  }
};

export const getStatusBorderColor = (status: string): string => {
  switch (status) {
    case "backlog":
      return "border border-brand-border hover:border-brand-accent/40 focus:border-brand-accent";
    case "playing":
      return "border-2 border-emerald-500/70 shadow-[0_0_22px_var(--status-glow-emerald)] hover:shadow-[0_0_35px_var(--status-glow-emerald-strong)] hover:scale-[1.01]";
    case "completed":
      return "border-2 border-brand-accent shadow-[0_0_22px_var(--brand-glow)] hover:shadow-[0_0_35px_var(--brand-glow-strong)] hover:scale-[1.01]";
    case "endless":
      return "border-2 border-fuchsia-500/70 shadow-[0_0_22px_var(--status-glow-fuchsia)] hover:shadow-[0_0_35px_var(--status-glow-fuchsia-strong)] hover:scale-[1.01]";
    default:
      return "border border-brand-border hover:border-brand-accent/40 focus:border-brand-accent";
  }
};

// ── Discover genre filter ──────────────────────────────────────────
// Our dropdown labels are not IGDB genre names, so every option maps to the
// exact IGDB genre name(s) it should match. This is the single source of truth
// shared by the store (which sends the names to the API) and the Discover view
// (which renders the options).
//
// Notes on the IGDB taxonomy:
//  - There is no "Action" genre — it spans the action-oriented genres.
//  - "Sport" (not "Sports"), "Simulator" (not "Simulation"),
//    "Platform" (not "Platformer").

/** Selectable Discover genre filters in display order. */
export const DISCOVER_GENRES = [
  "Action",
  "RPG",
  "Shooter",
  "Adventure",
  "Sports",
  "Racing",
  "Indie",
  "Strategy",
  "Platformer",
  "Simulation",
  "Puzzle",
] as const;

export type DiscoverGenre = (typeof DISCOVER_GENRES)[number];

/** Discover genre option → the IGDB genre name(s) it matches. */
export const DISCOVER_GENRE_ALIASES: Record<string, readonly string[]> = {
  Action: ["Fighting", "Hack and slash/Beat 'em up", "Arcade"],
  RPG: ["Role-playing (RPG)"],
  Shooter: ["Shooter"],
  Adventure: ["Adventure", "Point-and-click"],
  Sports: ["Sport"],
  Racing: ["Racing"],
  Indie: ["Indie"],
  Strategy: ["Strategy", "Real Time Strategy (RTS)", "Turn-based strategy (TBS)", "Tactical"],
  Platformer: ["Platform"],
  Simulation: ["Simulator"],
  Puzzle: ["Puzzle", "Quiz/Trivia", "Card & Board Game"],
};

/** IGDB genre names to filter by for a Discover genre option (empty = all). */
export function igdbGenreNamesFor(genre: string): string[] {
  if (!genre) return [];
  const aliases = DISCOVER_GENRE_ALIASES[genre];
  return aliases ? [...aliases] : [genre];
}

/** True when any of a mapped game's genres matches the option's aliases. */
export function gameMatchesDiscoverGenre(gameGenres: unknown, genre: string): boolean {
  if (!genre) return true;
  if (!Array.isArray(gameGenres)) return false;
  const aliases = (DISCOVER_GENRE_ALIASES[genre] ?? [genre]).map((a) => a.toLowerCase());
  return gameGenres.some(
    (g: unknown) => typeof g === "string" && aliases.includes(g.toLowerCase())
  );
}
