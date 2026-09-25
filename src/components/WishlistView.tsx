import React, { useEffect, useRef, useState, useCallback } from "react";
import { useGameTrackStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { Search, Plus, X, Heart, Loader2, CheckCircle2, ArrowLeft, Compass, CheckSquare, Check, Trash2 } from "lucide-react";
import { IGDBGame, WishlistItem } from "../types";
import { PosterImage } from "./PosterImage";
import { libraryGridClass } from "../constants";

export const WishlistView: React.FC = () => {
  const {
    wishlist, loadingWishlist, fetchWishlist,
    addToWishlist, removeFromWishlist, removeWishlistItems, ownWishlistItem, games,
    setActiveTab, customizations,
  } = useGameTrackStore(useShallow((s) => ({
    wishlist: s.wishlist,
    loadingWishlist: s.loadingWishlist,
    fetchWishlist: s.fetchWishlist,
    addToWishlist: s.addToWishlist,
    removeFromWishlist: s.removeFromWishlist,
    removeWishlistItems: s.removeWishlistItems,
    ownWishlistItem: s.ownWishlistItem,
    games: s.games,
    setActiveTab: s.setActiveTab,
    customizations: s.customizations,
  })));

  const searchInputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IGDBGame[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [owningId, setOwningId] = useState<number | null>(null);

  // Multi-select state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    fetchWishlist();
  }, [fetchWishlist]);

  // Automatic debounced search as you type
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearched(false);
      setSearching(false);
      setSearchError(null);
      return;
    }

    setSearching(true);
    setSearchError(null);

    const controller = new AbortController();
    const timeoutId = setTimeout(async () => {
      try {
        const res = await fetch(`/api/discover/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        if (!controller.signal.aborted) {
          setResults(data);
          setSearched(true);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;
        if (!controller.signal.aborted) {
          setSearchError(err instanceof Error ? err.message : "Search failed");
        }
      } finally {
        if (!controller.signal.aborted) {
          setSearching(false);
        }
      }
    }, 350);

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [query]);

  // Manual entries have no IGDB id — fall back to a case-insensitive title
  // match so they still dedupe instead of silently doubling up.
  const inWishlist = (igdbId: number | null | undefined, title?: string) =>
    Boolean(
      (igdbId && wishlist.some((w) => w.igdb_id === igdbId)) ||
        (title && wishlist.some((w) => w.title.trim().toLowerCase() === title.trim().toLowerCase()))
    );

  const inLibrary = (igdbId: number | null | undefined, title?: string) =>
    Boolean(
      (igdbId && games.some((g) => g.igdb_id === igdbId)) ||
        (title && games.some((g) => g.title.trim().toLowerCase() === title.trim().toLowerCase()))
    );

  const handleAdd = async (game: IGDBGame) => {
    const ok = await addToWishlist(game);
    if (ok) {
      setResults((prev) => prev.filter((r) => r.igdb_id !== game.igdb_id));
    }
  };

  const handleOwn = async (item: WishlistItem) => {
    setOwningId(item.id);
    await ownWishlistItem(item.id);
    setOwningId(null);
  };

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(wishlist.map((w) => w.id)));
  }, [wishlist]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setShowDeleteConfirm(false);
  }, []);

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);
    const ids = Array.from(selectedIds);
    const ok = await removeWishlistItems(ids);
    setBulkDeleting(false);
    if (ok) {
      exitSelectMode();
    }
  };

  return (
    <div className="space-y-10">
      {/* Header and Back Action */}
      <div className="flex flex-col lg:flex-row justify-between lg:items-end gap-6">
        <div>
          <h1 className="relative z-30 pointer-events-none text-6xl sm:text-8xl lg:text-[110px] font-black tracking-tighter leading-[0.85] uppercase text-white font-sans select-none mb-3">
            WISH<br />LISTED
          </h1>
          <p className="max-w-xl text-brand-muted text-sm sm:text-base font-medium leading-relaxed">
            Games you want before they enter your library.
            <span className="ml-2 text-[11px] font-mono font-bold uppercase tracking-widest text-brand-accent">
              {wishlist.length} {wishlist.length === 1 ? "item" : "items"} tracked
            </span>
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => setActiveTab("library")}
            className="flex items-center gap-2 bg-transparent border border-brand-border text-white px-6 py-3 rounded-none text-xs font-black uppercase tracking-wider transition-all cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Library
          </button>
        </div>
      </div>

      {/* Search Bar & Select Action */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          {searching ? (
            <Loader2 className="absolute left-4 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-brand-accent animate-spin" />
          ) : (
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-brand-muted" />
          )}
          <label htmlFor="wishlist-search" className="sr-only">Search games</label>
          <input
            ref={searchInputRef}
            id="wishlist-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search IGDB for games you want..."
            className="w-full pl-11 pr-10 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-mono uppercase tracking-wider text-white placeholder-zinc-600 focus:outline-none focus:border-brand-accent transition-colors h-[38px]"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setSearched(false);
                setResults([]);
              }}
              aria-label="Clear search query"
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-brand-muted hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Select Mode Toggle */}
        {wishlist.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (selectMode) exitSelectMode();
              else setSelectMode(true);
            }}
            className={`px-5 py-2.5 border rounded-none text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer select-none shrink-0 h-[38px] ${
              selectMode
                ? "bg-brand-accent border-brand-accent text-brand-accent-ink font-black"
                : "bg-zinc-950 border-brand-border text-white hover:bg-brand-accent/[0.03]"
            }`}
            title={selectMode ? "Exit Select Mode" : "Select Multiple Items"}
          >
            <CheckSquare className="w-4 h-4" />
            <span className="hidden sm:inline">{selectMode ? "Exit Select" : "Select"}</span>
          </button>
        )}
      </div>

      {searchError && (
        <div className="border border-red-500/40 border-dashed p-8 text-center">
          <p className="text-red-400 text-sm font-bold uppercase tracking-wider">{searchError}</p>
        </div>
      )}

      {/* Search Results */}
      {searched && !searchError && (
        <section>
          <div className="mb-4">
            <span className="text-[11px] font-mono font-bold tracking-widest text-brand-accent uppercase">01</span>
            <h3 className="text-xl sm:text-2xl font-black uppercase tracking-tight text-white">Search Results</h3>
          </div>
          {searching ? (
            <div className={`grid ${libraryGridClass(customizations.libraryColumns)} gap-4`}>
              {[...Array(8)].map((_, i) => (
                <div key={i} className="aspect-[2/3] bg-zinc-900/50 border border-brand-border rounded-none animate-pulse" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <p className="text-brand-muted text-sm font-mono uppercase tracking-wider">No matches found.</p>
          ) : (
            <div className={`grid ${libraryGridClass(customizations.libraryColumns)} gap-4`}>
              {results.map((game) => (
                <WishlistSearchCard
                  key={game.igdb_id}
                  game={game}
                  alreadyWishlisted={inWishlist(game.igdb_id, game.title)}
                  alreadyInLibrary={inLibrary(game.igdb_id, game.title)}
                  showRating={customizations.showRatingBadge}
                  onAdd={handleAdd}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* Wishlist Items */}
      <section className="space-y-4">
        {/* Batch Action Bar */}
        {selectMode && (
          <div className="bg-zinc-950 border border-brand-border p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono font-black uppercase tracking-widest text-brand-accent bg-brand-accent/10 border border-brand-accent/30 px-2.5 py-1">
                {selectedIds.size} SELECTED
              </span>
              <button
                type="button"
                onClick={selectedIds.size === wishlist.length && wishlist.length > 0 ? deselectAll : selectAll}
                className="text-xs font-sans font-bold uppercase tracking-wider text-zinc-400 hover:text-white underline cursor-pointer"
              >
                {selectedIds.size === wishlist.length && wishlist.length > 0 ? "Deselect All" : `Select All (${wishlist.length})`}
              </button>
            </div>

            <div className="flex items-center gap-2">
              {showDeleteConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-red-400 font-bold uppercase hidden sm:inline">
                    Remove {selectedIds.size} {selectedIds.size === 1 ? "item" : "items"}?
                  </span>
                  <button
                    type="button"
                    disabled={bulkDeleting}
                    onClick={handleBulkDelete}
                    className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-black uppercase tracking-wider rounded-none cursor-pointer transition-all flex items-center gap-1.5"
                  >
                    {bulkDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    Confirm Remove
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-3 py-2 bg-transparent text-brand-muted hover:text-white border border-brand-border text-xs font-black uppercase rounded-none cursor-pointer transition-all"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={selectedIds.size === 0}
                  onClick={() => setShowDeleteConfirm(true)}
                  className="px-4 py-2 bg-transparent hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/40 text-brand-muted disabled:opacity-40 disabled:hover:bg-brand-accent/[0.03] disabled:hover:text-brand-muted disabled:hover:border-brand-border border border-brand-border text-xs font-black uppercase tracking-wider rounded-none cursor-pointer transition-all flex items-center gap-2"
                >
                  <Trash2 className="w-4 h-4 text-red-400" />
                  <span>Remove ({selectedIds.size})</span>
                </button>
              )}

              <button
                type="button"
                onClick={exitSelectMode}
                className="px-3 py-2 bg-transparent text-zinc-300 hover:text-white border border-brand-border text-xs font-black uppercase tracking-wider rounded-none cursor-pointer transition-all flex items-center gap-1"
              >
                <X className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Done</span>
              </button>
            </div>
          </div>
        )}

        {loadingWishlist ? (
          <div className={`grid ${libraryGridClass(customizations.libraryColumns)} gap-4`}>
            {[...Array(8)].map((_, i) => (
              <div key={i} className="aspect-[2/3] bg-zinc-900/50 border border-brand-border rounded-none animate-pulse" />
            ))}
          </div>
        ) : wishlist.length === 0 ? (
          <div className="border border-brand-border border-dashed rounded-none p-16 text-center flex flex-col items-center justify-center">
            <Heart className="w-12 h-12 text-brand-muted mb-4" />
            <h4 className="text-white font-black text-lg uppercase tracking-wider">Empty Wishlist</h4>
            <p className="text-brand-muted text-sm mt-1 max-w-sm">
              Your wishlist is empty. Search IGDB above, or wishlist games straight from the Discover feed — every card has a Wish button.
            </p>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => searchInputRef.current?.focus()}
                className="bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink px-6 py-2.5 text-xs font-black uppercase tracking-wider transition-all rounded-none cursor-pointer"
              >
                Search IGDB
              </button>
              <button
                onClick={() => setActiveTab("discover")}
                className="flex items-center gap-2 bg-transparent border border-brand-border text-white px-6 py-2.5 text-xs font-black uppercase tracking-wider transition-all rounded-none cursor-pointer"
              >
                <Compass className="w-4 h-4" />
                Go to Discover
              </button>
            </div>
          </div>
        ) : (
          <div className={`grid ${libraryGridClass(customizations.libraryColumns)} gap-4`}>
            {wishlist.map((item) => (
              <WishlistItemCard
                key={item.id}
                item={item}
                alreadyInLibrary={inLibrary(item.igdb_id, item.title)}
                owning={owningId === item.id}
                showRating={customizations.showRatingBadge}
                onOwn={() => handleOwn(item)}
                onRemove={() => removeFromWishlist(item.id)}
                selectMode={selectMode}
                selected={selectedIds.has(item.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

interface WishlistSearchCardProps {
  game: IGDBGame;
  alreadyWishlisted: boolean;
  alreadyInLibrary: boolean;
  showRating?: boolean;
  onAdd: (game: IGDBGame) => void;
}

const WishlistSearchCard = React.memo<WishlistSearchCardProps>(({ game, alreadyWishlisted, alreadyInLibrary, showRating = true, onAdd }) => (
  <div className="group bg-transparent border border-brand-border rounded-none overflow-hidden hover:border-brand-accent/40 transition-all duration-200 flex flex-col justify-between">
    <div className="aspect-[2/3] relative overflow-hidden bg-zinc-950 border-b border-brand-border">
      <PosterImage
        src={game.poster_url}
        alt={game.title}
        className="w-full h-full object-cover group-hover:scale-102 transition-transform duration-200 transform-gpu will-change-transform"
      />
      {showRating && game.critic_score != null && (
        <div className="absolute top-2.5 right-2.5 bg-zinc-950/90 backdrop-blur-sm px-2 py-1 text-[11px] font-mono font-black text-brand-accent border border-brand-border shadow-sm">
          MC: {game.critic_score}
        </div>
      )}
    </div>
    <div className="p-4 flex-1 flex flex-col justify-between">
      <div>
        <h4 className="font-bold text-white text-sm line-clamp-1 uppercase tracking-tight">{game.title}</h4>
        <p className="text-[11px] text-brand-muted mt-0.5 font-mono uppercase font-bold">
          {game.year ? `${game.year} // ` : ""}{(game.genres || []).slice(0, 1).join(" • ") || "Unknown Genre"}
        </p>
      </div>
      <div className="mt-4 pt-3 border-t border-brand-border">
        {alreadyInLibrary ? (
          <div className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-500/10 border border-emerald-500/35 text-emerald-400 rounded-none text-[11px] font-black uppercase tracking-widest select-none">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            In Library
          </div>
        ) : alreadyWishlisted ? (
          <div className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-brand-accent/10 border border-brand-accent/35 text-brand-accent rounded-none text-[11px] font-black uppercase tracking-widest select-none">
            <Heart className="w-3.5 h-3.5 shrink-0" />
            Wishlisted
          </div>
        ) : (
          <button
            onClick={() => onAdd(game)}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink rounded-none text-[11px] font-black uppercase tracking-widest transition-all cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 stroke-[3]" />
            Add to Wishlist
          </button>
        )}
      </div>
    </div>
  </div>
));
WishlistSearchCard.displayName = "WishlistSearchCard";

interface WishlistItemCardProps {
  item: WishlistItem;
  alreadyInLibrary: boolean;
  owning: boolean;
  showRating?: boolean;
  onOwn: () => void;
  onRemove: () => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
}

const WishlistItemCard = React.memo<WishlistItemCardProps>(({
  item, alreadyInLibrary, owning, showRating = true, onOwn, onRemove,
  selectMode = false, selected = false, onToggleSelect,
}) => {
  const handleCardClick = () => {
    if (selectMode) {
      onToggleSelect?.(item.id);
    }
  };

  return (
    <div
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick();
        }
      }}
      tabIndex={0}
      role="button"
      aria-pressed={selectMode ? selected : undefined}
      aria-label={`${selectMode ? (selected ? "Deselect " : "Select ") : ""}${item.title}`}
      className={`group bg-zinc-950 border rounded-none overflow-hidden transition-all duration-200 flex flex-col justify-between focus:outline-none focus-visible:outline-2 focus-visible:outline-brand-accent focus-visible:outline-offset-2 ${
        selectMode
          ? (selected
              ? "border-brand-accent ring-2 ring-brand-accent/50 bg-brand-accent/[0.04] cursor-pointer"
              : "border-brand-border hover:border-brand-accent/40 cursor-pointer")
          : "border-brand-border hover:border-brand-accent/40"
      }`}
    >
      <div className="aspect-[2/3] relative overflow-hidden border-b border-brand-border">
        {/* Checkbox indicator in select mode */}
        {selectMode && (
          <div className="absolute top-2.5 left-2.5 z-20">
            <div
              className={`w-6 h-6 border rounded-none flex items-center justify-center transition-all ${
                selected
                  ? "bg-brand-accent text-brand-accent-ink border-brand-accent shadow-md"
                  : "bg-zinc-950/80 border-zinc-400/60 text-transparent hover:border-brand-accent"
              }`}
            >
              {selected && <Check className="w-4 h-4 stroke-[3]" />}
            </div>
          </div>
        )}

        <PosterImage
          src={item.poster_url}
          alt={item.title}
          className="w-full h-full object-cover"
        />
        {showRating && item.critic_score != null && (
          <div className="absolute top-2.5 right-2.5 bg-zinc-950/90 backdrop-blur-sm px-2 py-1 text-[11px] font-mono font-black text-brand-accent border border-brand-border shadow-sm">
            MC: {item.critic_score}
          </div>
        )}

        {/* Hover actions overlay — only in normal non-select mode.
            Always visible on touch devices (no hover) and to keyboard focus,
            invisible + untabbable otherwise. */}
        {!selectMode && (
          <div className="absolute inset-0 bg-black/65 opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible [@media(hover:none)]:opacity-100 [@media(hover:none)]:visible transition-all duration-200 flex flex-col items-center justify-center gap-2.5 p-4">
            {alreadyInLibrary ? (
              <div className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-500/10 border border-emerald-500/35 text-emerald-400 rounded-none text-[11px] font-black uppercase tracking-widest select-none">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                In Library
              </div>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOwn();
                }}
                disabled={owning}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-brand-accent hover:bg-brand-accent-hover disabled:opacity-50 text-brand-accent-ink rounded-none text-[11px] font-black uppercase tracking-widest transition-all cursor-pointer"
              >
                {owning ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5 stroke-[3]" />
                )}
                Own It
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-zinc-950 border border-brand-border text-brand-muted hover:text-red-400 hover:border-red-500/35 rounded-none text-[11px] font-black uppercase tracking-widest transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              Remove
            </button>
          </div>
        )}
      </div>
      <div className="p-3.5">
        <h4 className="font-bold text-white text-xs line-clamp-1 uppercase tracking-tight">{item.title}</h4>
        <p className="text-[10px] text-brand-muted mt-0.5 font-mono uppercase font-bold">
          {item.year ? `${item.year} // ` : ""}{(item.genres || []).slice(0, 1).join(" • ") || "Unknown Genre"}
        </p>
      </div>
    </div>
  );
});
WishlistItemCard.displayName = "WishlistItemCard";

export default WishlistView;