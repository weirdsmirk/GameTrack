import React, { useEffect, useState, useCallback, useRef } from "react";
import { useGameTrackStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import {
  Search, SlidersHorizontal, Plus, RefreshCw, ChevronDown, X, Trophy, GripVertical, Heart, CheckSquare, Check, Trash2, Loader2,
  Bookmark, Play, Repeat
} from "lucide-react";
import { Game } from "../types";

import { STATUSES, getStatusLabel, getStatusMarkerColor, platformIdMatches, mergeCustomPlatforms, libraryGridClass } from "../constants";
import { PosterImage } from "./PosterImage";

export const LibraryView: React.FC = () => {
  const { 
    games, loadingGames, filters, setFilter, resetFilters, fetchGames, 
    setSelectedGame, setAddGameOpen, updateCustomOrder, clearCustomOrder,
    customizations, wishlist, setActiveTab, customPlatforms, gamesError,
    deleteGames,
    searchFocusToken,
  } = useGameTrackStore(useShallow(s => ({
    games: s.games, loadingGames: s.loadingGames, filters: s.filters,
    setFilter: s.setFilter, resetFilters: s.resetFilters, fetchGames: s.fetchGames,
    setSelectedGame: s.setSelectedGame, setAddGameOpen: s.setAddGameOpen,
    updateCustomOrder: s.updateCustomOrder, clearCustomOrder: s.clearCustomOrder,
    customizations: s.customizations,
    wishlist: s.wishlist, setActiveTab: s.setActiveTab, customPlatforms: s.customPlatforms,
    gamesError: s.gamesError,
    deleteGames: s.deleteGames,
    searchFocusToken: s.searchFocusToken,
  })));

  const availablePlatforms = React.useMemo(() => mergeCustomPlatforms(customPlatforms), [customPlatforms]);

  const [localSearch, setLocalSearch] = useState(filters.search);
  const [showFilters, setShowFilters] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchFocusToken > 0) searchInputRef.current?.focus();
  }, [searchFocusToken]);

  // Stay in sync when the filter is changed elsewhere (e.g. reset) — but
  // never clobber text the user is actively typing.
  useEffect(() => {
    if (document.activeElement !== searchInputRef.current) {
      setLocalSearch(filters.search);
    }
  }, [filters.search]);

  // Multi-select & Batch Delete state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Measure the panel's natural height so the open/close runs as a pure CSS
  // transition on an exact px value (no per-frame JS animation).
  const filtersPanelRef = useRef<HTMLDivElement>(null);
  const [filtersPanelHeight, setFiltersPanelHeight] = useState(0);

  useEffect(() => {
    const el = filtersPanelRef.current;
    if (!el) return;
    if (!showFilters) {
      setFiltersPanelHeight(0);
      return;
    }
    const measure = () => setFiltersPanelHeight(el.scrollHeight);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [showFilters, filters.status, filters.platform, filters.hideCompleted, filters.hideEndless]);

  // Only offer statuses/platforms that actually exist in the current library
  const statusOptions = React.useMemo(() => {
    const present = new Set<string>(games.map((g) => g.status));
    const list = STATUSES.filter((s) => present.has(s.value));
    // Keep a persisted filter value in the list even if no game currently
    // has that status, otherwise the <select> renders blank.
    if (filters.status && !present.has(filters.status)) {
      const label = getStatusLabel(filters.status);
      list.unshift({ value: filters.status as (typeof list)[number]["value"], label });
    }
    return list;
  }, [games, filters.status]);

  const platformOptions = React.useMemo(() => {
    const present = new Set<string>();
    games.forEach((g) => (g.owned_platforms || []).forEach((p) => present.add(p)));
    const list = availablePlatforms.filter((p) =>
      [...present].some((pid) => platformIdMatches(p.id, pid))
    );
    if (filters.platform && !list.some((p) => p.id === filters.platform)) {
      const label = availablePlatforms.find((p) => p.id === filters.platform)?.label ?? filters.platform;
      list.unshift({ id: filters.platform, label });
    }
    return list;
  }, [games, availablePlatforms, filters.platform]);

  // Trigger search on submit or debounce
  useEffect(() => {
    const delayDebounceFn = setTimeout(() => {
      setFilter("search", localSearch);
    }, 250);

    return () => clearTimeout(delayDebounceFn);
  }, [localSearch, setFilter]);

  useEffect(() => {
    fetchGames();
  }, [fetchGames]);

  const handleReset = () => {
    setLocalSearch("");
    resetFilters();
  };

  const activeFiltersCount = React.useMemo(
    () =>
      (filters.status ? 1 : 0) +
      (filters.platform ? 1 : 0) +
      (filters.sort !== "recent" ? 1 : 0) +
      (filters.hideCompleted ? 1 : 0) +
      (filters.hideEndless ? 1 : 0),
    [filters.status, filters.platform, filters.sort, filters.hideCompleted, filters.hideEndless]
  );

  // Client-side search/filter/sort within games loaded
  const filteredGames = React.useMemo(() => {
    const list = games.filter((game) => {
      if (filters.status && game.status !== filters.status) return false;
      if (filters.hideCompleted && game.status === "completed") return false;
      if (filters.hideEndless && game.status === "endless") return false;

      if (filters.platform) {
        const platforms = game.owned_platforms || [];
        if (!platforms.some((p) => platformIdMatches(filters.platform, p))) return false;
      }

      if (filters.search) {
        const searchLower = filters.search.toLowerCase();
        const titleLower = (game.title || "").toLowerCase();
        const matches =
          titleLower.includes(searchLower) ||
          (game.genres || []).some((genre) => genre.toLowerCase().includes(searchLower)) ||
          (game.synopsis || "").toLowerCase().includes(searchLower);
        if (!matches) return false;
      }

      return true;
    });

    list.sort((a, b) => {
      switch (filters.sort) {
        case "rating":
          return (b.personal_rating ?? -1) - (a.personal_rating ?? -1);
        case "playtime_asc":
          return (a.playtime ?? 0) - (b.playtime ?? 0);
        case "playtime":
          return (b.playtime ?? 0) - (a.playtime ?? 0);
        case "title":
          return a.title.localeCompare(b.title);
        case "custom":
          return (a.custom_order ?? Infinity) - (b.custom_order ?? Infinity) ||
            (b.date_added ?? 0) - (a.date_added ?? 0);
        default:
          return (b.date_added ?? 0) - (a.date_added ?? 0);
      }
    });

    return list;
  }, [games, filters]);

  const handleCardClick = useCallback((game: Game) => {
    if (selectMode) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(game.id)) next.delete(game.id);
        else next.add(game.id);
        return next;
      });
      return;
    }
    setSelectedGame(game);
  }, [selectMode, setSelectedGame]);

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(filteredGames.map((g) => g.id)));
  }, [filteredGames]);

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
    const ok = await deleteGames(ids);
    setBulkDeleting(false);
    if (ok) {
      exitSelectMode();
    }
  };

  // ── Custom hand-arranged order (drag & drop) ────────────────────
  const isCustomOrder = filters.sort === "custom";
  // Live draft of the visible list while a drag is in progress.
  const [dragOrder, setDragOrder] = useState<Game[] | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);

  const visibleList = dragOrder ?? filteredGames;

  const handleDragStart = useCallback((game: Game) => {
    setDraggingId(game.id);
    setDragOrder(filteredGames); // snapshot the visible sequence
  }, [filteredGames]);

  const handleDragOverCard = useCallback((target: Game) => {
    if (draggingId === null || target.id === draggingId) return;
    setDragOrder((prev) => {
      if (!prev) return prev;
      const from = prev.findIndex((g) => g.id === draggingId);
      const to = prev.findIndex((g) => g.id === target.id);
      if (from === -1 || to === -1 || from === to) return prev;
      const copy = [...prev];
      const [moved] = copy.splice(from, 1);
      if (!moved) return prev;
      copy.splice(to, 0, moved);
      return copy;
    });
  }, [draggingId]);

  const handleDragEnd = useCallback(async () => {
    const draft = dragOrder;
    setDraggingId(null);
    if (!draft || !isCustomOrder) {
      setDragOrder(null);
      return;
    }

    // Map the reordered *visible* sequence back onto the full library while
    // preserving the relative order of games hidden by active filters.
    const lib = [...games].sort((a, b) =>
      (a.custom_order ?? Infinity) - (b.custom_order ?? Infinity) ||
      (b.date_added ?? 0) - (a.date_added ?? 0)
    );
    const draftIds = new Set(draft.map((g) => g.id));
    const rest = lib.filter((g) => !draftIds.has(g.id));
    const firstVisible = lib.findIndex((g) => draftIds.has(g.id));
    const fullOrder = firstVisible === -1
      ? [...draft, ...rest]
      : [...rest.slice(0, firstVisible), ...draft, ...rest.slice(firstVisible)];

    // The server requires the order to cover the whole library. If the
    // library changed mid-drag (auto Steam sync, import), the snapshot no
    // longer matches — skip the save and let a fresh fetch restore reality.
    if (fullOrder.length !== games.length) {
      setDragOrder(null);
      fetchGames(true);
      return;
    }

    // Keep the dragged layout visible until the server confirms the save,
    // so the grid never flashes back to the previous order mid-request.
    const ok = await updateCustomOrder(fullOrder.map((g) => g.id));
    setDragOrder(null);
    if (!ok) fetchGames(true);
  }, [dragOrder, isCustomOrder, games, updateCustomOrder, fetchGames]);



  return (
    <div className="space-y-10">
      
      {/* Header and Add Action */}
      <div className="flex flex-col lg:flex-row justify-between lg:items-end gap-6">
        <div>
          {/* Huge Display Hero Title */}
          <h1 className="text-6xl sm:text-8xl lg:text-[110px] font-black tracking-tighter leading-[0.85] uppercase text-white font-sans select-none mb-3">
            GAME<br />LIBRARY
          </h1>
          <p className="max-w-xl text-brand-muted text-sm sm:text-base font-medium leading-relaxed">
            Review, manage, and log your game library.
          </p>
        </div>
        
        <div className="flex gap-3 shrink-0">
          <button
            id="lib-add-game-btn"
            onClick={() => setAddGameOpen(true)}
            className="flex items-center gap-2 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink px-6 py-3 rounded-none text-xs font-black uppercase tracking-wider transition-all cursor-pointer"
          >
            <Plus className="w-4 h-4 stroke-[3px]" />
            Add Game
          </button>
          <button
            onClick={() => setActiveTab("wishlist")}
            title={`Open Wishlist${wishlist.length > 0 ? ` (${wishlist.length})` : ""}`}
            aria-label={`Open wishlist (${wishlist.length} items)`}
            className="relative p-3 bg-transparent border border-brand-border text-brand-muted hover:text-white transition-all cursor-pointer"
          >
            <Heart className="w-4 h-4" />
            {wishlist.length > 0 && (
              <span className="absolute -top-2 -right-2 h-[18px] min-w-[18px] px-1 bg-brand-accent text-brand-accent-ink text-[10px] font-mono font-black flex items-center justify-center border border-brand-bg">
                {wishlist.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className={`${showFilters ? "space-y-4" : ""}`}>
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Search Input */}
          <div className="relative flex-1">
            <label htmlFor="library-search" className="sr-only">Search games</label>
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-brand-muted" />
            <input
              ref={searchInputRef}
              id="library-search"
              type="text"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder="Filter by title..."
              className="w-full pl-11 pr-10 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-mono uppercase tracking-wider text-white placeholder-zinc-600 focus:outline-none focus:border-brand-accent transition-colors"
            />
            {localSearch && (
              <button
                type="button"
                onClick={() => setLocalSearch("")}
                aria-label="Clear search query"
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-brand-muted hover:text-white cursor-pointer flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Filters Toggle Button */}
          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            className={`px-5 py-2.5 border rounded-none text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer select-none shrink-0 h-[38px] ${
              showFilters 
                ? "bg-brand-accent border-brand-accent text-brand-accent-ink font-black" 
                : "bg-zinc-950 border-brand-border text-white hover:bg-brand-accent/[0.03]"
            }`}
          >
            <SlidersHorizontal className="w-4 h-4" />
            <span>Filters</span>
            {activeFiltersCount > 0 && (
              <span className={`ml-1 px-1.5 py-0.5 text-[11px] font-mono font-black ${showFilters ? "bg-black text-brand-on-color" : "bg-brand-accent text-brand-accent-ink"}`}>
                {activeFiltersCount}
              </span>
            )}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${showFilters ? "rotate-180" : ""}`} />
          </button>

          {/* Select Mode Toggle */}
          <button
            type="button"
            onClick={() => {
              if (selectMode) exitSelectMode();
              else setSelectMode(true);
            }}
            className={`px-4 py-2.5 border rounded-none text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer select-none shrink-0 h-[38px] ${
              selectMode
                ? "bg-brand-accent border-brand-accent text-brand-accent-ink font-black"
                : "bg-zinc-950 border-brand-border text-white hover:bg-brand-accent/[0.03]"
            }`}
            title={selectMode ? "Exit Select Mode" : "Select Multiple Games"}
          >
            <CheckSquare className="w-4 h-4" />
            <span className="hidden sm:inline">{selectMode ? "Exit Select" : "Select"}</span>
          </button>
        </div>

        {/* Collapsible Filters Panel — native CSS height transition on a measured
          px value. No JS-driven per-frame animation, so it stays buttery
          even with the selects inside. */}
        <div
          ref={filtersPanelRef}
          style={{ height: showFilters ? filtersPanelHeight : 0 }}
          className="overflow-hidden transition-[height] duration-[160ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {/* Status Selector */}
              <div className="relative">
                  <label htmlFor="filter-status" className="block text-[11px] font-mono font-bold uppercase tracking-wider text-brand-muted mb-1">Status</label>
                  <div className="relative">
                    <select
                      id="filter-status"
                      value={filters.status}
                      onChange={(e) => setFilter("status", e.target.value)}
                      className="w-full pl-3 pr-10 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-black uppercase tracking-wider text-white focus:outline-none focus:border-brand-accent cursor-pointer appearance-none"
                    >
                      <option value="">All Statuses</option>
                      {statusOptions.map(s => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                    <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-brand-muted">
                      <ChevronDown className="w-4 h-4" />
                    </div>
                  </div>
                </div>

              {/* Platform Selector */}
              <div className="relative">
                <label htmlFor="filter-platform" className="block text-[11px] font-mono font-bold uppercase tracking-wider text-brand-muted mb-1">Platform</label>
                <div className="relative">
                  <select
                    id="filter-platform"
                    value={filters.platform}
                    onChange={(e) => setFilter("platform", e.target.value)}
                    className="w-full pl-3 pr-10 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-black uppercase tracking-wider text-white focus:outline-none focus:border-brand-accent cursor-pointer appearance-none"
                  >
                    <option value="">All Platforms</option>
                    {platformOptions.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-brand-muted">
                    <ChevronDown className="w-4 h-4" />
                  </div>
                </div>
              </div>

              {/* Sort Order Selector */}
              <div className="relative">
                <label htmlFor="filter-sort" className="block text-[11px] font-mono font-bold uppercase tracking-wider text-brand-muted mb-1">Sort By</label>
                <div className="relative">
                  <select
                    id="filter-sort"
                    value={filters.sort}
                    onChange={(e) => setFilter("sort", e.target.value)}
                    className="w-full pl-3 pr-10 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-black uppercase tracking-wider text-white focus:outline-none focus:border-brand-accent cursor-pointer appearance-none"
                  >
                    <option value="recent">Recently Added</option>
                    <option value="rating">Highest Rating</option>
                    <option value="playtime">Most Playtime</option>
                    <option value="playtime_asc">Least Playtime</option>
                    <option value="title">Alphabetical (A-Z)</option>
                    <option value="custom">Custom Order (Drag to Arrange)</option>
                  </select>
                  <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-brand-muted">
                    <ChevronDown className="w-4 h-4" />
                  </div>
                </div>
              </div>

              {/* Visibility toggles — same row as the selects. justify-end
                  drops each 38px control to the baseline of the select boxes
                  below their labels, so all six cells line up. The switch
                  itself is the button: a <button> nested in a <label> was
                  invalid and gave the control two competing hit areas. */}
              <div className="flex flex-col justify-end">
                <button
                  type="button"
                  role="switch"
                  aria-checked={filters.hideCompleted}
                  aria-label="Hide completed games"
                  onClick={() => setFilter("hideCompleted", !filters.hideCompleted)}
                  className={`w-full h-[38px] px-3 flex items-center justify-between gap-2 border cursor-pointer transition-colors ${
                    filters.hideCompleted
                      ? "border-brand-accent/60 bg-brand-accent/10"
                      : "border-brand-border bg-zinc-950 hover:border-brand-accent/50"
                  }`}
                >
                  <span className="text-xs font-semibold text-zinc-300">Hide Completed</span>
                  <span
                    aria-hidden="true"
                    className={`relative w-11 h-6 shrink-0 border transition-colors ${
                      filters.hideCompleted ? "bg-brand-accent border-brand-accent" : "bg-zinc-900 border-brand-border"
                    }`}
                  >
                    <span className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 transition-all duration-200 ${filters.hideCompleted ? "left-[22px] bg-brand-accent-ink" : "left-0.5 bg-brand-muted"}`} />
                  </span>
                </button>
              </div>

              <div className="flex flex-col justify-end">
                <button
                  type="button"
                  role="switch"
                  aria-checked={filters.hideEndless}
                  aria-label="Hide endless games"
                  onClick={() => setFilter("hideEndless", !filters.hideEndless)}
                  className={`w-full h-[38px] px-3 flex items-center justify-between gap-2 border cursor-pointer transition-colors ${
                    filters.hideEndless
                      ? "border-brand-accent/60 bg-brand-accent/10"
                      : "border-brand-border bg-zinc-950 hover:border-brand-accent/50"
                  }`}
                >
                  <span className="text-xs font-semibold text-zinc-300">Hide Endless</span>
                  <span
                    aria-hidden="true"
                    className={`relative w-11 h-6 shrink-0 border transition-colors ${
                      filters.hideEndless ? "bg-brand-accent border-brand-accent" : "bg-zinc-900 border-brand-border"
                    }`}
                  >
                    <span className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 transition-all duration-200 ${filters.hideEndless ? "left-[22px] bg-brand-accent-ink" : "left-0.5 bg-brand-muted"}`} />
                  </span>
                </button>
              </div>

              {/* Reset Filters button */}
              <div className="flex flex-col justify-end">
                <button
                  onClick={handleReset}
                  className="w-full py-2.5 bg-transparent border border-brand-border rounded-none text-xs font-black uppercase tracking-wider text-brand-muted hover:text-white transition-colors flex items-center justify-center gap-2 h-[38px] cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Reset Filters
                </button>
              </div>
            </div>
        </div>
        </div>

      {/* Custom Order hint bar */}
      {isCustomOrder && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-brand-accent/30 bg-brand-accent/5 px-4 py-2.5 rounded-none">
          <p className="flex items-center gap-2 text-[11px] font-mono font-bold uppercase tracking-widest text-brand-accent">
            <GripVertical className="w-4 h-4 shrink-0" />
            Drag cards to arrange your library — order saves automatically
          </p>
          <div className="flex items-center gap-2">
            {dragOrder !== null && (
              <button
                type="button"
                onClick={() => { setDragOrder(null); setDraggingId(null); }}
                className="px-3 py-1.5 bg-transparent border border-brand-border rounded-none text-[11px] font-black uppercase tracking-wider text-brand-muted hover:text-white transition-colors cursor-pointer"
              >
                Discard Changes
              </button>
            )}
            <button
              type="button"
              onClick={async () => {
                await clearCustomOrder();
                setDragOrder(null);
                setDraggingId(null);
              }}
              className="px-3 py-1.5 bg-zinc-950 hover:bg-red-500/10 border border-brand-border hover:border-red-500/35 rounded-none text-[11px] font-black uppercase tracking-wider text-brand-muted hover:text-red-400 transition-colors cursor-pointer"
            >
              Reset Order
            </button>
          </div>
        </div>
      )}

      {/* Batch Action Bar */}
      {selectMode && (
        <div className="bg-zinc-950 border border-brand-border p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono font-black uppercase tracking-widest text-brand-accent bg-brand-accent/10 border border-brand-accent/30 px-2.5 py-1">
              {selectedIds.size} SELECTED
            </span>
            <button
              type="button"
              onClick={selectedIds.size === filteredGames.length && filteredGames.length > 0 ? deselectAll : selectAll}
              className="text-xs font-sans font-bold uppercase tracking-wider text-zinc-400 hover:text-white underline cursor-pointer"
            >
              {selectedIds.size === filteredGames.length && filteredGames.length > 0 ? "Deselect All" : `Select All (${filteredGames.length})`}
            </button>
          </div>

          <div className="flex items-center gap-2">
            {showDeleteConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-red-400 font-bold uppercase hidden sm:inline">
                  Delete {selectedIds.size} {selectedIds.size === 1 ? "game" : "games"}?
                </span>
                <button
                  type="button"
                  disabled={bulkDeleting}
                  onClick={handleBulkDelete}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-black uppercase tracking-wider rounded-none cursor-pointer transition-all flex items-center gap-1.5"
                >
                  {bulkDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Confirm Delete
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
              <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                disabled={selectedIds.size === 0}
                onClick={() => setShowDeleteConfirm(true)}
                className="px-4 py-2 bg-transparent hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/40 text-brand-muted disabled:opacity-40 disabled:hover:bg-brand-accent/[0.03] disabled:hover:text-brand-muted disabled:hover:border-brand-border border border-brand-border text-xs font-black uppercase tracking-wider rounded-none cursor-pointer transition-all flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4 text-red-400" />
                <span>Delete ({selectedIds.size})</span>
              </button>
              </div>
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

      {/* Grid View */}
      {loadingGames ? (
        <div className={`grid ${libraryGridClass(customizations.libraryColumns)} ${customizations.density === "compact" ? "gap-2" : "gap-4"} animate-pulse`}>
          {[...Array(10)].map((_, i) => (
            <div key={i} className="aspect-[2/3] bg-zinc-900/50 border border-brand-border rounded-none" />
          ))}
        </div>
      ) : gamesError && games.length === 0 ? (
        <div className="border border-brand-border border-dashed rounded-none p-16 text-center flex flex-col items-center justify-center">
          <RefreshCw className="w-12 h-12 text-brand-muted mb-4" />
          <h4 className="text-white font-black text-lg uppercase tracking-wider">Couldn&apos;t Load Library</h4>
          <p className="text-brand-muted text-sm mt-1 max-w-sm">{gamesError}</p>
          <button
            onClick={() => fetchGames(true)}
            className="mt-6 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink px-6 py-2.5 text-xs font-black uppercase tracking-wider transition-all rounded-none cursor-pointer"
          >
            Retry
          </button>
        </div>
      ) : filteredGames.length === 0 ? (
        <div className="border border-brand-border border-dashed rounded-none p-16 text-center flex flex-col items-center justify-center">
          <SlidersHorizontal className="w-12 h-12 text-brand-muted mb-4" />
          <h4 className="text-white font-black text-lg uppercase tracking-wider">
            {games.length === 0 ? "Empty Registry" : "No Search Matches"}
          </h4>
          <p className="text-brand-muted text-sm mt-1 max-w-sm">
            {games.length === 0
              ? "Your library is empty. Add your first game manually or import it from Steam."
              : "No search matches. Try adjusting active database filters or insert a new custom game title manually."}
          </p>
          <button
            onClick={games.length === 0 ? () => setAddGameOpen(true) : handleReset}
            className="mt-6 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink px-6 py-2.5 text-xs font-black uppercase tracking-wider transition-all rounded-none cursor-pointer"
          >
            {games.length === 0 ? "Add First Game" : "Clear Filters"}
          </button>
        </div>
      ) : (
        <div className={`grid ${libraryGridClass(customizations.libraryColumns)} ${customizations.density === "compact" ? "gap-2" : "gap-4"}`}>
          {visibleList.map((game) => (
            <LibraryGameCard
              key={game.id}
              game={game}
              onClick={handleCardClick}
              reorderable={isCustomOrder && !selectMode}
              isDragging={draggingId === game.id}
              onDragStart={handleDragStart}
              onDragOverCard={handleDragOverCard}
              onDragEnd={handleDragEnd}
              showRating={customizations.showRatingBadge}
              density={customizations.density}
              selectMode={selectMode}
              selected={selectedIds.has(game.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      )}

    </div>
  );
};

/** Per-status corner badge icons — mirrors the completion trophy style. */
const STATUS_MARKER_ICONS: Record<Game["status"], typeof Trophy> = {
  backlog: Bookmark,
  playing: Play,
  completed: Trophy,
  endless: Repeat,
};

interface LibraryGameCardProps {
  game: Game;
  onClick: (game: Game) => void;
  reorderable?: boolean;
  isDragging?: boolean;
  onDragStart?: (game: Game) => void;
  onDragOverCard?: (game: Game) => void;
  onDragEnd?: () => void;
  showRating?: boolean;
  density?: "comfortable" | "compact";
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
}

const LibraryGameCard = React.memo<LibraryGameCardProps>(({ 
  game, onClick, reorderable, isDragging, onDragStart, onDragOverCard, onDragEnd, showRating = true,
  density = "comfortable",
  selectMode = false, selected = false, onToggleSelect 
}) => {
  const handleCardClick = () => {
    if (selectMode) {
      onToggleSelect?.(game.id);
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
          handleCardClick();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`${selectMode ? (selected ? "Deselect" : "Select") : "View details for"} ${game.title}`}
      aria-pressed={selectMode ? selected : undefined}
      draggable={reorderable}
      onDragStart={reorderable ? (e) => { e.dataTransfer.setData("text/plain", String(game.id)); e.dataTransfer.effectAllowed = "move"; onDragStart?.(game); } : undefined}
      onDragOver={reorderable ? (e) => { e.preventDefault(); onDragOverCard?.(game); } : undefined}
      onDragEnd={reorderable ? (e) => { e.preventDefault(); onDragEnd?.(); } : undefined}
      title={reorderable ? "Drag to reorder" : undefined}
      className={`group bg-transparent rounded-none overflow-hidden cursor-pointer focus:outline-none focus-visible:outline-2 focus-visible:outline-brand-accent focus-visible:outline-offset-2 transition-all duration-200 relative flex flex-col justify-between border border-brand-border ${
        selectMode && selected
          ? "ring-2 ring-brand-accent/50 bg-brand-accent/[0.04] border-brand-accent"
          : ""
      } ${reorderable ? "cursor-grab active:cursor-grabbing" : ""} ${isDragging ? "opacity-25" : ""}`}
    >
      {/* Game Poster Container */}
      <div className="aspect-[2/3] relative overflow-hidden bg-zinc-950 shrink-0">
        {/* Selection Checkbox Badge */}
        {selectMode && (
          <div className="absolute top-2.5 left-2.5 z-20">
            <div
              className={`w-6 h-6 border rounded-none flex items-center justify-center transition-all ${
                selected
                  ? "bg-brand-accent text-brand-accent-ink border-brand-accent shadow-md"
                  : "bg-black/70 border-zinc-400/60 text-transparent hover:border-brand-accent"
              }`}
            >
              {selected && <Check className="w-4 h-4 stroke-[3]" />}
            </div>
          </div>
        )}

        {/* Status badge — small square icon badge at the top-left corner;
            every status matches the completion trophy badge style */}
        {!selectMode && (() => {
          const StatusIcon = STATUS_MARKER_ICONS[game.status] ?? Bookmark;
          return (
            <div
              role="img"
              aria-label={`Status: ${getStatusLabel(game.status)}`}
              title={getStatusLabel(game.status)}
              className={`absolute top-2.5 left-2.5 ${density === "compact" ? "p-1" : "p-1.5"} z-10 shadow-lg border ${getStatusMarkerColor(game.status)}`}
            >
              <StatusIcon className="w-3.5 h-3.5 stroke-[2.5]" />
            </div>
          );
        })()}
        <PosterImage
          src={game.poster_url}
          alt={game.title}
          className="w-full h-full object-cover group-hover:scale-102 transition-transform duration-200 transform-gpu will-change-transform"
        />

        {/* Score Floating Badge */}
        {showRating && game.critic_score != null && (
          <div className={`absolute top-2.5 right-2.5 bg-zinc-950/90 backdrop-blur-sm ${density === "compact" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-[11px]"} font-mono font-black text-brand-accent border border-brand-border z-10 shadow-sm`}>
            {game.critic_score}
          </div>
        )}
      </div>
    </div>
  );
});
LibraryGameCard.displayName = "LibraryGameCard";

export default LibraryView;
