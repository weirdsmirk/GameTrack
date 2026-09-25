import React, { useEffect, useState, useRef, useCallback } from "react";
import { useGameTrackStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { Search, Compass, Plus, CheckCircle2, Loader2, ChevronDown, ChevronLeft, ChevronRight, X, RefreshCw, Trash2, Heart } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { IGDBGame, Game } from "../types";
import { PosterImage } from "./PosterImage";
import { useModalA11y } from "../hooks/useModalA11y";
import { DISCOVER_GENRES, gameMatchesDiscoverGenre, libraryGridClass } from "../constants";

// The genre filter itself is applied server-side (IGDB filters the ranked
// pool), so these helpers only drive the dropdown and the curated lists.

export const DiscoverView: React.FC = () => {
  const { 
    trendingGames, discoverSearchResults, discoverQuery, loadingDiscover, discoverError,
    fetchTrending, searchDiscover, addGameFromIgdb, games,
    hasMoreTrending, hasMoreSearch, deleteGame,
    discoverLists, loadingLists, lastListsFetch, fetchDiscoverLists,
    customizations,
    discoverGenre, setDiscoverGenre, discoverCooldownUntil,
    wishlist, addToWishlist, removeFromWishlist,
  } = useGameTrackStore(useShallow((s) => ({
    trendingGames: s.trendingGames, discoverSearchResults: s.discoverSearchResults,
    discoverQuery: s.discoverQuery, loadingDiscover: s.loadingDiscover, discoverError: s.discoverError,
    fetchTrending: s.fetchTrending, searchDiscover: s.searchDiscover, addGameFromIgdb: s.addGameFromIgdb, games: s.games,
    hasMoreTrending: s.hasMoreTrending, hasMoreSearch: s.hasMoreSearch, deleteGame: s.deleteGame,
    discoverLists: s.discoverLists, loadingLists: s.loadingLists, lastListsFetch: s.lastListsFetch, fetchDiscoverLists: s.fetchDiscoverLists,
    customizations: s.customizations,
    discoverGenre: s.discoverGenre, setDiscoverGenre: s.setDiscoverGenre,
    discoverCooldownUntil: s.discoverCooldownUntil,
    wishlist: s.wishlist, addToWishlist: s.addToWishlist, removeFromWishlist: s.removeFromWishlist,
  })));

  const [query, setQuery] = useState("");

  const isWishlisted = useCallback(
    (igdbId: number | null | undefined) => Boolean(igdbId && wishlist.some((w) => w.igdb_id === igdbId)),
    [wishlist]
  );

  const handleToggleWishlist = useCallback(async (game: IGDBGame) => {
    const existing = game.igdb_id ? wishlist.find((w) => w.igdb_id === game.igdb_id) : null;
    if (existing) {
      await removeFromWishlist(existing.id);
    } else {
      await addToWishlist(game);
    }
  }, [wishlist, addToWishlist, removeFromWishlist]);

  const [infoModalGame, setInfoModalGame] = useState<IGDBGame | null>(null);
  const [infoModalDetails, setInfoModalDetails] = useState<IGDBGame | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const modalRef = useModalA11y(Boolean(infoModalGame));

  useEffect(() => {
    if (!infoModalGame) return;
    document.body.style.overflow = "hidden";
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setInfoModalGame(null);
        setInfoModalDetails(null);
      }
    };
    
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [infoModalGame]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setInfoModalGame(null);
      setInfoModalDetails(null);
    }
  };

  const setSentinelNode = useCallback((node: HTMLDivElement | null) => {
    observerRef.current = node;
    // Flip whenever the sentinel mounts/unmounts so the observer effect
    // below re-runs against the live DOM node — without this the observer
    // can be left watching a node that no longer exists (or never sees the
    // new one), which desyncs "scroll to load more" until a hard refresh.
    setSentinelMounted((mounted) => (node !== null) !== mounted);
  }, []);

  const observerRef = useRef<HTMLDivElement | null>(null);
  const [sentinelMounted, setSentinelMounted] = useState(false);
  const infoModalRequestIdRef = useRef<number | null>(null);

  // Curated lists — fetch once per session, then only when >5min stale.
  useEffect(() => {
    if (!discoverLists || Date.now() - lastListsFetch > 300_000) fetchDiscoverLists();
  }, [discoverLists, lastListsFetch, fetchDiscoverLists]);

  // A throttled feed must not look like it is loading forever: while the
  // cooldown is active the sentinel shows a paused message instead of a
  // spinner and stops asking for more pages.
  const [coolingDown, setCoolingDown] = useState(false);
  useEffect(() => {
    if (discoverCooldownUntil <= Date.now()) {
      setCoolingDown(false);
      return;
    }
    setCoolingDown(true);
    const timer = setTimeout(
      () => setCoolingDown(false),
      discoverCooldownUntil - Date.now() + 50
    );
    return () => clearTimeout(timer);
  }, [discoverCooldownUntil]);

  useEffect(() => {
    // Refetch only when the feed is empty and the pool isn't exhausted — a
    // genre whose whole ranked pool fits on one page (or is empty) must not
    // re-fetch in a loop, and neither must a failed request (the empty state
    // offers Reconnect for that case).
    //
    // The old time-based branch re-ran whenever ANY feed dependency changed
    // after the 5-minute mark, REPLACING the live feed with page 1 — every
    // scroll-append was instantly reset back to the top of the pool. That is
    // the "scroll to load more does nothing except right after a hard
    // refresh" bug: after a refresh the data was fresh (<5 min) so scrolling
    // worked; later (or on a soft navigation with a stale cache) every append
    // was wiped out by a page-1 replacement. Never fight an in-flight
    // request, a throttle cooldown, or a hard failure here either — otherwise
    // the effect would re-fire the same failing request on every settle.
    if (
      trendingGames.length === 0 &&
      hasMoreTrending &&
      !loadingDiscover &&
      !coolingDown &&
      !discoverError
    ) {
      fetchTrending();
    }
  }, [fetchTrending, trendingGames.length, hasMoreTrending, loadingDiscover, discoverError, coolingDown]);

  const hasMore = query.trim() ? hasMoreSearch : hasMoreTrending;

  // Debounced search-as-you-type. Also re-runs when the genre filter changes
  // so an active search is re-queried (and re-filtered server-side).
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      searchDiscover("");
      return;
    }
    const timer = setTimeout(() => {
      searchDiscover(query);
    }, 400);
    return () => clearTimeout(timer);
  }, [query, discoverGenre, searchDiscover]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loadingDiscover && !coolingDown) {
          const trimmed = query.trim();
          // Skip while results on screen don't match the current query
          // (e.g. inside the 400ms debounce window) — otherwise a stale
          // page-2 append could be mixed into the previous query's results.
          if (trimmed && discoverQuery !== trimmed) return;
          // Stop observing immediately: the effect re-subscribes once
          // loading settles (deps include loadingDiscover), so a visible
          // sentinel can never fire a second load while one is in flight.
          const target = entries[0]?.target;
          if (target) observer.unobserve(target);
          if (trimmed) {
            searchDiscover(query, true);
          } else {
            fetchTrending(true);
          }
        }
      },
      { threshold: 0.1, rootMargin: "200px" }
    );

    const currentRef = observerRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      observer.disconnect();
    };
  }, [sentinelMounted, hasMore, loadingDiscover, coolingDown, query, discoverQuery, searchDiscover, fetchTrending]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    searchDiscover(query);
  };

  const handleOpenInfoModal = useCallback(async (game: IGDBGame) => {
    setInfoModalGame(game);
    setInfoModalDetails(null);
    setLoadingDetails(true);
    // Guard against a slow earlier response overwriting a newer modal
    const requestedIdRef = infoModalRequestIdRef;
    const requestedId = game.igdb_id;
    requestedIdRef.current = requestedId;
    try {
      const res = await fetch(`/api/discover/game/${game.igdb_id}`);
      const data = res.ok ? await res.json() : game;
      if (requestedIdRef.current !== requestedId) return; // superseded
      setInfoModalDetails(data);
    } catch (err) {
      console.error("Failed to load game details", err);
      if (requestedIdRef.current === requestedId) setInfoModalDetails(game);
    } finally {
      if (requestedIdRef.current === requestedId) setLoadingDetails(false);
    }
  }, []);

  const handleCardClick = useCallback((game: IGDBGame) => {
    handleOpenInfoModal(game);
  }, [handleOpenInfoModal]);

  // Optimize library lookup from O(N) to O(1) using a Map
  const libraryGamesMap = React.useMemo(() => {
    const map = new Map<number, Game>();
    games.forEach((g) => {
      if (g.igdb_id) {
        map.set(g.igdb_id, g);
      }
    });
    return map;
  }, [games]);

  // Determine if a discovered game is already in personal library
  const getLibraryGame = useCallback((igdbId: number | null) => {
    if (!igdbId) return null;
    return libraryGamesMap.get(igdbId) || null;
  }, [libraryGamesMap]);

  const handleAddGame = useCallback(async (game: IGDBGame) => {
    if (getLibraryGame(game.igdb_id)) return;
    await addGameFromIgdb(game);
  }, [getLibraryGame, addGameFromIgdb]);

  // Both feeds arrive already filtered by the server, so there is no client-side
  // filter here — filtering the loaded window is exactly what used to shrink a
  // genre to a couple of cards and keep the infinite loader spinning forever.
  const gamesToDisplay = React.useMemo(() => {
    return query.trim() ? discoverSearchResults : trendingGames;
  }, [query, discoverSearchResults, trendingGames]);

  // Curated editorial lists are fetched once for all genres, so their genre
  // narrowing stays client-side (they are small, fixed lists).
  const curatedForGenre = React.useMemo(() => {
    if (!discoverGenre || !discoverLists) return discoverLists;
    const keep = (list: IGDBGame[] | undefined) =>
      list?.filter((game) => gameMatchesDiscoverGenre(game.genres, discoverGenre));
    return {
      topThisMonth: keep(discoverLists.topThisMonth),
      bestAllTime: keep(discoverLists.bestAllTime),
      newReleases: keep(discoverLists.newReleases),
      mostHyped: keep(discoverLists.mostHyped),
    };
  }, [discoverLists, discoverGenre]);

  return (
    <div className="space-y-10">
      
      {/* Header Area */}
      <div className="flex flex-col lg:flex-row justify-between items-start gap-8">
        <div>
          {/* Huge Display Hero Title */}
          <h1 className="relative z-30 pointer-events-none text-6xl sm:text-8xl lg:text-[110px] font-black tracking-tighter leading-[0.85] uppercase text-white font-sans select-none mb-3">
            DISCOVER<br />TITLES
          </h1>
          <p className="max-w-xl text-brand-muted text-sm sm:text-base font-medium leading-relaxed">
            Search the IGDB database to find and add new games.
          </p>
        </div>
      </div>

      {/* Discovery Search Bar */}
      <form onSubmit={handleSearchSubmit} className="flex flex-col md:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <label htmlFor="discover-search" className="sr-only">Search IGDB Database</label>
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-brand-muted" />
          <input
            id="discover-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Witcher, Elden Ring, Doom, Metroid, Zelda..."
            className="w-full pl-11 pr-10 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-mono uppercase tracking-wider text-white placeholder-zinc-600 focus:outline-none focus:border-brand-accent transition-colors"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                searchDiscover("");
              }}
              aria-label="Clear search query"
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-brand-muted hover:text-white cursor-pointer flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <button
          type="submit"
          disabled={loadingDiscover || !query.trim()}
          className="bg-brand-accent hover:bg-brand-accent-hover disabled:opacity-50 text-brand-accent-ink px-6 py-2.5 rounded-none text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 shrink-0 cursor-pointer"
        >
          {loadingDiscover ? (
            <Loader2 className="w-4 h-4 animate-spin text-brand-accent-ink" />
          ) : (
            <Search className="w-4 h-4 text-brand-accent-ink stroke-[3px]" />
          )}
          Search
        </button>

        {/* Genre Selector */}
        <div className="relative w-full md:w-56">
          <label htmlFor="discover-genre" className="sr-only">Filter by genre</label>
          <select
            id="discover-genre"
            value={discoverGenre}
            onChange={(e) => setDiscoverGenre(e.target.value)}
            className="w-full pl-4 pr-10 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-black uppercase tracking-wider text-white focus:outline-none focus:border-brand-accent cursor-pointer appearance-none"
          >
            <option value="">All Genres</option>
            {DISCOVER_GENRES.map((genre) => (
              <option key={genre} value={genre}>{genre}</option>
            ))}
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-brand-muted">
            <ChevronDown className="w-4 h-4" />
          </div>
        </div>
      </form>
      {/* Curated Sections — editorial lists from IGDB, above the infinite feed.
          While a genre filter is active these lists are narrowed to it, so the
          page never mixes unrelated genres into a filtered view. */}
      {!query.trim() && (
        <div className="space-y-14">
          <TabbedCuratedSection
            loading={loadingLists}
            showRating={customizations.showRatingBadge}
            onCardClick={handleCardClick}
            onAddGame={handleAddGame}
            onAddWishlist={handleToggleWishlist}
            isWishlisted={isWishlisted}
            getLibraryGame={getLibraryGame}
            genreLabel={discoverGenre}
            topThisMonth={curatedForGenre?.topThisMonth}
            bestAllTime={curatedForGenre?.bestAllTime}
            newReleases={curatedForGenre?.newReleases}
            mostHyped={curatedForGenre?.mostHyped}
          />
        </div>
      )}

      {/* Main Grid View */}
      {discoverError && !loadingDiscover ? (
        <div className="border border-red-500/40 border-dashed rounded-none p-12 text-center flex flex-col items-center justify-center space-y-4">
          <Compass className="w-12 h-12 text-red-400 mb-1" />
          <h4 className="text-white font-black text-lg uppercase tracking-wider">Registry Uplink Lost</h4>
          <p className="text-brand-muted text-xs mt-1 max-w-sm">{discoverError}</p>
          <button
            type="button"
            onClick={() => (query.trim() ? searchDiscover(query) : fetchTrending())}
            className="mt-2 px-6 py-3 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink rounded-none text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4 stroke-[3]" />
            Reconnect
          </button>
        </div>
      ) : loadingDiscover && gamesToDisplay.length === 0 ? (
        <div className={`grid ${libraryGridClass(customizations.discoverColumns)} gap-4 animate-pulse`}>
          {[...Array(10)].map((_, i) => (
            <div key={i} className="aspect-[2/3] bg-zinc-900/50 border border-brand-border rounded-none" />
          ))}
        </div>
      ) : gamesToDisplay.length === 0 ? (
        <div className="border border-brand-border border-dashed rounded-none p-12 text-center flex flex-col items-center justify-center">
          <Compass className="w-12 h-12 text-brand-muted mb-4" />
          <h4 className="text-white font-black text-lg uppercase tracking-wider">No matching registries found</h4>
          <p className="text-brand-muted text-xs mt-1 max-w-sm">
            {discoverGenre
              ? `No ${discoverGenre} titles found${query.trim() ? ` for "${query.trim()}"` : " in the catalog"}. Try another genre or clear the filter.`
              : `No matches returned for "${query}". Try checking spelling or search a broader game franchise keyword.`}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Feed Divider */}
          {query.trim() && (
            <div className="pt-8 border-t border-brand-border/60">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <h3 className="text-xl sm:text-2xl font-black uppercase tracking-tight text-white">
                    Search Results
                  </h3>
                </div>
              </div>
            </div>
          )}

          {!query.trim() && <div className="pt-8 border-t border-brand-border/60" />}

          <div className={`grid ${libraryGridClass(customizations.discoverColumns)} gap-4`}>
            {gamesToDisplay.map((game) => {
              const libGame = getLibraryGame(game.igdb_id);
              return (
                <DiscoverGameCard
                  key={game.igdb_id || game.title}
                  game={game}
                  libGame={libGame}
                  wishlisted={isWishlisted(game.igdb_id)}
                  onClick={handleCardClick}
                  onAddGame={handleAddGame}
                  onAddWishlist={handleToggleWishlist}
                />
              );
            })}
          </div>

          {/* Infinite Scroll Sentinel & Loading Indicator */}
          <div ref={setSentinelNode} className="pt-10 pb-16 flex flex-col items-center justify-center gap-3 border-t border-brand-border/40 mt-12">
            {loadingDiscover ? (
              <div className="flex items-center gap-3">
                <Loader2 className="w-4 h-4 animate-spin text-brand-accent" />
                <span className="text-sm font-medium tracking-wide text-white">Loading more games…</span>
              </div>
            ) : coolingDown ? (
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium tracking-wide text-brand-muted">
                  Paused — the game registry is throttling requests. Resuming shortly…
                </span>
              </div>
            ) : hasMore ? (
              <div className="flex flex-col items-center gap-1.5">
                <span className="text-sm font-medium tracking-wide text-brand-muted">Scroll to load more games</span>
                <ChevronDown className="w-4 h-4 text-brand-accent animate-bounce" />
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1.5">
                <span className="text-sm font-medium tracking-wide text-brand-muted">
                  {query.trim()
                    ? "End of results — every match for this search is already on screen"
                    : discoverGenre
                      ? `End of the line — every ${discoverGenre} title in the ranked pool is already on screen`
                      : "End of the line — the whole ranked pool is already on screen"}
                </span>
                <span className="h-px w-12 bg-brand-border" />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Discover Game Details Popup Modal */}
      <AnimatePresence>
        {infoModalGame && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
            onClick={handleBackdropClick}
            className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto bg-black/90"
          >
            <motion.div
              ref={modalRef}
              initial={{ opacity: 0, y: 32 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              role="dialog"
              aria-modal="true"
              style={{ willChange: "transform" }}
              aria-labelledby="discover-modal-title"
              className="relative w-full max-w-4xl rounded-none border border-brand-border bg-brand-bg text-white shadow-2xl flex flex-col md:flex-row h-[85vh] md:h-[750px] overflow-y-auto md:overflow-hidden my-auto"
              onClick={(e) => e.stopPropagation()}
            >
            
            {/* Close Button — same square style as the library details modal */}
            <button
              onClick={() => {
                setInfoModalGame(null);
                setInfoModalDetails(null);
              }}
              aria-label="Close (Esc)"
              className="absolute right-4 top-4 z-10 w-[34px] h-[34px] rounded-none bg-zinc-950 border border-brand-border text-brand-muted hover:text-white transition-colors cursor-pointer flex items-center justify-center shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>

            {/* Left Side: Game Image & Actions */}
            <div className="w-full md:w-1/3 bg-zinc-950 p-6 flex flex-col justify-between border-r border-brand-border">
              <div className="space-y-5">
                <PosterImage
                  src={infoModalGame.poster_url}
                  alt={infoModalGame.title}
                  className="w-full aspect-[2/3] object-cover rounded-none border border-brand-border bg-zinc-900"
                />
                
                <div className="space-y-2">
                  <h3 id="discover-modal-title" className="text-xl font-black tracking-tight text-white uppercase">{infoModalGame.title}</h3>
                  <p className="text-xs text-brand-muted font-mono uppercase font-bold">
                    {infoModalGame.year ? `${infoModalGame.year} // ` : ""}{infoModalGame.genres?.join(", ") || "Unknown Genre"}
                  </p>
                  
                  <div className="flex flex-wrap gap-2 pt-1">
                    {customizations.showRatingBadge && infoModalGame.critic_score != null && (
                      <span className="px-2 py-0.5 rounded-none text-[11px] font-mono font-black bg-zinc-900 border border-brand-border text-brand-accent">
                        METACRITIC: {infoModalGame.critic_score}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="pt-6 border-t border-brand-border mt-6">
                {(() => {
                  const libGame = getLibraryGame(infoModalGame.igdb_id);
                  if (libGame) {
                    return (
                      <button
                        onClick={async () => {
                          await deleteGame(libGame.id);
                        }}
                        title="Remove from Library"
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-3 bg-emerald-500/10 border border-emerald-500/35 text-emerald-400 hover:bg-red-500/10 hover:border-red-500/35 hover:text-red-400 rounded-none text-xs font-black uppercase tracking-widest transition-colors cursor-pointer group"
                      >
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 group-hover:hidden" />
                        <Trash2 className="w-4 h-4 text-red-400 shrink-0 hidden group-hover:inline" />
                        <span className="group-hover:hidden">Registered</span>
                        <span className="hidden group-hover:inline">Remove</span>
                      </button>
                    );
                  }
                  return (
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleAddGame(infoModalDetails ?? infoModalGame)}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-3 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink rounded-none text-xs font-black uppercase tracking-widest transition-all cursor-pointer"
                      >
                        <Plus className="w-4 h-4 stroke-[3]" />
                        Add
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleToggleWishlist(infoModalDetails ?? infoModalGame);
                        }}
                        title={isWishlisted(infoModalGame.igdb_id) ? "Remove from wishlist" : "Add to wishlist"}
                        aria-label={isWishlisted(infoModalGame.igdb_id) ? "Remove from wishlist" : "Add to wishlist"}
                        aria-pressed={isWishlisted(infoModalGame.igdb_id)}
                        className={`shrink-0 flex items-center justify-center gap-1.5 px-3 py-3 border rounded-none text-[11px] font-black uppercase tracking-widest transition-colors cursor-pointer ${
                          isWishlisted(infoModalGame.igdb_id)
                            ? "bg-brand-accent/10 border-brand-accent/35 text-brand-accent hover:bg-brand-accent/20"
                            : "bg-transparent border-brand-border text-brand-muted hover:text-brand-accent"
                        }`}
                      >
                        {isWishlisted(infoModalGame.igdb_id) ? (
                          <Heart className="w-4 h-4 fill-brand-accent stroke-brand-accent" />
                        ) : (
                          <Heart className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Right Side: Scrollable Details */}
            <div className="flex-1 flex flex-col min-h-0 md:h-full md:overflow-hidden">
              
              {/* Header: Fixed at the top */}
              <div className="px-6 py-5 md:px-8 md:py-6 border-b border-brand-border/40 shrink-0 bg-brand-bg relative pr-16">
                <span className="text-[11px] font-mono font-bold tracking-widest text-brand-accent uppercase">Registry Directives</span>
                <h2 className="text-xl sm:text-2xl font-black text-white uppercase tracking-tight mt-1 truncate">
                  {infoModalGame.title}
                </h2>
              </div>

              {/* Scrollable Content Area */}
              <div className="flex-1 md:overflow-y-auto p-6 md:p-8 space-y-6 overscroll-contain">
                <div className="pt-2">
                  <h4 className="text-xs font-mono font-bold uppercase tracking-widest text-zinc-400 mb-2">About the Game</h4>
                  {loadingDetails ? (
                    <div className="flex flex-col items-center justify-center py-12 space-y-3">
                      <Loader2 className="w-8 h-8 animate-spin text-brand-accent" />
                      <span className="text-[11px] font-mono font-bold text-brand-muted uppercase tracking-wider">Retrieving details from registry...</span>
                    </div>
                  ) : (
                    <div className="text-zinc-300 text-xs sm:text-sm font-sans space-y-4 leading-relaxed pr-2 select-text">
                      {infoModalDetails?.synopsis ? (
                        infoModalDetails.synopsis.split('\n\n').map((paragraph: string, idx: number) => (
                          <p key={idx}>{paragraph}</p>
                        ))
                      ) : (
                        <p>No description available for this registry entry.</p>
                      )}
                    </div>
                  )}
                </div>
              </div>

            </div>

          </motion.div>
        </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
};

interface DiscoverGameCardProps {
  game: IGDBGame;
  libGame: Game | null;
  wishlisted: boolean;
  onClick: (game: IGDBGame) => void;
  onAddGame: (game: IGDBGame) => void;
  onAddWishlist: (game: IGDBGame) => void;
}

const DiscoverGameCard = React.memo<DiscoverGameCardProps>(({ 
  game, libGame, wishlisted, onClick, onAddGame, onAddWishlist 
}) => {
  const handleCardClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('button')) {
      return;
    }
    onClick(game);
  };

  return (
    <div
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCardClick(e);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`View details for ${game.title}`}
      className="group bg-transparent border border-brand-border rounded-none overflow-hidden hover:border-brand-accent/40 focus:outline-none focus:border-brand-accent transition-all duration-200 flex flex-col justify-between cursor-pointer"
    >
      {/* Poster Art with Hover overlay */}
      <div className="aspect-[2/3] relative overflow-hidden bg-zinc-950 border-b border-brand-border">
        <PosterImage
          src={game.poster_url}
          alt={game.title}
          className="w-full h-full object-cover group-hover:scale-102 transition-transform duration-200 transform-gpu will-change-transform"
        />
      </div>

      {/* Metadata & Quick Action */}
      <div className="p-4 flex-1 flex flex-col justify-between">
        <div>
          <h4 className="font-bold text-white text-sm line-clamp-1 uppercase tracking-tight">{game.title}</h4>
          <p className="block truncate whitespace-nowrap text-[11px] text-brand-muted mt-0.5 font-mono uppercase font-bold">
            {game.year ? `${game.year} // ` : ""}{(game.genres || []).slice(0, 1).join(" • ") || "Unknown Genre"}
          </p>
        </div>

        <div className="mt-4 pt-3 border-t border-brand-border">
          <div className="flex gap-2">
            {libGame ? (
              <div className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-500/10 border border-emerald-500/35 text-emerald-400 rounded-none text-[11px] font-black uppercase tracking-widest select-none">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                Registered
              </div>
            ) : (
              <button
                onClick={() => onAddGame(game)}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink rounded-none text-[11px] font-black uppercase tracking-widest transition-all cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 stroke-[3]" />
                Add
              </button>
            )}
            {!libGame && (
              <button
                onClick={() => onAddWishlist(game)}
                title={wishlisted ? "Remove from wishlist" : "Add to wishlist"}
                aria-label={wishlisted ? "Remove from wishlist" : "Add to wishlist"}
                aria-pressed={wishlisted}
                className={`w-[34px] flex items-center justify-center border rounded-none text-[11px] transition-colors cursor-pointer ${
                  wishlisted
                    ? "bg-brand-accent/10 border-brand-accent/40 text-brand-accent hover:bg-brand-accent/20"
                    : "bg-zinc-950 border-brand-border text-brand-muted hover:text-brand-accent hover:border-brand-accent/50"
                }`}
              >
                <Heart className={`w-3.5 h-3.5 ${wishlisted ? "fill-brand-accent stroke-brand-accent" : ""}`} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
DiscoverGameCard.displayName = "DiscoverGameCard";

interface TabbedCuratedSectionProps {
  loading: boolean;
  /** Active Discover genre filter ("" = all) — lists are already narrowed to it. */
  genreLabel: string;
  showRating?: boolean;
  onCardClick: (game: IGDBGame) => void;
  onAddGame: (game: IGDBGame) => void;
  onAddWishlist: (game: IGDBGame) => void;
  isWishlisted: (igdbId: number | null | undefined) => boolean;
  getLibraryGame: (igdbId: number | null) => Game | null;
  topThisMonth: IGDBGame[] | undefined;
  bestAllTime: IGDBGame[] | undefined;
  newReleases: IGDBGame[] | undefined;
  mostHyped: IGDBGame[] | undefined;
}

type CuratedTabId = "recent" | "alltime" | "new" | "hyped";

const TabbedCuratedSection: React.FC<TabbedCuratedSectionProps> = ({
  loading, genreLabel, showRating = true, onCardClick, onAddGame, onAddWishlist, isWishlisted, getLibraryGame,
  topThisMonth, bestAllTime, newReleases, mostHyped,
}) => {
  const [activeTab, setActiveTab] = useState<CuratedTabId>("recent");
  const trackRef = useRef<HTMLDivElement | null>(null);

  const tabs: { id: CuratedTabId; label: string; desc: string; games: IGDBGame[] | undefined }[] = [
    { id: "recent", label: "Recent Top Rated", desc: "The best releases of the last 90 days", games: topThisMonth },
    { id: "alltime", label: "Best of All Time", desc: "The highest critical scores on record", games: bestAllTime },
    { id: "new", label: "New Releases", desc: "The freshest drops in the catalog", games: newReleases },
    { id: "hyped", label: "Most Hyped", desc: "The loudest upcoming titles", games: mostHyped },
  ];

  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0]!;

  const scrollBy = (dir: 1 | -1) => {
    const track = trackRef.current;
    if (!track) return;
    const cardWidth = track.querySelector("[data-card]")?.clientWidth || 160;
    track.scrollBy({ left: dir * cardWidth * 3, behavior: "smooth" });
  };

  const switchTab = (id: CuratedTabId) => {
    setActiveTab(id);
    trackRef.current?.scrollTo({ left: 0 });
  };

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-5" role="tablist" aria-label="Curated lists">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`curated-panel-${tab.id}`}
              onClick={() => switchTab(tab.id)}
              className={`px-3.5 py-1.5 text-[11px] font-black uppercase tracking-wider border transition-colors cursor-pointer ${
                isActive
                  ? "bg-brand-accent text-brand-accent-ink border-brand-accent hover:bg-brand-accent-hover"
                  : "bg-zinc-950 border-brand-border text-brand-muted hover:text-white hover:border-brand-accent/50"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            type="button"
            onClick={() => scrollBy(-1)}
            aria-label={`Scroll ${active.label} left`}
            className="w-8 h-8 flex items-center justify-center bg-zinc-950 border border-brand-border text-brand-muted hover:text-white hover:border-brand-accent/50 transition-colors cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => scrollBy(1)}
            aria-label={`Scroll ${active.label} right`}
            className="w-8 h-8 flex items-center justify-center bg-zinc-950 border border-brand-border text-brand-muted hover:text-white hover:border-brand-accent/50 transition-colors cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex gap-4 overflow-hidden">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="w-36 sm:w-40 shrink-0 aspect-[2/3] bg-zinc-900/50 border border-brand-border rounded-none animate-pulse" />
          ))}
        </div>
      ) : active.games && active.games.length > 0 ? (
        <div
          ref={trackRef}
          id={`curated-panel-${active.id}`}
          role="tabpanel"
          aria-label={active.label}
          className="flex gap-4 overflow-x-auto no-scrollbar snap-x"
        >
          {active.games.map((game) => (
            <CuratedGameCard
              key={game.igdb_id}
              game={game}
              inLibrary={Boolean(getLibraryGame(game.igdb_id))}
              wishlisted={isWishlisted(game.igdb_id)}
              showRating={showRating}
              onClick={onCardClick}
              onAddGame={onAddGame}
              onAddWishlist={onAddWishlist}
            />
          ))}
        </div>
      ) : (
        <div className="border border-brand-border border-dashed p-8 text-center">
          <p className="text-brand-muted text-xs font-mono uppercase font-bold tracking-wider">
            {genreLabel
              ? `No ${genreLabel} titles in “${active.label}”`
              : "This list is empty right now"}
          </p>
        </div>
      )}
    </section>
  );
};

const CuratedGameCard = React.memo<{
  game: IGDBGame;
  inLibrary: boolean;
  wishlisted: boolean;
  showRating?: boolean;
  onClick: (game: IGDBGame) => void;
  onAddGame: (game: IGDBGame) => void;
  onAddWishlist: (game: IGDBGame) => void;
}>(({ game, inLibrary, wishlisted, showRating = true, onClick, onAddGame, onAddWishlist }) => {
  const handleClick = () => onClick(game);
  return (
    <div
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`View details for ${game.title}`}
      className="w-36 sm:w-40 shrink-0 snap-start group cursor-pointer focus:outline-none focus-visible:outline-2 focus-visible:outline-brand-accent focus-visible:outline-offset-2"
      data-card
    >
      <div className="relative aspect-[2/3] overflow-hidden bg-zinc-950 border border-brand-border group-hover:border-brand-accent/40 transition-colors">
        <PosterImage
          src={game.poster_url}
          alt={game.title}
          className="w-full h-full object-cover group-hover:scale-102 transition-transform duration-200 transform-gpu will-change-transform"
        />
        {inLibrary ? (
          <div
            className="absolute top-2 right-2 w-6 h-6 bg-emerald-500/90 border border-emerald-400 flex items-center justify-center shadow-sm z-10"
            title="In library"
            aria-label="In library"
          >
            <CheckCircle2 className="w-3.5 h-3.5 text-white" />
          </div>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddWishlist(game);
            }}
            title={wishlisted ? "Remove from wishlist" : "Add to wishlist"}
            aria-label={wishlisted ? "Remove from wishlist" : "Add to wishlist"}
            className={`absolute top-2 right-2 w-6 h-6 border flex items-center justify-center cursor-pointer transition-colors shadow-sm z-10 ${
              wishlisted
                ? "bg-brand-accent text-brand-accent-ink border-brand-accent hover:bg-brand-accent-hover"
                : "bg-zinc-950/90 text-brand-muted border-brand-border hover:text-brand-accent hover:border-brand-accent/60 backdrop-blur-sm"
            }`}
          >
            <Heart className={`w-3.5 h-3.5 ${wishlisted ? "fill-brand-accent-ink stroke-brand-accent-ink" : ""}`} />
          </button>
        )}
        {!inLibrary && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[1px] opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible transition-all duration-200 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAddGame(game);
              }}
              title="Add to library"
              aria-label={`Add ${game.title} to library`}
              className="w-11 h-11 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink border border-brand-accent shadow-2xl flex items-center justify-center cursor-pointer transform scale-75 group-hover:scale-100 transition-all duration-200"
            >
              <Plus className="w-6 h-6 stroke-[3]" />
            </button>
          </div>
        )}
        {showRating && game.critic_score != null && (
          <div className="absolute bottom-2 right-2 bg-zinc-950/90 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-mono font-black text-brand-accent border border-brand-border shadow-sm">
            {game.critic_score}
          </div>
        )}
      </div>
      <h5 className="font-bold text-white text-xs uppercase tracking-tight mt-2 line-clamp-1">{game.title}</h5>
      <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-brand-muted mt-0.5">
        {game.year || "TBA"}
      </p>
    </div>
  );
});
CuratedGameCard.displayName = "CuratedGameCard";

export default DiscoverView;
