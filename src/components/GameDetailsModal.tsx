import React, { useState, useEffect, useRef } from "react";
import { useGameTrackStore } from "../store";
import {
  X, Trash2, Edit2, Trophy, EyeOff, ImageUp, RotateCcw, Link2, Loader2, ChevronDown, Check
} from "lucide-react";
import { formatPlaytimePrecise } from "../utils/time";
import { motion, AnimatePresence } from "motion/react";
import { uploadPoster } from "../utils/image";
import { useModalA11y } from "../hooks/useModalA11y";
import { STATUSES, getStatusBadgeColor, getStatusLabel, platformIdMatches, mergeCustomPlatforms } from "../constants";
import { PosterImage } from "./PosterImage";
export const GameDetailsModal: React.FC = React.memo(() => {
  const {
    selectedGame, setSelectedGame, updateGame, deleteGame,
    syncGameSynopsis, resetGamePoster, resetGameMetadata,
    showToast, customPlatforms, customizations,
    games, openPlayingConflict,
  } = useGameTrackStore();

  const availablePlatforms = React.useMemo(() => mergeCustomPlatforms(customPlatforms), [customPlatforms]);

  const [isEditing, setIsEditing] = useState(false);
  const [editStatus, setEditStatus] = useState<"backlog" | "playing" | "completed" | "endless">("backlog");
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [dateCompleted, setDateCompleted] = useState("");
  const [genres, setGenres] = useState("");
  const [synopsis, setSynopsis] = useState("");
  const [posterUrl, setPosterUrl] = useState("");
  const [criticScore, setCriticScore] = useState("");
  const [personalRating, setPersonalRating] = useState("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [hidePlaytime, setHidePlaytime] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  // Quick status picker — the full-width status button in the sidebar opens
  // this instead of forcing the user through the whole edit form.
  const [statusPickerOpen, setStatusPickerOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);

  // Change Poster modal — URL entry or device upload.
  const [posterModalOpen, setPosterModalOpen] = useState(false);
  const [posterUrlInput, setPosterUrlInput] = useState("");
  const [posterSaving, setPosterSaving] = useState(false);
  const [resettingMetadata, setResettingMetadata] = useState(false);

  // Hours played (edit form)
  const [hoursPlayed, setHoursPlayed] = useState("");
  const [minutesPlayed, setMinutesPlayed] = useState("");
  const [ratingHover, setRatingHover] = useState<number | null>(null);
  const ratingValue = personalRating === "" ? 0 : parseInt(personalRating, 10) || 0;

  // True once the user types in the synopsis textarea; while set, background
  // synopsis refreshes (IGDB auto-sync) must not clobber their in-progress edit.
  const synopsisDirtyRef = useRef(false);

  // Only re-initialize the form when the *selected game changes* (new id),
  // not when the same game's data is refreshed in the store (poster upload,
  // IGDB sync, Steam sync). Otherwise uploading a poster would discard the
  // user's in-progress edits and kick them out of edit mode.
  const lastGameIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!selectedGame) {
      lastGameIdRef.current = null;
      return;
    }
    if (selectedGame.id === lastGameIdRef.current) return;
    lastGameIdRef.current = selectedGame.id;

    setTitle(selectedGame.title);
    setYear(selectedGame.year?.toString() || "");
    setDateCompleted(selectedGame.date_completed ? new Date(selectedGame.date_completed).toISOString().slice(0, 10) : "");
    setGenres(selectedGame.genres?.join(", ") || "");
    setSynopsis(selectedGame.synopsis);
    synopsisDirtyRef.current = false;
    setPosterUrl(selectedGame.poster_url);
    setCriticScore(selectedGame.critic_score?.toString() || "");
    setHidePlaytime(selectedGame.hide_playtime === 1);
    setEditStatus(
      (["backlog", "playing", "completed", "endless"] as const).includes(
        selectedGame.status as "backlog" | "playing" | "completed" | "endless"
      )
        ? (selectedGame.status as "backlog" | "playing" | "completed" | "endless")
        : "backlog"
    );
    setPersonalRating(selectedGame.personal_rating?.toString() || "");
    setRatingHover(null);
    // Stored platform values may be aliases ("ps5", "PlayStation 5"...) —
    // canonicalize them to the checkbox ids so toggles match and saving
    // doesn't strip platforms.
    setSelectedPlatforms(
      availablePlatforms
        .map((p) => p.id)
        .filter((pid) => (selectedGame.owned_platforms || []).some((p) => platformIdMatches(pid, p)))
    );
    setIsEditing(false);
    setDeleteConfirm(false);
    closePosterModal();

    // Initialize hours + minutes to represent the current playtime
    const totalPlaytime = selectedGame.playtime || 0;
    const hoursFloor = Math.floor(totalPlaytime);
    const minutesRounding = Math.round((totalPlaytime - hoursFloor) * 60);
    setHoursPlayed((hoursFloor + Math.floor(minutesRounding / 60)).toString());
    setMinutesPlayed((minutesRounding % 60).toString());

    // Automatically sync from IGDB if description is missing
    if (selectedGame.igdb_id && (!selectedGame.synopsis || selectedGame.synopsis === "No synopsis available." || selectedGame.synopsis === "No details provided." || selectedGame.synopsis.trim() === "")) {
      syncGameSynopsis(selectedGame.id, selectedGame.igdb_id);
    }
  }, [selectedGame, syncGameSynopsis]);

  // Mirror background synopsis refreshes (auto IGDB sync, poster uploads) into
  // the local form state so entering edit mode later shows the fresh text —
  // unless the user is mid-edit on the synopsis field.
  useEffect(() => {
    if (synopsisDirtyRef.current) return;
    if (!selectedGame || selectedGame.id !== lastGameIdRef.current) return;
    setSynopsis(selectedGame.synopsis);
  }, [selectedGame?.synopsis, selectedGame?.id]);
  const handlePlatformToggle = (platformId: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(platformId)
        ? prev.filter((id) => id !== platformId)
        : [...prev, platformId]
    );
  };

  const handleSaveChanges = async () => {
    if (!selectedGame) return;
    if (!title.trim()) {
      showToast("Game title is required", "error");
      return;
    }

    if (year) {
      const yearNum = parseInt(year, 10);
      if (isNaN(yearNum) || yearNum < 1950 || yearNum > 2100) {
        showToast("Release Year must be between 1950 and 2100", "error");
        return;
      }
    }

    if (criticScore) {
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

    const hoursNum = parseFloat(hoursPlayed || "0");
    const minutesNum = parseFloat(minutesPlayed || "0");
    if (
      isNaN(hoursNum) || !Number.isFinite(hoursNum) || hoursNum < 0 ||
      isNaN(minutesNum) || !Number.isFinite(minutesNum) || minutesNum < 0
    ) {
      showToast("Playtime must be a positive number", "error");
      return;
    }

    const calculatedPlaytime = parseFloat((hoursNum + minutesNum / 60).toFixed(2));
    const genresArray = genres
      .split(",")
      .map((g) => g.trim())
      .filter((g) => g.length > 0);

    setSaving(true);
    try {
      const targetStatus = editStatus as "backlog" | "playing" | "completed" | "endless";
      const basePayload = {
        title: title.trim(),
        year: year ? parseInt(year, 10) : null,
        genres: genresArray,
        synopsis: synopsis.trim(),
        critic_score: criticScore ? parseInt(criticScore, 10) : null,
        playtime: calculatedPlaytime,
        personal_rating: personalRating ? parseInt(personalRating, 10) : null,
        owned_platforms: selectedPlatforms,
        hide_playtime: hidePlaytime ? 1 : 0,
        status: targetStatus,
        date_completed: dateCompleted ? new Date(dateCompleted + "T00:00:00").getTime() : (targetStatus === "completed" && !selectedGame.date_completed ? Date.now() : selectedGame.date_completed ?? null),
      };

      // "Playing" is exclusive: if another game is playing, offer to park it.
      if (targetStatus === "playing" && selectedGame.status !== "playing") {
        const currentlyPlaying = games.find((g) => g.status === "playing" && g.id !== selectedGame.id);
        if (currentlyPlaying) {
          openPlayingConflict({
            currentGame: currentlyPlaying,
            pendingTitle: basePayload.title,
            onConfirmSwitch: async (action) => {
              await updateGame(currentlyPlaying.id, {
                status: action === "completed" ? "completed" : "backlog",
                ...(action === "completed" ? { date_completed: Date.now() } : {}),
              });
              const success = await updateGame(selectedGame.id, basePayload);
              if (success) {
                setIsEditing(false);
                synopsisDirtyRef.current = false;
                showToast("Game updated", "success", "All changes saved");
              }
            },
          });
          setSaving(false);
          return;
        }
      }

      const success = await updateGame(selectedGame.id, basePayload);

      if (success) {
        setIsEditing(false);
        synopsisDirtyRef.current = false;
        showToast("Game updated", "success", "All changes saved");
      } else {
        showToast("Failed to save updates", "error");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "An unexpected error occurred";
      showToast(msg, "error");
    } finally {
      setSaving(false);
    }
  };


  /**
   * Change status without entering the edit form. Mirrors the two rules the
   * full save path enforces: "playing" is exclusive (another playing title gets
   * parked, via the existing conflict dialog), and moving to "completed"
   * stamps date_completed if it was never set.
   */
  const handleQuickStatus = async (next: "backlog" | "playing" | "completed" | "endless") => {
    if (!selectedGame || next === selectedGame.status) {
      setStatusPickerOpen(false);
      return;
    }
    setStatusBusy(true);
    try {
      const stamp = next === "completed" && !selectedGame.date_completed
        ? { date_completed: Date.now() }
        : {};

      if (next === "playing") {
        const currentlyPlaying = games.find((g) => g.status === "playing" && g.id !== selectedGame.id);
        if (currentlyPlaying) {
          openPlayingConflict({
            currentGame: currentlyPlaying,
            pendingTitle: selectedGame.title,
            onConfirmSwitch: async (action) => {
              await updateGame(currentlyPlaying.id, {
                status: action === "completed" ? "completed" : "backlog",
                ...(action === "completed" ? { date_completed: Date.now() } : {}),
              });
              await updateGame(selectedGame.id, { status: next, ...stamp });
              showToast("Status updated", "success", `${selectedGame.title} is now ${getStatusLabel(next).toLowerCase()}`);
            },
          });
          setStatusPickerOpen(false);
          return;
        }
      }

      const success = await updateGame(selectedGame.id, { status: next, ...stamp });
      if (success) {
        setStatusPickerOpen(false);
        showToast("Status updated", "success", `${selectedGame.title} is now ${getStatusLabel(next).toLowerCase()}`);
      } else {
        showToast("Failed to update status", "error");
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "An unexpected error occurred", "error");
    } finally {
      setStatusBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedGame) return;
    const success = await deleteGame(selectedGame.id);
    if (success) {
      setSelectedGame(null);
    }
    setDeleteConfirm(false);
  };

  // Poster actions — save immediately, independent of edit mode.
  const closePosterModal = () => {
    setPosterModalOpen(false);
    setPosterUrlInput("");
    setPosterSaving(false);
  };

  const handleUploadPoster = async (file: File) => {
    if (!selectedGame) return;
    setPosterSaving(true);
    try {
      const url = await uploadPoster(file);
      const ok = await updateGame(selectedGame.id, { poster_url: url });
      if (ok) {
        setPosterUrl(url);
        showToast("Poster updated", "success", selectedGame.title);
        closePosterModal();
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Failed to upload poster", "error");
    } finally {
      setPosterSaving(false);
    }
  };

  const handleApplyPosterUrl = async () => {
    if (!selectedGame) return;
    const url = posterUrlInput.trim();
    if (!/^https?:\/\//i.test(url)) {
      showToast("Enter a valid image URL (https://…)", "error");
      return;
    }
    setPosterSaving(true);
    try {
      const ok = await updateGame(selectedGame.id, { poster_url: url });
      if (ok) {
        setPosterUrl(url);
        showToast("Poster updated", "success", selectedGame.title);
        closePosterModal();
      }
    } finally {
      setPosterSaving(false);
    }
  };

  // Reset restores the default poster: the Steam artwork for Steam-owned
  // games, the IGDB cover for everything else linked to IGDB.
  const handleResetPoster = async () => {
    if (!selectedGame) return;
    const restored = await resetGamePoster(selectedGame.id);
    if (restored !== null) {
      setPosterUrl(restored);
      showToast(
        "Poster reset",
        "success",
        selectedGame.steam_appid != null ? "Restored the Steam artwork" : "Restored the IGDB cover"
      );
    }
  };

  // Edit Metadata → Reset: pull every metadata field back to the IGDB
  // defaults and refill the form. User data (status, playtime, rating,
  // platforms) is untouched server-side.
  const handleResetMetadata = async () => {
    if (!selectedGame) return;
    setResettingMetadata(true);
    try {
      const data = await resetGameMetadata(selectedGame.id);
      if (!data) return;
      setTitle(data.title);
      setYear(data.year?.toString() || "");
      setGenres(data.genres?.join(", ") || "");
      setSynopsis(data.synopsis);
      synopsisDirtyRef.current = false;
      setPosterUrl(data.poster_url);
      setCriticScore(data.critic_score?.toString() || "");
    } finally {
      setResettingMetadata(false);
    }
  };

  // Using imported getStatusBadgeColor from constants

  // Outer trap pauses while a nested dialog is open, which gets its own trap —
  // Tab then cycles the inner dialog instead of the background form. The
  // status picker is nested the same way the poster dialog is.
  const modalRef = useModalA11y(Boolean(selectedGame) && !posterModalOpen && !statusPickerOpen);
  const posterModalRef = useModalA11y(posterModalOpen);
  const statusPickerRef = useModalA11y(statusPickerOpen);

  // Set when the user presses inside the panel; a subsequent click landing on
  // the backdrop after a drag-select is then ignored (see handleBackdropClick).
  const dragStartRef = useRef(false);

  useEffect(() => {
    if (!selectedGame) return;
    document.body.style.overflow = "hidden";
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (statusPickerOpen) {
          setStatusPickerOpen(false);
        } else if (posterModalOpen) {
          closePosterModal();
        } else if (isEditing) {
          setIsEditing(false);
        } else {
          handleClose();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedGame, setSelectedGame, isEditing, posterModalOpen, statusPickerOpen, showToast]);

  const handleClose = () => {
    setSelectedGame(null);
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      if (dragStartRef.current) {
        // Text was drag-selected inside the panel and released over the
        // backdrop — treat it as a selection drag, not a close click.
        dragStartRef.current = false;
        return;
      }
      if (statusPickerOpen) {
        setStatusPickerOpen(false);
      } else if (posterModalOpen) {
        closePosterModal();
      } else if (isEditing) {
        setIsEditing(false);
      } else {
        handleClose();
      }
    }
  };

  return (
    <>
    <AnimatePresence>
      {selectedGame && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
          onClick={handleBackdropClick}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) dragStartRef.current = false;
          }}
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
            aria-labelledby="details-modal-title"
            onMouseDown={() => { dragStartRef.current = true; }}
            className="relative w-full max-w-4xl rounded-none border border-brand-border bg-brand-bg text-white shadow-2xl flex flex-col md:flex-row h-[90vh] md:h-[820px] my-auto"
            onClick={(e) => e.stopPropagation()}
          >
        


        {/* Left Side: Game Image & Actions */}
        <div className="w-full md:w-1/3 bg-zinc-950 p-6 flex flex-col justify-between border-r border-brand-border md:overflow-y-auto overscroll-contain shrink-0">
          <div className="space-y-5">
            <div className="relative w-full aspect-[2/3] shrink-0 group">
              {(selectedGame.status === "completed") && (
                <div className="absolute top-2.5 left-2.5 bg-brand-accent text-zinc-950 p-1.5 z-10 shadow-lg border border-brand-accent">
                  <Trophy className="w-3.5 h-3.5 text-zinc-950 stroke-[2.5]" />
                </div>
              )}
              <PosterImage
                src={posterUrl}
                alt={selectedGame.title}
                className="w-full h-full object-cover rounded-none border border-brand-border bg-zinc-900"
              />

              {/* Poster actions — custom posters can only be set/reset while
                  editing metadata (hidden entirely on the read-only view) */}
              {isEditing && (
                <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px] opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible transition-all duration-200 flex items-center justify-center gap-2 pointer-events-none">
                  <button
                    type="button"
                    title="Set a custom poster (image URL or device upload)"
                    onClick={() => setPosterModalOpen(true)}
                    className="flex items-center justify-center gap-1.5 px-4 py-2.5 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink text-[10px] font-black uppercase tracking-widest cursor-pointer transition-colors pointer-events-auto select-none"
                  >
                    <ImageUp className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">Custom Poster</span>
                  </button>
                  {posterUrl && (
                    <button
                      type="button"
                      title={selectedGame.steam_appid != null ? "Reset to the Steam poster" : "Reset to the default poster"}
                      aria-label={selectedGame.steam_appid != null ? "Reset to the Steam poster" : "Reset to the default poster"}
                      onClick={handleResetPoster}
                      className="flex items-center justify-center px-3 py-2.5 bg-red-600/90 hover:bg-red-500 text-brand-on-color text-[10px] font-black uppercase tracking-widest transition-colors cursor-pointer pointer-events-auto shrink-0"
                    >
                      <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Touch devices: hover-only overlay is unreachable, so show a
                persistent poster action row instead (edit mode only) */}
            {isEditing && (
              <div className="hidden gap-2 [@media(hover:none)]:flex">
                <button
                  type="button"
                  title="Set a custom poster (image URL or device upload)"
                  onClick={() => setPosterModalOpen(true)}
                  className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink text-[10px] font-black uppercase tracking-widest cursor-pointer select-none"
                >
                  <ImageUp className="w-3.5 h-3.5 shrink-0" />
                  Custom Poster
                </button>
                {posterUrl && (
                  <button
                    type="button"
                    title={selectedGame.steam_appid != null ? "Reset to the Steam poster" : "Reset to the default poster"}
                    aria-label={selectedGame.steam_appid != null ? "Reset to the Steam poster" : "Reset to the default poster"}
                    onClick={handleResetPoster}
                    className="flex items-center justify-center px-3 py-2 bg-red-600/90 hover:bg-red-500 text-brand-on-color text-[10px] font-black uppercase tracking-widest cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                  </button>
                )}
              </div>
            )}
            
            <div className="space-y-2">
              <h3 id="details-modal-title" className={`text-xl font-black tracking-tight uppercase ${selectedGame.status === "completed" ? "text-brand-accent" : "text-white"}`}>{selectedGame.title}</h3>
              <p className="text-xs text-brand-muted font-mono uppercase font-bold">
                {selectedGame.year ? `${selectedGame.year} // ` : ""}{selectedGame.genres?.slice(0, 2).join(", ")}
              </p>
              
              <div className="flex flex-wrap gap-2 pt-1">
                {customizations.showRatingBadge && selectedGame.critic_score != null && (
                  <span className="px-2 py-0.5 rounded-none text-[11px] font-mono font-black bg-zinc-900 border border-brand-border text-brand-accent">
                    CRITIC: {selectedGame.critic_score}
                  </span>
                )}
                {selectedGame.steam_appid && (
                  <a
                    href={`https://store.steampowered.com/app/${selectedGame.steam_appid}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2 py-0.5 rounded-none text-[11px] font-sans font-black bg-zinc-900 border border-brand-border text-brand-accent hover:border-brand-accent hover:text-white transition-colors"
                  >
                    VIEW ON STEAM
                  </a>
                )}
              </div>

              {/* Status — full-width and clickable, sitting below the badge row
                  (so it lands under VIEW ON STEAM) and opening the quick picker
                  instead of the full edit form. */}
              <button
                type="button"
                onClick={() => setStatusPickerOpen(true)}
                aria-haspopup="dialog"
                aria-label={`Status: ${getStatusLabel(selectedGame.status)}. Change status`}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-none border uppercase tracking-wider text-xs font-black transition-colors cursor-pointer hover:brightness-125 ${getStatusBadgeColor(selectedGame.status)}`}
              >
                <span>{getStatusLabel(selectedGame.status)}</span>
                <ChevronDown className="w-4 h-4 shrink-0" />
              </button>

              {selectedGame.owned_platforms && selectedGame.owned_platforms.filter(p => availablePlatforms.some(ap => platformIdMatches(ap.id, p))).length > 0 && (
                <div className="pt-2 border-t border-brand-border/45 mt-3">
                  <p className="text-[11px] font-mono text-brand-muted uppercase font-bold tracking-widest mb-1">Platforms Owned</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedGame.owned_platforms.filter(p => availablePlatforms.some(ap => platformIdMatches(ap.id, p))).map(p => {
                      const platLabel = availablePlatforms.find(ap => platformIdMatches(ap.id, p))?.label || p;
                      return (
                        <span key={p} className="px-2.5 py-1 bg-brand-accent text-brand-accent-ink font-black text-[11px] uppercase tracking-wider border border-brand-accent">
                          {platLabel}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Core Actions */}
          <div className="space-y-2 mt-6 pt-4 border-t border-brand-border">
            {!deleteConfirm ? (
              <button
                onClick={() => setDeleteConfirm(true)}
                className="w-full h-10 flex items-center justify-center gap-2 px-4 rounded-none bg-transparent hover:bg-red-500/10 hover:text-red-400 text-brand-muted text-xs font-black uppercase tracking-wider border border-brand-border hover:border-red-500/35 transition-all cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                Delete Game
              </button>
            ) : (
              <div className="w-full h-10 flex items-center gap-2">
                <button
                  onClick={handleDelete}
                  className="flex-1 h-full bg-red-600 hover:bg-red-500 text-brand-on-color px-3 text-xs font-black uppercase tracking-wider whitespace-nowrap transition-all cursor-pointer flex items-center justify-center border border-red-600"
                >
                  Confirm Delete
                </button>
                <button
                  onClick={() => setDeleteConfirm(false)}
                  aria-label="Cancel deletion"
                  className="w-10 h-full bg-transparent text-brand-muted hover:text-white border border-brand-border transition-all cursor-pointer flex items-center justify-center shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Tab Details */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          
          {/* Header Controls (Fixed, does not scroll) */}
          <div className="px-6 md:px-8 py-4 border-b border-brand-border/60 shrink-0 bg-brand-bg flex justify-between items-center">
            {isEditing ? (
              <p className="text-[11px] font-mono font-black uppercase tracking-widest text-brand-accent">
                EDIT_METADATA
              </p>
            ) : (
              <p className="text-[11px] font-mono font-black uppercase tracking-widest text-brand-accent">TITLE CONTROL PANEL</p>
            )}
            <div className="flex items-center gap-2.5">
              {isEditing ? (
                <>
                  <button
                    type="button"
                    onClick={handleResetMetadata}
                    disabled={saving || resettingMetadata || selectedGame.igdb_id == null}
                    title={selectedGame.igdb_id == null ? "No IGDB link — nothing to reset to" : "Reset all metadata to the default IGDB data"}
                    aria-label={selectedGame.igdb_id == null ? "No IGDB link — nothing to reset to" : "Reset all metadata to the default IGDB data"}
                    className="flex items-center justify-center w-[34px] h-[34px] bg-red-600/90 hover:bg-red-500 text-brand-on-color rounded-none border border-red-500/40 transition-colors cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {resettingMetadata ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={handleSaveChanges}
                    disabled={saving || resettingMetadata}
                    className="px-4 h-[34px] bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink rounded-none text-xs font-black uppercase tracking-wider transition-colors cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? "Saving…" : "Apply"}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setIsEditing(true)}
                  className="flex items-center gap-2 bg-transparent text-white px-4 h-[34px] rounded-none text-xs font-black uppercase tracking-wider border border-brand-border transition-all cursor-pointer shrink-0"
                >
                  <Edit2 className="w-3.5 h-3.5 text-brand-accent" />
                  Edit Metadata
                </button>
              )}
                  <button
                    onClick={() => (isEditing ? setIsEditing(false) : handleClose())}
                    aria-label={isEditing ? "Cancel editing" : "Close (Esc)"}
                    className="w-[34px] h-[34px] rounded-none bg-zinc-950 border border-brand-border text-brand-muted hover:text-white transition-colors cursor-pointer flex items-center justify-center shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
            </div>
          </div>

          {/* Scrollable Content Area */}
          <div className={`flex-1 overflow-y-auto overscroll-contain space-y-6 ${isEditing ? "p-6 md:p-8" : "pt-4 px-6 pb-6 md:px-8 md:pb-8"}`}>
            {isEditing ? (
              <div className="space-y-4">
                {/* Editable Title */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1 sm:col-span-2">
                  <label htmlFor="edit-game-title" className="text-[11px] font-mono font-bold uppercase tracking-wider text-brand-muted">Game Title</label>
                  <input
                    id="edit-game-title"
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full px-4 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wide text-white focus:outline-none focus:border-brand-accent"
                  />
                </div>
              </div>

<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label htmlFor="edit-game-year" className="text-[11px] font-mono font-bold uppercase tracking-wider text-brand-muted">Release Year</label>
                  <input
                    id="edit-game-year"
                    type="number"
                    value={year}
                    onChange={(e) => setYear(e.target.value)}
                    className="w-full px-4 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wide text-white focus:outline-none focus:border-brand-accent"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="edit-game-completed" className="text-[11px] font-mono font-bold uppercase tracking-wider text-brand-muted">Completion Date</label>
                  <input
                    id="edit-game-completed"
                    type="date"
                    value={dateCompleted || ""}
                    onChange={(e) => setDateCompleted(e.target.value)}
                    className="w-full px-4 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wide text-white focus:outline-none focus:border-brand-accent"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="edit-game-hours" className="text-[11px] font-mono font-bold uppercase tracking-wider text-brand-muted">
                    Playtime
                  </label>
                  <div className="flex gap-2">
                    <div className="relative flex-1 min-w-0">
                      <input
                        id="edit-game-hours"
                        type="number"
                        min="0"
                        step="0.1"
                        value={hoursPlayed}
                        onChange={(e) => setHoursPlayed(e.target.value)}
                        placeholder="Hours"
                        className="w-full pl-4 pr-7 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wide text-white focus:outline-none focus:border-brand-accent"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono font-black text-brand-muted pointer-events-none">H</span>
                    </div>
                    <div className="relative flex-1 min-w-0">
                      <input
                        id="edit-game-minutes"
                        type="number"
                        min="0"
                        step="1"
                        value={minutesPlayed}
                        onChange={(e) => setMinutesPlayed(e.target.value)}
                        placeholder="Minutes"
                        className="w-full pl-4 pr-7 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wide text-white focus:outline-none focus:border-brand-accent"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono font-black text-brand-muted pointer-events-none">M</span>
                    </div>
                    <button
                      type="button"
                      title={hidePlaytime ? "Show playtime" : "Hide playtime"}
                      onClick={() => setHidePlaytime((prev) => !prev)}
                      className={`w-[34px] h-[34px] shrink-0 rounded-none border flex items-center justify-center transition-colors cursor-pointer ${
                        hidePlaytime
                          ? "bg-brand-accent border-brand-accent text-brand-accent-ink"
                          : "bg-zinc-950 border-brand-border text-brand-muted hover:text-white hover:border-brand-muted"
                      }`}
                    >
                      <EyeOff className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-mono font-bold uppercase tracking-wider text-brand-muted">Personal Rating</label>
                  <span className="flex items-center gap-1.5 text-[11px] font-mono font-black uppercase tracking-widest">
                    <span className={`w-1.5 h-1.5 ${ratingValue > 0 ? "bg-brand-accent" : "bg-zinc-600"}`} />
                    <span className={ratingValue > 0 ? "text-brand-accent" : "text-brand-muted"}>
                      {ratingValue > 0 ? `Rated ${ratingValue}/10` : "Unrated"}
                    </span>
                  </span>
                </div>
                <div className="grid grid-cols-6 sm:grid-cols-11 gap-1" role="radiogroup" aria-label="Personal rating">
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

              {/* Status — edited here, saved via Apply */}
              <div className="space-y-2">
                <span id="edit-game-status-label" className="text-[11px] font-mono font-bold uppercase tracking-wider text-brand-muted">Status</span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="radiogroup" aria-labelledby="edit-game-status-label">
                  {STATUSES.map((s) => {
                    const active = editStatus === s.value;
                    const activeStyles: Record<string, string> = {
                      backlog: "bg-zinc-700/30 border-zinc-500 text-zinc-200",
                      playing: "bg-emerald-500/20 border-emerald-500/50 text-emerald-400",
                      completed: "bg-brand-accent/20 border-brand-accent/50 text-brand-accent",
                      endless: "bg-fuchsia-500/20 border-fuchsia-500/50 text-fuchsia-400",
                    };
                    return (
                      <button
                        key={s.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => {
                          setEditStatus(s.value);
                          if (s.value === "completed" && !dateCompleted) {
                            setDateCompleted(new Date().toISOString().slice(0, 10));
                          }
                        }}
                        className={`h-9 sm:h-10 px-3 rounded-none border text-[11px] font-black uppercase tracking-wider cursor-pointer transition-all flex items-center justify-center ${
                          active
                            ? activeStyles[s.value]
                            : "bg-zinc-900/60 border-brand-border/50 text-brand-muted hover:text-white hover:border-brand-accent/40"
                        }`}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>

            {/* Owned Platforms checkboxes */}
              <div className="space-y-2">
                <label className="text-[11px] font-mono font-bold uppercase tracking-wider text-brand-muted">Platform Tag checklist</label>
                <div className="flex flex-wrap gap-1.5">
                  {availablePlatforms.map((plat) => (
                    <label
                      key={plat.id}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-none border text-[11px] font-black uppercase tracking-wider cursor-pointer transition-colors ${
                        selectedPlatforms.includes(plat.id)
                          ? "bg-brand-accent border-brand-accent text-brand-accent-ink"
                          : "bg-transparent border-brand-border text-brand-muted hover:text-white hover:border-brand-accent/40"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedPlatforms.includes(plat.id)}
                        onChange={() => handlePlatformToggle(plat.id)}
                        className="sr-only"
                      />
                      <span className={`w-1.5 h-1.5 rounded-none border shrink-0 ${
                        selectedPlatforms.includes(plat.id)
                          ? "bg-brand-accent-ink border-brand-accent-ink"
                          : "border-brand-muted"
                      }`} />
                      {plat.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="edit-game-synopsis" className="text-[11px] font-mono font-bold uppercase tracking-wider text-brand-muted">Game Synopsis / Description</label>
                <textarea
                  id="edit-game-synopsis"
                  value={synopsis}
                  onChange={(e) => { setSynopsis(e.target.value); synopsisDirtyRef.current = true; }}
                  rows={8}
                  className="w-full min-h-[220px] px-4 py-3 bg-brand-bg border border-brand-border rounded-none text-xs sm:text-[13px] font-normal font-sans text-zinc-200 leading-relaxed focus:outline-none focus:border-brand-accent resize-y"
                  placeholder="Enter synopsis or sync from IGDB"
                />
              </div>

            </div>
          ) : (
            <div className="space-y-6">
              <div className="pt-0">
                <div className="text-zinc-300 text-xs sm:text-sm font-sans space-y-3 leading-relaxed pr-2 select-text">
                  {selectedGame.synopsis ? (
                    selectedGame.synopsis.split('\n\n').map((paragraph: string, idx: number) => (
                      <p key={idx}>{paragraph}</p>
                    ))
                  ) : (
                    <p className="text-brand-muted text-xs uppercase font-mono">No description available.</p>
                  )}
                </div>
              </div>
            </div>
          )}
          </div>

          {/* Status + Registry Metrics Footer (Permanently at the bottom when not editing) */}
          {!isEditing && (
            <div className="px-6 py-5 md:px-8 md:py-6 border-t border-brand-border/60 shrink-0 bg-zinc-950/85 backdrop-blur-sm space-y-3">
              {/* Registry Metrics */}
              <div className="grid grid-cols-3 gap-3">
                <div className={`bg-zinc-900/60 border p-3.5 flex flex-col justify-between h-[76px] ${selectedGame.hide_playtime === 1 ? "border-dashed border-red-500/25" : "border-brand-border/50"}`}>
                    <p className="text-[8px] sm:text-[11px] font-mono text-brand-muted uppercase font-bold tracking-widest leading-none">Aggregate Hours</p>
                    {selectedGame.hide_playtime === 1 ? (
                      <h5 className="text-sm sm:text-lg font-black text-red-400/80 font-mono mt-2 leading-none uppercase inline-flex items-center gap-1.5 line-through decoration-2 decoration-red-500/40" title="Playtime is hidden — shown only to you">
                        <EyeOff className="w-3.5 h-3.5 shrink-0" />
                        Hidden
                      </h5>
                    ) : (
                      <h5 className="text-sm sm:text-lg font-black text-white font-mono mt-2 leading-none uppercase">
                        {formatPlaytimePrecise(selectedGame.playtime)}
                      </h5>
                    )}
                  </div>
                  
                  <div className="bg-zinc-900/60 border border-brand-border/50 p-3.5 flex flex-col justify-between h-[76px]">
                    <p className="text-[8px] sm:text-[11px] font-mono text-brand-muted uppercase font-bold tracking-widest leading-none">Personal Grade</p>
                    <h5 className="text-sm sm:text-lg font-black text-brand-accent font-mono mt-2 leading-none uppercase">
                      {selectedGame.personal_rating !== null ? `${selectedGame.personal_rating}/10` : "—"}
                    </h5>
                  </div>

                  <div className="bg-zinc-900/60 border border-brand-border/50 p-3.5 flex flex-col justify-between h-[76px]">
                    <p className="text-[8px] sm:text-[11px] font-mono text-brand-muted uppercase font-bold tracking-widest leading-none">Entry Date</p>
                    <h5 className="text-sm sm:text-lg font-black text-white font-mono mt-2 leading-none uppercase">
                      {new Date(selectedGame.date_added).toLocaleDateString()}
                    </h5>
                  </div>
                </div>
            </div>
          )}

        </div>

        </motion.div>
      </motion.div>
      )}
    </AnimatePresence>

    {/* Change Poster modal — set a custom poster via image URL or device upload */}
    <AnimatePresence>
      {selectedGame && posterModalOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/80"
          onClick={(e) => { if (e.target === e.currentTarget) closePosterModal(); }}
        >
          <motion.div
            ref={posterModalRef}
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.15 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="poster-modal-title"
            className="w-full max-w-md bg-brand-bg border border-brand-border shadow-2xl"
          >
            <div className="px-5 py-4 border-b border-brand-border/60 flex items-center justify-between">
              <h3 id="poster-modal-title" className="text-[11px] font-mono font-black uppercase tracking-widest text-brand-accent">
                Change Poster
              </h3>
              <button
                type="button"
                onClick={closePosterModal}
                aria-label="Close poster dialog"
                className="w-[30px] h-[30px] rounded-none bg-zinc-950 border border-brand-border text-brand-muted hover:text-white transition-colors cursor-pointer flex items-center justify-center"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Option 1: image URL */}
              <div className="space-y-1.5">
                <label htmlFor="poster-url-input" className="text-[11px] font-mono font-bold uppercase tracking-wider text-brand-muted">
                  Poster image URL
                </label>
                <div className="flex gap-2">
                  <input
                    id="poster-url-input"
                    type="url"
                    value={posterUrlInput}
                    onChange={(e) => setPosterUrlInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleApplyPosterUrl(); }}
                    placeholder="https://example.com/poster.jpg"
                    className="flex-1 min-w-0 px-3 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-mono text-white focus:outline-none focus:border-brand-accent placeholder:text-zinc-600"
                  />
                  <button
                    type="button"
                    onClick={handleApplyPosterUrl}
                    disabled={posterSaving || !posterUrlInput.trim()}
                    className="flex items-center gap-1.5 px-3 py-2 bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink rounded-none text-[10px] font-black uppercase tracking-widest transition-colors cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {posterSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                    Apply
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-brand-border/60" />
                <span className="text-[9px] font-mono font-bold uppercase tracking-widest text-brand-muted">or</span>
                <div className="flex-1 h-px bg-brand-border/60" />
              </div>

              {/* Option 2: upload from device */}
              <label
                htmlFor="poster-modal-file"
                className={`w-full h-11 flex items-center justify-center gap-2 px-4 rounded-none bg-transparent border border-brand-border text-xs font-black uppercase tracking-wider transition-all select-none ${
                  posterSaving ? "opacity-50 cursor-not-allowed" : "hover:bg-brand-accent/[0.03] hover:text-white text-brand-muted cursor-pointer"
                }`}
              >
                {posterSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageUp className="w-4 h-4 text-brand-accent" />}
                Upload from device
              </label>
              <input
                id="poster-modal-file"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                disabled={posterSaving}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleUploadPoster(file);
                  e.target.value = "";
                }}
              />
              <p className="text-[10px] font-mono text-brand-muted uppercase tracking-wider leading-relaxed">
                PNG, JPEG or WebP — uploads are resized and stored locally. Use Reset to restore the original poster.
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>

    {/* Quick status picker — opened by the full-width status button in the
        sidebar. Applies immediately, so no edit form and no second Save. */}
    <AnimatePresence>
      {selectedGame && statusPickerOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/80"
          onClick={(e) => { if (e.target === e.currentTarget) setStatusPickerOpen(false); }}
        >
          <motion.div
            ref={statusPickerRef}
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.15 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="status-picker-title"
            className="w-full max-w-sm bg-brand-bg border border-brand-border shadow-2xl"
          >
            <div className="px-5 py-4 border-b border-brand-border/60 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 id="status-picker-title" className="text-[11px] font-mono font-black uppercase tracking-widest text-brand-accent">
                  Change Status
                </h3>
                <p className="text-[10px] font-mono text-brand-muted uppercase tracking-wider truncate mt-0.5">
                  {selectedGame.title}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setStatusPickerOpen(false)}
                aria-label="Close status dialog"
                className="w-[30px] h-[30px] shrink-0 rounded-none bg-zinc-950 border border-brand-border text-brand-muted hover:text-white transition-colors cursor-pointer flex items-center justify-center"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="p-3 space-y-1.5">
              {STATUSES.map((opt) => {
                const active = opt.value === selectedGame.status;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={statusBusy}
                    onClick={() => handleQuickStatus(opt.value)}
                    aria-current={active}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-none border text-xs font-black uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${
                      active
                        ? getStatusBadgeColor(opt.value)
                        : "bg-zinc-950/40 border-brand-border/60 text-brand-muted hover:border-brand-accent hover:text-white"
                    }`}
                  >
                    <span>{opt.label}</span>
                    {active && <Check className="w-4 h-4 shrink-0" />}
                  </button>
                );
              })}
            </div>

            {statusBusy && (
              <div className="px-5 pb-4 flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-brand-muted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Saving…
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
  );
});
export default GameDetailsModal;
