import React, { useEffect } from "react";
import { useGameTrackStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { 
  Trophy, Calendar, Shuffle
} from "lucide-react";
import { motion } from "motion/react";
import { formatPlaytime, formatPlaytimeLong, formatPlaytimePrecise, formatDateShort } from "../utils/time";
import { getStatusBadgeColor, getStatusLabel, platformIdMatches, mergeCustomPlatforms, isOwned } from "../constants";
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
                  {/* The figure size lives on the wrapper, not the number, so
                      both halves of the pair resolve against the same size.
                      Put it on the number and the unit inherits the row's 16px
                      instead — which rendered "H" at 6px. */}
                  <span className="inline-flex items-baseline whitespace-nowrap shrink-0 text-[3.25rem] sm:text-[5.5rem] xl:text-6rem font-black tracking-tighter leading-none">
                    <span className="text-white">{numberVal}</span>
                    {/* Full size, on the figure's own scale. The unit used to sit
                        at 0.22em, which made "188" read as the number and the "H"
                        as a footnote hanging off it; at the figure's size the two
                        read as one quantity, with the accent carrying the unit
                        rather than qualifying the number. */}
                    <span className="text-brand-accent uppercase leading-none self-baseline">{unitVal}</span>
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

/**
 * Splits a title into two rows at the word midpoint, for the Current Session
 * panel.
 *
 * Deliberately not a CSS line clamp. A clamp breaks wherever the text happens to
 * reach the edge, so a short title is one line, a medium one two, and a long one
 * two-and-an-ellipsis — three different panel heights from the same component,
 * and the panel is a row of hit targets, so the ragged edge is visible. Splitting
 * on word count instead gives every title the same two rows, and the panel's
 * height is then a fact rather than a consequence.
 *
 * An odd word count puts the extra word on the first row, so the second is never
 * the longer of the pair and the block does not read as bottom-heavy. A
 * single-word title gets a second empty row rather than a special case, so the
 * one real line keeps the same offset from the panel's bottom edge as it would
 * with a full-length name.
 */
const titleRows = (title: string): [string, string] => {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return [title.trim(), ""];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
};

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
   * Whether an empty Suggestions deck is caused by ownership rather than by an
   * empty backlog. The deck draws only from owned titles, so a backlog made
   * entirely of Not Owned entries produces an empty deck that the default copy
   * would misdiagnose as "you have nothing queued".
   */
  const blockedOnlyByOwnership = React.useMemo(
    () =>
      games.some((g) => g.status === "backlog") &&
      !games.some((g) => g.status === "backlog" && isOwned(g)),
    [games]
  );

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
  const suggestionsAreTwoUp = useMediaQuery("(min-width: 640px) and (max-width: 1023px)");  const visibleSuggestions = React.useMemo(
    () => suggestions.slice(0, suggestionsAreTwoUp ? 2 : 3),
    [suggestions, suggestionsAreTwoUp]
  );

  return (
    <div className="space-y-10">
      {/* Top Welcome / Action Area */}
      <div className="relative pb-8">
        <div className="flex flex-col lg:flex-row justify-between items-start gap-8">
          <div className="space-y-3">
            {/* Huge Display Hero Title */}
            <h1 className="relative z-30 pointer-events-none text-6xl sm:text-8xl lg:text-[110px] font-black tracking-tighter leading-[0.85] uppercase text-white font-sans select-none">
              GAME<br /><span className="text-brand-accent">TRACK_</span>
            </h1>
            <p className="max-w-none text-brand-muted text-sm sm:text-base font-medium leading-relaxed lg:whitespace-nowrap">
              Your personal gaming registry. Track, organize, and analyze your library.
            </p>
          </div>
        </div>
        {/* Hairline rule closing the header block, shared by every view so the
            title, its subtext and the rule read the same everywhere. Decorative.

            It sits OUTSIDE the title column and cancels the page gutter
            (-mx-6 / md:-mx-12) so it runs the full width of the screen rather
            than stopping at the subtext — the same full-bleed trick the footer
            rule uses, and the page wrapper's overflow-x-hidden keeps it from
            ever becoming a horizontal scrollbar. */}
        <div aria-hidden="true" className="absolute bottom-0 -left-6 -right-6 md:-left-12 md:-right-12 h-px bg-brand-border/60" />
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
          {/* The registry total counts owned and played-not-owned titles alike,
              so the aria label carries the split as well: a screen-reader user
              hearing only "37 titles in the registry" would have no way to know
              how many of them are actually a copy they hold. The visible figure
              stays the total — the cell is one number, and the per-title
              ownership is marked on the library cards and in the rail. */}
          <StatCard
            className="lg:col-span-2 xl:col-span-1"
            title="Registered Games"
            value={summary?.total_games ?? 0}
            action={`Registered Games — ${summary?.total_games ?? 0} titles in the registry: ${summary?.owned_games ?? 0} owned, ${summary?.not_owned_games ?? 0} played without a copy. Open the whole library.`}
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

      {/* Current Session — the game you're actively playing right now, and the
          panel itself is the control that opens it. There is no "View Details"
          button any more: one target for the whole card is both a bigger target
          and one less thing to read.

          The genres line is gone with it. It was the only place the panel named
          a category, and the card next to it is a poster wall that never does —
          so this was the one panel where the taxonomy showed up, and it was
          reading as filler under a title that does not need it.

          The label moved to the title's corner and the accumulated time to the
          opposite one, which puts the number a person came for on the left where
          it is read first and leaves the title owning the bottom-right. Height
          still comes from `lg:min-h`: with the title clamped to two lines the
          panel has a known maximum, and the floor keeps a one-line title from
          collapsing the box while the time column stands taller.

          The hover is a neutral grey wash across the whole panel, and nothing
          moves. It has to be a layer rather than a background utility, for the
          reason spelled out at the element. Brightening was tried first and is
          a no-op here: the panel is white, so a percentage up moves it somewhere
          it cannot visibly go, and a percentage down reads as pressed rather
          than highlighted. The press state is a deeper step of the same grey
          rather than a second colour. No border: the accent outline was just
          removed from the suggestion cards for the same reason, and one wide
          panel does not need the extra edge. */}
      {activeGames.length > 0 ? (
        <div className="space-y-4">
          {activeGames.map((game) => {
            const rows = titleRows(game.title);
            return (
            /* The whole panel is the control. It is a <button>, not a div with a
               button inside it: a panel-sized hit target has no honest equivalent
               among the native elements, and nesting a real <button> inside one
               is invalid HTML. So the panel is the button, and the type/role/time
               inside it are spans — anything else would put a focusable or
               interactive element inside a control. */
            <button
              key={game.id}
              type="button"
              onClick={() => setSelectedGame(game)}
              aria-label={`Open details for ${game.title}`}
              className="group relative bg-session-bg text-session-text px-8 sm:px-10 py-10 sm:py-11 lg:min-h-[300px] rounded-none w-full text-left cursor-pointer select-none
                flex flex-col sm:flex-row justify-between items-end gap-8
                focus:outline-none focus-visible:outline-2 focus-visible:outline-session-text focus-visible:-outline-offset-4"
            >
              {/* The hover tint is a separate layer rather than a background
                  utility on the panel itself. A translucent background-color
                  *replaces* the panel's white rather than compositing over it,
                  so the panel would blend against the near-black page
                  underneath and go dark on hover — the opposite of a highlight.
                  A child layer is the only way to put a translucent colour over
                  an opaque ground.

                  Neutral, not accent. A yellow wash on a white panel is a
                  colour the rest of the page never puts behind black type, and
                  it made the panel look selected rather than hovered. Zinc is
                  the same move as the rest of the app's surfaces: a shift in
                  lightness, carrying no meaning of its own.

                  It sits first in the DOM and the two content blocks below it
                  are `relative`, because a positioned element paints above
                  static ones and the tint would otherwise wash over the title. */}
              <span
                aria-hidden="true"
                className="absolute inset-0 bg-zinc-200 opacity-0 transition-opacity duration-200 pointer-events-none group-hover:opacity-100 group-active:opacity-60"
              />
              {/* Playtime hard left, title block bottom-right, both standing on
                  the panel's own bottom padding line. The flex lives on the
                  button rather than on a wrapper inside it: a block-level button
                  has a content-height box, so a `h-full` child had no definite
                  height to resolve against and collapsed to auto — which is what
                  left the pair floating in the middle of the panel. As a flex
                  container the button's `items-end` puts both children on the
                  same baseline at the bottom of the content box. */}
              <div className="relative shrink-0">
                <p className="text-[11px] tracking-widest text-session-subtext uppercase font-bold">
                  Playtime
                </p>
                <div className="text-4xl sm:text-5xl font-black text-session-text tracking-tight mt-1">
                  {game.hide_playtime === 1 ? "—" : formatPlaytimePrecise(game.playtime)}
                </div>
              </div>

              <div className="relative flex flex-col items-start sm:items-end gap-4 text-left sm:text-right min-w-0">
                <span className="text-xs font-bold uppercase tracking-widest text-session-subtext">
                  CURRENT SESSION
                </span>
                {/* Two rows, always, split at the word midpoint — so a long name
                    occupies the same two lines a short one does and the panel
                    never changes height between sessions. Deliberately one
                    colour: the accent on the first row was tried and read as
                    two separate headlines rather than one name split across
                    lines, and the split point is arbitrary anyway, so a colour
                    change drew attention to where the break happened to fall. */}
                <h2 className="text-5xl sm:text-7xl lg:text-[5.25rem] font-black uppercase tracking-tighter leading-none font-sans text-session-text">
                  <span className="block">{rows[0]}</span>
                  <span className="block">{rows[1]}</span>
                </h2>
              </div>
            </button>
            );
          })}
        </div>
      ) : (
        <div className="bg-session-bg text-session-text px-8 sm:px-10 py-12 sm:py-14 lg:min-h-[280px] rounded-none flex items-end justify-end transition-all select-none">
          {/* Two rows, bottom right, and nothing else. The copy is split at a word
              boundary rather than wrapped, so the break is the same on every
              screen instead of depending on where the viewport happens to fall.

              Sized with clamp() rather than a breakpoint ladder, because two rows of
              heavy uppercase have to satisfy opposite constraints at once: too large
              and the longer row ("GAMES RIGHT NOW", 15 characters) clips on a
              phone, too small and an empty session stops filling the panel and reads
              as an afterthought beside a live session's 5.25rem name. The 7vw
              midpoint and 6rem ceiling are measured — this string runs ~8.8 times
              its own font size wide at this weight, so anything above ~7.4vw was
              within a few pixels of clipping at 320px. The 1.25rem floor exists so
              the floor itself never becomes the thing that overflows. */}
          <p className="font-sans font-black uppercase tracking-tighter leading-[0.85] text-right text-session-text text-[clamp(1.25rem,7vw,6rem)]">
            <span className="block">No active</span>
            <span className="block">games right now</span>
          </p>
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
                {/* The deck only ever draws from owned titles, so "nothing is in
                    the backlog" and "everything in the backlog is marked Not
                    Owned" both land here. Telling someone to mark games Backlog
                    when the backlog is full of games they do not hold is advice
                    that cannot work, so the two cases say different things. */}
                {blockedOnlyByOwnership
                  ? "Every title in your backlog is marked Not Owned. Suggestions only draw from games you own — clear the Not Owned flag on one to bring it back."
                  : 'Mark games as "Backlog" inside My Library or log discovery entries to run auto-prioritization models.'}
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
               state, where type has to hold up over arbitrary artwork.

               No accent border on hover. Three posters sit side by side, and
               each one flaring to a yellow outline made the row read as three
               loud cards rather than one wall of art — and the outline competed
               with the accent already in the title the hover reveals. The
               border is still there and still accents on focus, so the card
               keeps a visible edge as a keyboard target. */
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
                  className="group relative border border-brand-border bg-zinc-950/30 transition-colors focus:outline-none focus-visible:outline-2 focus-visible:outline-brand-accent cursor-pointer overflow-hidden"
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
                      {/* The status badge sits beside the title, so ownership goes
                          beside the status — the two answer "where does this
                          title stand", and the row's second line is the numbers.
                          Dashed, not filled, so it cannot be mistaken for a fifth
                          status badge. */}
                      {!isOwned(game) && (
                        <span
                          title="Played, but not a copy you own"
                          className="px-1.5 py-0.5 rounded-none text-[11px] font-black border border-dashed border-zinc-600 uppercase tracking-wider text-zinc-400 shrink-0"
                        >
                          Not Owned
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-brand-muted font-bold">
                        {game.hide_playtime === 1 ? "—" : formatPlaytimeLong(game.playtime)}
                      </span>
                      <p className="text-[11px] text-brand-muted uppercase font-bold">
                        {formatDateShort(game.updated_at)}
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
