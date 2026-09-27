import React, { useEffect } from "react";
import { useGameTrackStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { 
  Trophy, Calendar, Shuffle
} from "lucide-react";
import { motion } from "motion/react";
import { formatPlaytime, formatPlaytimeLong, formatPlaytimePrecise } from "../utils/time";
import { getStatusBadgeColor, getStatusLabel, platformIdMatches, mergeCustomPlatforms } from "../constants";
import { PosterImage } from "./PosterImage";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { Buttons } from "./Buttons";

/**
 * One cell of the registry strip.
 *
 * The strip is a single ruled band rather than five boxed cards — the same
 * instrument the System Analytics readout below it is built from, so the two
 * telemetry rows on this page read as one system. The band supplies the outer
 * border and the hairlines (a `gap-px` over a border-coloured ground), so a
 * cell carries no border of its own and its hover is a background wash, never
 * an outline: drawing a box around one cell would break the illusion of a
 * single continuous readout.
 *
 * Every cell is a real control — the counts open the library already filtered
 * to what they count, playtime opens it ordered by most played, and the
 * wishlist opens the wishlist — so the strip doubles as the fastest way into
 * the part of the registry you were just reading about.
 *
 * The cells carry a figure and nothing else. The subtext lines are gone and
 * the figures have taken over the space they used to hold, so the strip keeps
 * the height it had while the prose was still there: at sm and up the content
 * is label (two reserved lines) + gap + figure + the cell's own padding, which
 * lands within a few pixels of the old box at every size. Below sm the figure
 * is capped by the cell's width instead — "187" plus its unit has to fit a
 * 130px column — so the two-column phone cells end up shorter than they were.
 */
interface StatCardProps {
  title: string;
  value: string | number;
  /** Names the destination for assistive tech; must contain `title`. */
  action: string;
  /** Grid span, so each row of the strip adds up to a full width. */
  className?: string;
  onSelect: () => void;
}

const StatCard = React.memo(({ title, value, action, className = "", onSelect }: StatCardProps) => {
  // Check if the value is a string with a space or ends with H (e.g. "13H 34M" or "38H")
  const isPlaytime = typeof value === "string" && (value.includes(" ") || value.endsWith("H"));
  
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={action}
      className={`group bg-brand-bg p-5 sm:p-6 text-left cursor-pointer transition-colors duration-150
        hover:bg-brand-accent/[0.05] active:bg-brand-accent/[0.1]
        focus-visible:outline-2 focus-visible:outline-brand-accent focus-visible:outline-offset-[-3px]
        ${className}`}
    >
      <div className="space-y-2">
        {/* Two lines reserved so every figure in the row starts on the same
            baseline however its label wraps at a given width. */}
        <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted group-hover:text-brand-accent transition-colors duration-150 min-h-[2lh]">{title}</p>
        
        {isPlaytime ? (
          <div className="flex flex-wrap items-baseline gap-x-1.5 font-sans tracking-tighter leading-none">
            {value.split(" ").map((part: string, idx: number) => {
              const numberVal = part.slice(0, -1);
              const unitVal = part.slice(-1);
              return (
                <React.Fragment key={idx}>
                  {idx > 0 && <span className="w-1" />}
                  {/* Number and unit never split: a wrapping flex row used to
                      strand the accent unit on its own line under the figure. */}
                  {/* The figure size lives on the wrapper, not the number, so the
                      unit's `em` resolves against the figure. Put it on the
                      number and the unit inherits the row's 16px instead — which
                      rendered "H" at 6px. */}
                  <span className="inline-flex items-baseline whitespace-nowrap shrink-0 text-[3.25rem] sm:text-[5.5rem] xl:text-6rem font-black tracking-tighter leading-none">
                    <span className="text-white">{numberVal}</span>
                    <span className="text-brand-accent text-[0.22em] uppercase leading-none self-baseline">{unitVal}</span>
                  </span>
                </React.Fragment>
              );
            })}
          </div>
        ) : (
          <h3 className="text-[3.25rem] sm:text-[5.5rem] xl:text-6rem font-black text-white font-sans tracking-tighter leading-none">
            {value}
          </h3>
        )}
      </div>
    </button>
  );
});

const formatStatus = (status: string) => getStatusLabel(status).toUpperCase();

export const DashboardView: React.FC = React.memo(() => {
  const {
    games, summary, suggestions, recentActivity, loadingAnalytics, fetchAnalytics,
    fetchSuggestions, setSelectedGame, lastAnalyticsFetch, customPlatforms, customizations,
    wishlist, setActiveTab, setFilter, resetFilters
  } = useGameTrackStore(useShallow(s => ({
    games: s.games, summary: s.summary,
    suggestions: s.suggestions, recentActivity: s.recentActivity,
    loadingAnalytics: s.loadingAnalytics, fetchAnalytics: s.fetchAnalytics,
    fetchSuggestions: s.fetchSuggestions,
    setSelectedGame: s.setSelectedGame,
    lastAnalyticsFetch: s.lastAnalyticsFetch,
    customPlatforms: s.customPlatforms,
    customizations: s.customizations,
    wishlist: s.wishlist,
    setActiveTab: s.setActiveTab,
    setFilter: s.setFilter,
    resetFilters: s.resetFilters
  })));

  const platforms = React.useMemo(() => mergeCustomPlatforms(customPlatforms), [customPlatforms]);

  // Suggestions depend on the library itself: recompute whenever games change,
// never on analytics refreshes (which would reshuffle the deck mid-view).
  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions, games]);

  useEffect(() => {
    if (!summary || Date.now() - lastAnalyticsFetch > 60_000) fetchAnalytics();
  }, [fetchAnalytics, summary, lastAnalyticsFetch]);

  const activeGames = React.useMemo(() => games.filter(g => g.status === "playing"), [games]);

  /**
   * A strip cell is a shortcut, so it has to land somewhere true. Clearing the
   * filters first matters: a persisted "hide completed", a leftover search
   * term or a platform tag would otherwise show an empty list behind a cell
   * that says there are six. Pass a status to scope the library, a sort to
   * order it, or neither for the whole registry.
   */
  const openLibrary = React.useCallback(
    (status?: string, sort?: string) => {
      resetFilters();
      if (status) setFilter("status", status);
      if (sort) setFilter("sort", sort);
      setActiveTab("library");
    },
    [resetFilters, setFilter, setActiveTab]
  );

  /**
   * The poster row has to fill whichever track it lands in. A phone gets one
   * column and stacks all three; the two-column band in between (sm up to lg)
   * can only seat two before the third becomes an orphan on its own row; the
   * three-column desktop row takes all three again. Shuffle still reorders the
   * full pool of three — the middle band just shows the top two of it.
   */
  const suggestionsAreTwoUp = useMediaQuery("(min-width: 640px) and (max-width: 1023px)");
  const visibleSuggestions = React.useMemo(
    () => suggestions.slice(0, suggestionsAreTwoUp ? 2 : 3),
    [suggestions, suggestionsAreTwoUp]
  );

  return (
    <div className="space-y-10">
      {/* Top Welcome / Action Area */}
      <div className="flex flex-col lg:flex-row justify-between items-start gap-8">
        <div className="space-y-3">
          {/* Huge Display Hero Title */}
          <h1 className="relative z-30 pointer-events-none text-6xl sm:text-8xl lg:text-[110px] font-black tracking-tighter leading-[0.85] uppercase text-white font-sans select-none">
            GAME<br /><span className="text-brand-accent">TRACK_</span>
          </h1>
          <p className="max-w-none text-brand-muted text-sm sm:text-base font-medium leading-relaxed lg:whitespace-nowrap">
            Your personal gaming registry. Track, organize, and analyze your library.
          </p>
          {/* Hairline rule closing the header block, shared by every view so the
              title, its subtext and the rule read the same everywhere. Decorative. */}
          <div aria-hidden="true" className="mt-8 h-px w-full bg-brand-border/60" />
        </div>
      </div>

      {/* Registry strip — one ruled band, five cells, matching the System
          Analytics readout further down. The spans exist so every row still
          adds up to a full width: `lg` runs a 6-column track with the first
          three taking 2 each and the last two 3 each, `xl` drops to 5 equal
          columns, and below `lg` the fifth cell spans the full row. The
          skeleton repeats those exact spans so nothing jumps on load. */}
      {loadingAnalytics && !summary ? (
        <div className="grid grid-cols-2 lg:grid-cols-6 xl:grid-cols-5 auto-rows-fr gap-px bg-brand-border border border-brand-border animate-pulse">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="lg:col-span-2 xl:col-span-1 h-40 sm:h-48 bg-brand-bg p-1">
              <div className="h-full w-full bg-zinc-900/50" />
            </div>
          ))}
          <div className="lg:col-span-3 xl:col-span-1 h-40 sm:h-48 bg-brand-bg p-1">
            <div className="h-full w-full bg-zinc-900/50" />
          </div>
          <div className="col-span-2 lg:col-span-3 xl:col-span-1 h-40 sm:h-48 bg-brand-bg p-1">
            <div className="h-full w-full bg-zinc-900/50" />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-6 xl:grid-cols-5 auto-rows-fr gap-px bg-brand-border border border-brand-border">
          <StatCard
            className="lg:col-span-2 xl:col-span-1"
            title="Registered Games"
            value={summary?.total_games ?? 0}
            action={`Registered Games — ${summary?.total_games ?? 0} titles in the registry. Open the whole library.`}
            onSelect={() => openLibrary()}
          />
          <StatCard
            className="lg:col-span-2 xl:col-span-1"
            title="Active Backlog"
            value={summary?.active_games ?? 0}
            action={`Active Backlog — ${summary?.active_games ?? 0} titles in active play. Open the library filtered to playing.`}
            onSelect={() => openLibrary("playing")}
          />
          <StatCard
            className="lg:col-span-2 xl:col-span-1"
            title="Completed"
            value={summary?.completed_games ?? 0}
            action={`Completed — ${summary?.completed_games ?? 0} titles finished. Open the library filtered to completed.`}
            onSelect={() => openLibrary("completed")}
          />
          <StatCard
            className="lg:col-span-3 xl:col-span-1"
            title="Total Playtime"
            value={formatPlaytime(summary?.total_playtime_hours)}
            action={`Total Playtime — ${formatPlaytime(summary?.total_playtime_hours)} logged. Open the library ordered by most played.`}
            onSelect={() => openLibrary(undefined, "playtime")}
          />
          <StatCard
            className="col-span-2 lg:col-span-3 xl:col-span-1"
            title="Wishlist"
            value={wishlist.length}
            action={`Wishlist — ${wishlist.length} titles queued. Open the wishlist.`}
            onSelect={() => setActiveTab("wishlist")}
          />
        </div>
      )}

      {/* Current Session — the game you're actively playing right now */}
      {activeGames.length > 0 ? (
        <div className="space-y-4">
          {activeGames.map((game) => (
            <div
              key={game.id}
              className="bg-session-bg text-session-text p-8 sm:p-10 rounded-none flex flex-col sm:flex-row justify-between items-start sm:items-end gap-6 transition-all border-l-8 border-brand-accent select-none"
            >
              <div className="space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-widest text-session-subtext">
                  CURRENT_SESSION
                </h3>
                <h2 className="text-3xl sm:text-5xl lg:text-6xl font-black uppercase tracking-tighter leading-none text-session-text font-sans">
                  {game.title}
                </h2>
                <p className="text-xs font-bold text-session-subtext tracking-wider max-w-lg uppercase">
                  {game.genres?.slice(0, 3).join("  •  ") ?? ""}
                </p>
              </div>
              
              <div className="text-left sm:text-right shrink-0">
                <p className="text-[11px] tracking-widest text-session-subtext uppercase font-bold">
                  Accumulated
                </p>
                <div className="text-3xl sm:text-4xl font-black text-session-text tracking-tight mt-1">
                  {game.hide_playtime === 1 ? "—" : formatPlaytimePrecise(game.playtime)}
                </div>
                <button
                  onClick={() => setSelectedGame(game)}
                  className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider bg-session-text text-session-bg hover:opacity-90 px-3.5 py-1.5 rounded-none transition-all cursor-pointer"
                >
                  View Details
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-session-bg text-session-text p-8 sm:p-10 rounded-none flex flex-col sm:flex-row justify-between items-start sm:items-end gap-6 transition-all border-l-8 border-brand-accent select-none">
          <div className="space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-widest text-session-subtext">
              NO_ACTIVE_SESSION
            </h3>
            <h2 className="text-3xl sm:text-5xl lg:text-6xl font-black uppercase tracking-tighter leading-none text-session-text font-sans">
              READY_FOR_ENGAGEMENT
            </h2>
            <p className="text-xs font-bold text-session-subtext tracking-wider max-w-lg uppercase">
              MARK_A_TITLE_AS_CURRENTLY_PLAYING_TO_INITIATE_METRIC_TRACKING
            </p>
          </div>
        </div>
      )}
      {/* Suggestions and Recent Activity Grid — 5:2 via explicit fr tracks.
          The old lg:grid-cols-4 + col-span-3 made the Logs rail only one
          quarter wide (255px) and, because a 3-track span also absorbs two
          internal gaps, Suggestions came out far wider than the 3:1 implied.
          fr tracks divide the space after the single gap, so 5:2 is honest and
          can be dialled in either direction. The minmax(0, …) wrapper is
          required, not decoration: a bare 5fr track has an automatic min-content
          floor, and the three 2:3 posters inside Suggestions are wider than
          5/7 of the row, so the track refused to shrink and the real split came
          out 602:498 instead of 5:2. Log rows still truncate their title with
          the status badge shrink-0, so the rail degrades to an ellipsis rather
          than wrapping. The two columns are left to stretch to a common height
          (align-items defaults to stretch on a grid): the posters set the row
          height from their own 2:3 ratio, and the Logs rail fills it and
          scrolls internally. Neither column hardcodes a pixel height, so they
          stay level at every viewport width instead of only at the one the
          old 488px was measured at. */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,2fr)] gap-10 items-stretch">
        
        {/* Next To Play Recommendations */}
        <div className="space-y-6">
          <div className="flex items-center justify-between border-b border-brand-border pb-3 gap-3 lg:h-[46px]">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold tracking-tight uppercase text-white">Suggestions</h3>
            </div>
            {/* One shuffle for the row. It used to live inside each suggestion
                card, which would render three identical controls. */}
            {!loadingAnalytics && suggestions.length > 0 && (
              <Buttons
                variant="primary"
                onClick={fetchSuggestions}
                aria-label="Shuffle suggestions"
                title="Shuffle suggestions"
                className="px-3 py-1.5 text-[11px] flex items-center justify-center gap-1.5 shrink-0"
              >
                <Shuffle className="w-3.5 h-3.5" />
                Shuffle
              </Buttons>
            )}
          </div>

          {loadingAnalytics ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {[...Array(suggestionsAreTwoUp ? 2 : 3)].map((_, i) => (
                <div key={i} className="aspect-[2/3] bg-zinc-900/50 border border-brand-border animate-pulse" />
              ))}
            </div>
          ) : suggestions.length === 0 ? (
            <div className="border border-brand-border border-dashed rounded-none p-8 text-center flex flex-col items-center justify-center h-[300px]">
              <Trophy className="w-10 h-10 text-brand-muted mb-3" />
              <p className="text-white text-sm font-bold uppercase tracking-wider">Suggested directive empty</p>
              <p className="text-brand-muted text-xs mt-1 max-w-sm">
                Mark games as "Backlog" inside My Library or log discovery entries to run auto-prioritization models.
              </p>
            </div>
          ) : (
            /* Poster row. No fixed height on purpose: the earlier lg:h-[418px]
               was tuned to one viewport width, so on a wider screen the
               row got stretched and object-cover sliced the bottom off every
               poster (the MAFIA and BLASPHEMOUS logos were cut in half).
               Height is now derived from the poster's own 2:3 ratio, so the
               art is never cropped at any width.

               The card is nothing but the poster at rest. Title and meta are
               revealed inside it on hover, so the default view is pure
               artwork — no caption strip, and no text sitting on the art
               until it is asked for. The scrim exists only for that hover
               state, where type has to hold up over arbitrary artwork. */
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {visibleSuggestions.map((game, index) => {
                const ownedPlatforms = (game.owned_platforms || [])
                  .filter(p => platforms.some(ap => platformIdMatches(ap.id, p)))
                  .map(p => platforms.find(ap => platformIdMatches(ap.id, p))?.label || p);
                const hasScore = customizations.showRatingBadge && game.critic_score != null;
                // Accent goes on the FIRST word, not the last. At this display
                // size a long title hits the line clamp on the final line, so a
                // trailing accent word gets cut off and the colour silently
                // vanishes on exactly the longest titles. The first word is
                // always on line one, and opening on the accent gives the
                // poster a stronger read than a trailing one anyway.
                const titleWords = game.title.trim().split(/\s+/);
                const accentWord = titleWords[0] ?? "";
                const headWords = titleWords.slice(1).join(" ");
                return (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.15, ease: "easeOut", delay: index * 0.02 }}
                  key={game.id}
                  onClick={() => setSelectedGame(game)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedGame(game);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open details for ${game.title}`}
                  className="group relative border border-brand-border bg-zinc-950/30 hover:border-brand-accent transition-colors focus:outline-none focus-visible:outline-2 focus-visible:outline-brand-accent cursor-pointer overflow-hidden"
                >
                  {/* True 2:3 poster — a 2:3 source fills this box exactly, so
                      object-cover never has to crop. The hover scale is on the
                      image only; the overlay is its sibling so it does not
                      scale and blur with the artwork. */}
                  <div className="relative aspect-[2/3] overflow-hidden bg-zinc-900">
                    <PosterImage
                      src={game.poster_url}
                      alt={game.title}
                      eager={index === 0}
                      className="h-full w-full object-cover group-hover:scale-[1.04] group-focus-visible:scale-[1.04] transition-transform duration-500 ease-out transform-gpu will-change-transform"
                    />

                    {/* Legibility scrim for the hover caption only. Dark at BOTH
                        ends and clear through the middle, because the data now
                        sits top-left/top-right and the title bottom-left — a
                        single bottom-up gradient would leave the top row sitting
                        on bare artwork. */}
                    <div
                      aria-hidden="true"
                      className="absolute inset-0 bg-gradient-to-b from-black/65 via-black/15 to-black/85 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-300"
                    />

                    <div className="absolute inset-0 p-4 flex flex-col justify-between opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-300 ease-out">
                      {/* Data pinned to the top corners: year left, platform and
                          score right. Sans-serif rather than the mono used by
                          the app's telemetry micro-labels — these sit on
                          artwork next to a display title, and mono read as
                          machine output against the poster. */}
                      <div className="flex items-start justify-between gap-3 font-sans text-[11px] font-semibold uppercase tracking-widest">
                        <span className="shrink-0 text-white/85">{game.year ?? "—"}</span>
                        <span className="flex items-center gap-2 min-w-0 justify-end text-white/85">
                          {hasScore && (
                            <span className="shrink-0 text-brand-accent font-black">MC {game.critic_score}</span>
                          )}
                          {ownedPlatforms.length > 0 && <span className="truncate">{ownedPlatforms.join(", ")}</span>}
                        </span>
                      </div>

                      {/* Display-scale title, first word in accent. The accent
                          is on the opening word so the line clamp can never eat
                          it. */}
                      <h4 className="text-lg sm:text-[22px] lg:text-[27px] font-black uppercase tracking-tight leading-[0.95] text-white line-clamp-3 break-words">
                        <span className="text-brand-accent">{accentWord}</span>
                        {headWords && <span> {headWords}</span>}
                      </h4>
                    </div>
                  </div>

                  {/* The hover caption is visual only, so the data still has to
                      reach assistive tech and stay findable by keyboard. */}
                  <span className="sr-only">
                    {[game.year, hasScore ? `Metacritic ${game.critic_score}` : null, ownedPlatforms.join(", ")]
                      .filter(Boolean).join(" · ")}
                  </span>
                </motion.div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent Activity Panel — the rail stretches to whatever height the
            poster row resolves to at this viewport, and scrolls inside itself.
            The old lg:h-[488px] fixed the list height, so the two columns only
            lined up at one screen width; flex-1 min-h-0 on a flex column lets
            the row's height come from the tallest sibling and have the list
            fill it, with min-h-0 so overflow-y-auto actually bounds it. */}
        <div className="space-y-6 flex flex-col h-full min-h-0">
          <div className="border-b border-brand-border pb-3 flex items-center shrink-0 lg:h-[46px]">
            <h3 className="text-lg font-bold tracking-tight uppercase text-white">
              Logs
            </h3>
          </div>

          {loadingAnalytics ? (
            <div className="space-y-3 animate-pulse flex-1 min-h-0 overflow-hidden">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-16 bg-zinc-900/50 rounded-none border border-brand-border" />
              ))}
            </div>
          ) : recentActivity.length === 0 ? (
            <div className="border border-brand-border border-dashed rounded-none p-6 text-center flex flex-col items-center justify-center h-48 shrink-0">
              <Calendar className="w-8 h-8 text-brand-muted mb-2" />
              <p className="text-brand-muted text-xs uppercase font-bold">No recent activity logs</p>
            </div>
          ) : (
            <div className="relative flex-1 min-h-0">
              {/* absolute inset-0, not h-full: a percentage height against a
                  flex-basis-0 parent is circular, so the browser falls back to
                  the list's natural height (3200px+) and the whole row grows
                  to match. An out-of-flow child contributes nothing to the
                  intrinsic height, so the posters stay the tallest thing here
                  and the rail scrolls inside whatever height they resolve to. */}
              <div className="absolute inset-0 space-y-3 overflow-y-auto pr-1">
                {recentActivity.map((game) => (
                  <div
                    key={game.id}
                    onClick={() => setSelectedGame(game)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedGame(game);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`View details for ${game.title}`}
                    className="bg-transparent border border-brand-border rounded-none py-3 px-3.5 hover:border-brand-accent/40 cursor-pointer transition-all flex flex-col justify-between gap-2 min-h-[76px] focus:outline-none focus:border-brand-accent"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h5 className="font-bold text-white text-sm truncate uppercase tracking-tight">{game.title}</h5>
                      <span className={`px-1.5 py-0.5 rounded-none text-[11px] font-black border uppercase tracking-wider shrink-0 ${getStatusBadgeColor(game.status)}`}>
                        {formatStatus(game.status)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-brand-muted font-bold">
                        {game.hide_playtime === 1 ? "—" : formatPlaytimeLong(game.playtime)}
                      </span>
                      <p className="text-[11px] text-brand-muted uppercase font-bold">
                        {new Date(game.updated_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              {/* No bottom fade and no chevron. The rail scrolls on its own and
                  the clipped next row is already the cue that more content
                  sits below; both devices sat on top of that row and read as
                  rendering artefacts rather than as affordances. */}
            </div>
          )}
        </div>

      </div>

    </div>
  );
});
export default DashboardView;
