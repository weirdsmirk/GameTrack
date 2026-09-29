import React, { useState, useEffect, useRef } from "react";
import { useGameTrackStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { Plus, Gamepad, Calendar, List, ChevronDown, X, Star, Heart } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useModalA11y } from "../hooks/useModalA11y";
import { uploadPoster, upgradeIgdbPosterUrl } from "../utils/image";
import { mergeCustomPlatforms } from "../constants";
import { IGDBGame } from "../types";

export const AddGameModal: React.FC = React.memo(() => {
  const {
    isAddGameOpen, setAddGameOpen, addGame, updateGame, showToast,
    games, wishlist, addToWishlist, customPlatforms, openPlayingConflict,
    customizations
  } = useGameTrackStore(useShallow((s) => ({
    isAddGameOpen: s.isAddGameOpen, setAddGameOpen: s.setAddGameOpen,
    addGame: s.addGame, updateGame: s.updateGame, showToast: s.showToast,
    games: s.games, wishlist: s.wishlist, addToWishlist: s.addToWishlist,
    customPlatforms: s.customPlatforms, openPlayingConflict: s.openPlayingConflict,
    customizations: s.customizations,
  })));
  const showCriticScores = customizations.showRatingBadge;

  const availablePlatforms = React.useMemo(() => mergeCustomPlatforms(customPlatforms), [customPlatforms]);
  const [target, setTarget] = useState<"library" | "wishlist">("library");
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [genres, setGenres] = useState("");
  const [synopsis, setSynopsis] = useState("");
  const [posterUrl, setPosterUrl] = useState("");
  const [criticScore, setCriticScore] = useState("");
  const [playtimeHours, setPlaytimeHours] = useState("0");
  const [playtimeMinutes, setPlaytimeMinutes] = useState("0");
  const [personalRating, setPersonalRating] = useState("");
  const [status, setStatus] = useState<"backlog" | "playing" | "completed" | "endless">("backlog");
  const [submitting, setSubmitting] = useState(false);
  const [ratingHover, setRatingHover] = useState<number | null>(null);
  const ratingValue = personalRating === "" ? 0 : parseInt(personalRating, 10) || 0;
  
  // Platform selection state
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);

  // Autocomplete states
  const [suggestions, setSuggestions] = useState<IGDBGame[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [igdbId, setIgdbId] = useState<number | null>(null);
  const [selectedTitle, setSelectedTitle] = useState("");

  const suggestionsRef = useRef<HTMLDivElement>(null);
  const posterFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!title.trim() || title.length < 3 || title === selectedTitle) {
      setSuggestions([]);
      setLoadingSuggestions(false);
      setShowSuggestions(false);
      return;
    }

    const controller = new AbortController();
    const delayDebounceFn = setTimeout(async () => {
      setLoadingSuggestions(true);
      setShowSuggestions(true);
      try {
        const res = await fetch(`/api/discover/search?q=${encodeURIComponent(title)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          setSuggestions(data);
          setShowSuggestions(true);
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) return; // stale request — ignore
        console.error("Failed to fetch suggestions", err);
        showToast("Game registry lookup failed. Try again in a moment.", "error");
      } finally {
        if (!controller.signal.aborted) setLoadingSuggestions(false);
      }
    }, 250); // 250ms debounce — suggestions stay responsive without spamming the registry proxy

    return () => {
      clearTimeout(delayDebounceFn);
      controller.abort(); // cancel in-flight search when the query changes
    };
  }, [title, selectedTitle, showToast]);

  const handlePlatformChange = (platformId: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(platformId)
        ? prev.filter((id) => id !== platformId)
        : [...prev, platformId]
    );
  };

  const handleAddGameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    const trimmedTitle = title.trim();
    if (target === "library") {
      const duplicate = games.some((g) => g.title.toLowerCase() === trimmedTitle.toLowerCase());
      if (duplicate) {
        showToast(`"${trimmedTitle}" is already in your library`, "error");
        return;
      }
    } else {
      const inLibrary = games.some(
        (g) => g.title.toLowerCase() === trimmedTitle.toLowerCase() || (igdbId != null && g.igdb_id === igdbId)
      );
      const inWishlist = wishlist.some(
        (w) => w.title.toLowerCase() === trimmedTitle.toLowerCase() || (igdbId != null && w.igdb_id === igdbId)
      );
      if (inLibrary || inWishlist) {
        showToast(`"${trimmedTitle}" is already in your library or wishlist`, "error");
        return;
      }
    }

    if (year) {
      const yearNum = parseInt(year, 10);
      if (isNaN(yearNum) || yearNum < 1950 || yearNum > 2100) {
        showToast("Release Year must be between 1950 and 2100", "error");
        return;
      }
    }

    if (showCriticScores && criticScore) {
      const scoreNum = parseInt(criticScore, 10);
      if (isNaN(scoreNum) || scoreNum < 0 || scoreNum > 100) {
        showToast("Critic Score must be between 0 and 100", "error");
        return;
      }
    }

    if (personalRating) {
      const ratingNum = parseInt(personalRating, 10);
      if (isNaN(ratingNum) || ratingNum < 0 || ratingNum > 10) {
        showToast("Personal Rating must be between 0 and 10", "error");
        return;
      }
    }

    const hoursNum = parseFloat(playtimeHours || "0");
    const minutesNum = parseFloat(playtimeMinutes || "0");
    if (
      isNaN(hoursNum) || !Number.isFinite(hoursNum) || hoursNum < 0 ||
      isNaN(minutesNum) || !Number.isFinite(minutesNum) || minutesNum < 0
    ) {
      showToast("Playtime must be a positive number", "error");
      return;
    }
    const playtimeNum = parseFloat((hoursNum + minutesNum / 60).toFixed(2));

    setSubmitting(true);
    try {
      const genresArray = genres
        .split(",")
        .map((g) => g.trim())
        .filter((g) => g.length > 0);

      const commonPayload = {
        title: trimmedTitle,
        year: year ? parseInt(year, 10) : null,
        igdb_id: igdbId,
        genres: genresArray,
        synopsis: synopsis.trim(),
        poster_url: posterUrl.trim(),
        critic_score: showCriticScores && criticScore ? parseInt(criticScore, 10) : null,
        owned_platforms: selectedPlatforms,
      };

      if (target === "wishlist") {
        // addToWishlist already toasts success + failure — no second toast here.
        const ok = await addToWishlist(commonPayload);
        if (ok) {
          resetForm();
          setAddGameOpen(false);
        }
        return;
      }

      const executeAdd = async (finalStatus: "backlog" | "playing" | "completed" | "endless" = status) => {
        const success = await addGame({
          ...commonPayload,
          playtime: playtimeNum,
          personal_rating: personalRating ? parseInt(personalRating, 10) : null,
          status: finalStatus,
        });

        if (success) {
          resetForm();
          setAddGameOpen(false);
          showToast("Game registered", "success", trimmedTitle);
        } else {
          showToast("Failed to register game", "error");
        }
      };

      if (target === "library" && status === "playing") {
        const currentlyPlaying = games.find((g) => g.status === "playing");
        if (currentlyPlaying) {
          openPlayingConflict({
            currentGame: currentlyPlaying,
            pendingTitle: trimmedTitle,
            onConfirmSwitch: async (action) => {
              await updateGame(currentlyPlaying.id, {
                status: action === "completed" ? "completed" : "backlog",
                ...(action === "completed" ? { date_completed: Date.now() } : {}),
              });
              await executeAdd("playing");
            },
          });
          return;
        }
      }

      await executeAdd();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "An unexpected error occurred", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setTitle("");
    setYear("");
    setGenres("");
    setSynopsis("");
    setPosterUrl("");
    setCriticScore("");
    setPlaytimeHours("0");
    setPlaytimeMinutes("0");
    setPersonalRating("");
    setRatingHover(null);
    setStatus("backlog");
    setSelectedPlatforms([]);
    setIgdbId(null);
    setSelectedTitle("");
    setSuggestions([]);
  };

  const modalRef = useModalA11y(isAddGameOpen);

  // Fresh form on every open — never show the previous entry's leftovers.
  // resetForm is intentionally not a dependency: it is recreated each render,
  // so listing it would reset the form on every keystroke. The dep that
  // matters is the open flag.
  useEffect(() => {
    if (isAddGameOpen) resetForm();
  }, [isAddGameOpen]);

  useEffect(() => {
    if (!isAddGameOpen) return;
    document.body.style.overflow = "hidden";
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAddGameOpen(false);
      }
    };
    
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAddGameOpen, setAddGameOpen]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setAddGameOpen(false);
    }
  };

  return (
    <AnimatePresence>
      {isAddGameOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
          onClick={handleBackdropClick}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 bg-black/90"
        >
          <motion.div
            ref={modalRef}
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            role="dialog"
            aria-modal="true"
            style={{ willChange: "transform" }}
            aria-labelledby="add-game-modal-title"
            className="relative w-full max-w-2xl h-[90vh] md:h-auto md:max-h-[92vh] rounded-none border border-brand-border bg-brand-bg text-white shadow-2xl flex flex-col my-auto"
            onClick={(e) => e.stopPropagation()}
          >
            
            {/* Modal Header */}
            <div className="flex items-center justify-between gap-3 border-b border-brand-border p-5">
              <div className="flex items-center gap-2 min-w-0">
                {target === "wishlist" ? (
                  <Heart className="w-5 h-5 text-brand-accent fill-brand-accent" />
                ) : (
                  <Plus className="w-5 h-5 text-brand-accent stroke-[3]" />
                )}
                <h3 id="add-game-modal-title" className="text-sm font-black uppercase tracking-widest truncate">
                  {target === "wishlist" ? "Add to Wishlist" : "Register New Game"}
                </h3>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="flex items-center gap-1 border border-brand-border bg-zinc-950 p-1" role="tablist" aria-label="Registration target">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={target === "library"}
                    onClick={() => setTarget("library")}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors cursor-pointer ${
                      target === "library"
                        ? "bg-brand-accent text-brand-accent-ink"
                        : "text-brand-muted hover:text-white"
                    }`}
                  >
                    <Gamepad className="w-3 h-3" />
                    Library
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={target === "wishlist"}
                    onClick={() => setTarget("wishlist")}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors cursor-pointer ${
                      target === "wishlist"
                        ? "bg-brand-accent text-brand-accent-ink"
                        : "text-brand-muted hover:text-white"
                    }`}
                  >
                    <Heart className={`w-3 h-3 ${target === "wishlist" ? "fill-brand-accent-ink" : ""}`} />
                    Wishlist
                  </button>
                </div>
                <button
                  onClick={() => setAddGameOpen(false)}
                  aria-label="Close (Esc)"
                  className="w-[34px] h-[34px] rounded-none bg-zinc-950 border border-brand-border text-brand-muted hover:text-white transition-colors cursor-pointer flex items-center justify-center shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

        {/* Modal Form */}
        <form onSubmit={handleAddGameSubmit} className="flex-1 flex flex-col min-h-0">
          
          {/* Scrollable Form Fields */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6 overscroll-contain md:h-[min(620px,70vh)] md:min-h-[min(620px,70vh)]">
          
          {/* Title */}
          <div className="space-y-1.5">
            <label htmlFor="add-game-title" className="text-[11px] font-bold uppercase tracking-wider text-brand-muted">
              Game Title <span className="text-red-400">*</span>
            </label>
            <div className="relative" ref={suggestionsRef}>
              <Gamepad className="absolute left-3.5 top-3.5 w-4 h-4 text-brand-muted" />
              <input
                id="add-game-title"
                type="text"
                required
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (e.target.value !== selectedTitle) {
                    setIgdbId(null);
                  }
                }}
                onFocus={() => setShowSuggestions(true)}
                placeholder="ENTER GAME TITLE..."
                className="w-full pl-10 pr-4 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wider text-white placeholder-zinc-600 focus:outline-none focus:border-brand-accent"
              />

              {/* Autocomplete Suggestions */}
              {showSuggestions && (loadingSuggestions || suggestions.length > 0) && (
                <div role="listbox" aria-label="Game title suggestions" className="absolute left-0 right-0 top-full mt-1 bg-zinc-950 border border-brand-border shadow-2xl z-50 max-h-60 overflow-y-auto overscroll-contain">
                  {loadingSuggestions ? (
                    <div className="flex items-center gap-2 p-3 text-brand-muted text-[11px]">
                      <div className="w-3 h-3 border-2 border-brand-accent border-t-transparent rounded-full animate-spin"></div>
                      RETRIEVING MATCHED REGISTRY DATA...
                    </div>
                  ) : (
                    suggestions.map((suggestion) => {
                      const applySuggestion = () => {
                        setTitle(suggestion.title);
                        setSelectedTitle(suggestion.title);
                        setIgdbId(suggestion.igdb_id || null);
                        setYear(suggestion.year ? suggestion.year.toString() : "");
                        setGenres(suggestion.genres ? suggestion.genres.join(", ") : "");
                        setSynopsis(suggestion.synopsis || "");
                        setPosterUrl(suggestion.poster_url || "");
                        setCriticScore(showCriticScores && suggestion.critic_score ? suggestion.critic_score.toString() : "");
                        setShowSuggestions(false);
                      };
                      return (
                      <div
                        key={suggestion.igdb_id ?? suggestion.title}
                        onClick={applySuggestion}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            applySuggestion();
                          }
                        }}
                        tabIndex={0}
                        role="option"
                        aria-selected={title === suggestion.title}
                        className="flex items-center gap-3 p-2.5 hover:bg-brand-accent/[0.03] cursor-pointer border-b border-brand-border/40 last:border-none transition-colors text-left focus:bg-zinc-900 focus:outline-none"
                      >
                        {suggestion.poster_url ? (
                          <img
                            src={(upgradeIgdbPosterUrl(suggestion.poster_url) as string) || suggestion.poster_url}
                            alt=""
                            referrerPolicy="no-referrer"
                            className="w-8 h-10 object-cover border border-brand-border/60 shrink-0"
                          />
                        ) : (
                          <div className="w-8 h-10 bg-zinc-900 border border-brand-border/40 flex items-center justify-center shrink-0">
                            <Gamepad className="w-4 h-4 text-brand-muted" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] font-black uppercase text-white truncate tracking-wider">
                            {suggestion.title}
                          </p>
                          <div className="flex items-center gap-2 text-[11px] text-brand-muted mt-0.5">
                            {suggestion.year && <span>{suggestion.year}</span>}
                            {suggestion.year && suggestion.genres?.length > 0 && <span>•</span>}
                            {suggestion.genres?.length > 0 && (
                              <span className="truncate">{suggestion.genres.slice(0, 2).join(", ")}</span>
                            )}
                          </div>
                        </div>
                        {showCriticScores && suggestion.critic_score != null && (
                          <div className="bg-zinc-900 border border-brand-border/60 px-1.5 py-0.5 text-[11px] font-bold text-brand-accent">
                            {suggestion.critic_score}
                          </div>
                        )}
                      </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Release Year */}
            <div className="space-y-1.5">
              <label htmlFor="add-game-year" className="text-[11px] font-bold uppercase tracking-wider text-brand-muted">Release Year</label>
              <div className="relative">
                <Calendar className="absolute left-3.5 top-3.5 w-4 h-4 text-brand-muted" />
                <input
                  id="add-game-year"
                  type="number"
                  min="1950"
                  max="2100"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  placeholder="E.g. 2023"
                  className="w-full pl-10 pr-4 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wider text-white placeholder-zinc-600 focus:outline-none focus:border-brand-accent"
                />
              </div>
            </div>

            {/* Genres */}
            <div className="space-y-1.5">
              <label htmlFor="add-game-genres" className="text-[11px] font-bold uppercase tracking-wider text-brand-muted">Genres</label>
              <div className="relative">
                <List className="absolute left-3.5 top-3.5 w-4 h-4 text-brand-muted" />
                <input
                  id="add-game-genres"
                  type="text"
                  value={genres}
                  onChange={(e) => setGenres(e.target.value)}
                  placeholder="RPG, ACTION, ADVENTURE"
                  className="w-full pl-10 pr-4 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wider text-white placeholder-zinc-600 focus:outline-none focus:border-brand-accent"
                />
              </div>
            </div>
          </div>

          {/* Personal Rating — clickable 0–10 rating boxes */}
          {target === "library" && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="add-game-rating" className="text-[11px] font-bold uppercase tracking-wider text-brand-muted">
                Personal Rating
              </label>
              <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-widest">
                <span className={`w-1.5 h-1.5 ${ratingValue > 0 ? "bg-brand-accent" : "bg-zinc-600"}`} />
                <span className={ratingValue > 0 ? "text-brand-accent" : "text-brand-muted"}>
                  {ratingValue > 0 ? `Rated ${ratingValue}/10` : "Unrated"}
                </span>
              </span>
            </div>
            <div className="grid grid-cols-5 sm:grid-cols-11 gap-1" role="radiogroup" aria-label="Personal rating">
              <button
                type="button"
                title="Clear rating"
                aria-label="Clear rating"
                onClick={() => {
                  setPersonalRating("");
                  setRatingHover(null);
                }}
                className={`aspect-square w-full text-[11px] font-sans font-black border transition-colors duration-100 cursor-pointer flex items-center justify-center ${
                  ratingValue > 0
                    ? "bg-zinc-950 border-brand-border text-white hover:border-red-500/60 hover:text-red-400"
                    : "bg-zinc-950 border-brand-border text-brand-muted hover:text-white"
                }`}
              >
                <X className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
                const active = ratingHover !== null ? n <= ratingHover : n <= ratingValue;
                return (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={ratingValue === n}
                    onClick={() => setPersonalRating(ratingValue === n ? "" : String(n))}
                    onMouseEnter={() => setRatingHover(n)}
                    onMouseLeave={() => setRatingHover(null)}
                    className={`aspect-square w-full text-[11px] font-sans font-black border transition-colors duration-100 cursor-pointer select-none ${
                      active
                        ? "bg-brand-accent border-brand-accent text-brand-accent-ink"
                        : "bg-zinc-950 border-brand-border text-brand-muted hover:border-brand-accent/60 hover:text-white"
                    }`}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Playtime */}
            {target === "library" && (
            <div className="space-y-1.5">
              <label htmlFor="add-game-hours" className="text-[11px] font-bold uppercase tracking-wider text-brand-muted">Playtime</label>
              <div className="flex gap-2">
                <div className="relative flex-1 min-w-0">
                  <input
                    id="add-game-hours"
                    type="number"
                    min="0"
                    step="0.1"
                    value={playtimeHours}
                    onChange={(e) => setPlaytimeHours(e.target.value)}
                    placeholder="0"
                    className="w-full pl-4 pr-7 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wider text-white placeholder-zinc-600 focus:outline-none focus:border-brand-accent"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-black text-brand-muted pointer-events-none">H</span>
                </div>
                <div className="relative flex-1 min-w-0">
                  <input
                    id="add-game-minutes"
                    type="number"
                    min="0"
                    step="1"
                    value={playtimeMinutes}
                    onChange={(e) => setPlaytimeMinutes(e.target.value)}
                    placeholder="0"
                    className="w-full pl-4 pr-7 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wider text-white placeholder-zinc-600 focus:outline-none focus:border-brand-accent"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-black text-brand-muted pointer-events-none">M</span>
                </div>
              </div>
            </div>
            )}

            {/* Critic Score */}
            {showCriticScores && (
            <div className="space-y-1.5">
              <label htmlFor="add-game-critic" className="text-[11px] font-bold uppercase tracking-wider text-brand-muted">Critic Score (0-100)</label>
              <div className="relative">
                <Star className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-brand-muted" />
                <input
                  id="add-game-critic"
                  type="number"
                  min="0"
                  max="100"
                  value={criticScore}
                  onChange={(e) => setCriticScore(e.target.value)}
                  placeholder="E.g. 92"
                  className="w-full pl-10 pr-4 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wider text-white placeholder-zinc-600 focus:outline-none focus:border-brand-accent"
                />
              </div>
            </div>
            )}

            {/* Status */}
            {target === "library" && (
            <div className="space-y-1.5">
              <label htmlFor="add-game-status" className="text-[11px] font-bold uppercase tracking-wider text-brand-muted">Current Status</label>
              <div className="relative">
                <select
                  id="add-game-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as "backlog" | "playing" | "completed" | "endless")}
                  className="w-full pl-4 pr-10 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-black uppercase tracking-wider text-white focus:outline-none focus:border-brand-accent cursor-pointer appearance-none disabled:cursor-not-allowed"
                >
                  <option value="backlog">Backlog</option>
                  <option value="playing">Playing</option>
                  <option value="completed">Completed</option>
                  <option value="endless">Endless</option>
                </select>
                <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-brand-muted">
                  <ChevronDown className="w-4 h-4" />
                </div>
              </div>
            </div>
            )}
          </div>

          {/* Platforms Selection (Checkboxes) */}
          <div className="space-y-1.5">
              <label className="text-[11px] font-bold uppercase tracking-wider text-brand-muted">Owned Platforms</label>
              <div className="flex flex-wrap gap-1.5">
                {availablePlatforms.map((platform) => (
                  <label
                    key={platform.id}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-none border text-[11px] font-black uppercase tracking-wider transition-colors cursor-pointer ${
                      selectedPlatforms.includes(platform.id)
                        ? "bg-brand-accent border-brand-accent text-brand-accent-ink"
                        : "bg-transparent border-brand-border text-brand-muted hover:text-white hover:border-brand-accent/40"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedPlatforms.includes(platform.id)}
                      onChange={() => handlePlatformChange(platform.id)}
                      className="sr-only"
                    />
                    <span className={`w-1.5 h-1.5 rounded-none border shrink-0 ${
                      selectedPlatforms.includes(platform.id)
                        ? "bg-brand-accent-ink border-brand-accent-ink"
                        : "border-brand-muted"
                    }`} />
                    {platform.label}
                  </label>
                ))}
              </div>
            </div>

          {/* Poster URL & Custom Upload */}
          <div className="space-y-1.5">
            <label htmlFor="add-game-poster" className="text-[11px] font-bold uppercase tracking-wider text-brand-muted">Poster Image</label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id="add-game-poster"
                type="text"
                value={posterUrl}
                onChange={(e) => setPosterUrl(e.target.value)}
                placeholder="https://example.com/poster.jpg"
                className="flex-1 px-4 py-2.5 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wider text-white placeholder-zinc-600 focus:outline-none focus:border-brand-accent"
              />
              <button
                type="button"
                onClick={() => posterFileInputRef.current?.click()}
                className="px-4 py-2.5 bg-transparent border border-brand-border text-xs font-bold uppercase tracking-wider text-zinc-300 hover:text-white focus-visible:outline-2 focus-visible:outline-brand-accent cursor-pointer text-center select-none shrink-0 flex items-center justify-center"
              >
                Upload Poster
              </button>
              <input
                ref={posterFileInputRef}
                type="file"
                accept="image/*"
                tabIndex={-1}
                aria-hidden="true"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  // Reset so picking the same file twice still fires onChange.
                  e.target.value = "";
                  if (file) {
                    try {
                      const url = await uploadPoster(file);
                      setPosterUrl(url);
                    } catch (err: unknown) {
                      showToast(err instanceof Error ? err.message : "Failed to upload poster", "error");
                    }
                  }
                }}
              />
              {posterUrl && (
                <button
                  type="button"
                  onClick={() => setPosterUrl("")}
                  className="px-4 py-2.5 bg-red-600/10 border border-red-500/35 text-xs font-bold uppercase tracking-wider text-red-400 hover:bg-red-600 hover:text-brand-on-color cursor-pointer select-none shrink-0"
                >
                  Remove Poster
                </button>
              )}
            </div>
          </div>
          
          </div>

          {/* Modal Footer */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-brand-border bg-zinc-950/40 px-6 py-5 shrink-0">
            <button
              type="button"
              onClick={() => setAddGameOpen(false)}
              disabled={submitting}
              className="py-3 px-4 bg-transparent text-brand-muted hover:text-white border border-brand-border rounded-none text-xs font-black uppercase tracking-widest transition-all cursor-pointer text-center disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              className="py-3 px-4 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink border border-brand-accent rounded-none text-xs font-black uppercase tracking-widest transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-center"
            >
              {submitting ? "Adding..." : target === "wishlist" ? "Add to Wishlist" : "Add to Library"}
            </button>
          </div>
        </form>

        </motion.div>
      </motion.div>
      )}
    </AnimatePresence>
  );
});
export default AddGameModal;
