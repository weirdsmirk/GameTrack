import React from "react";
import {
  History, Loader2, Pencil, Plus, Trash2,
} from "lucide-react";
import { useGameTrackStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import type { Game, Playthrough } from "../types";
import { getStatusLabel, timesPlayed, replayPlaytime, totalPlaytime, replayAllowed, REPLAY_UNAVAILABLE_REASON } from "../constants";
import { formatPlaytimePrecise, formatDateShort } from "../utils/time";

/**
 * One run, as a ledger row: the hours are the figure, the metadata hangs off it.
 *
 * The hours lead because that is what this panel is for — it was previously one
 * flat run of slash-separated words (`BACKLOG / 0H / 12 MAR`) in which the status
 * outranked the only number a reader came for, and every row had identical
 * weight so a 40-hour run and an untouched one looked like equals.
 *
 * `tabular-nums` on the figure: rows are meant to be compared down the column,
 * and proportional digits give "11H" and "8H" different widths, so the numbers
 * do not line up and the eye cannot scan the hours.
 */
const RunRow: React.FC<{
  status: Playthrough["status"];
  playtime: number;
  date: number | null;
  platform: string | null;
  rating?: number | null;
  notes?: string | null;
  /** Run #1's number. Replays pass their own sequence so the rows stay
   *  identifiable once the badge is the only thing distinguishing them. */
  sequence: number;
  isOriginal?: boolean;
}> = ({ status, playtime, date, platform, rating = null, notes = null, sequence, isOriginal = false }) => {
  // A run with no hours logged yet is a placeholder, not a measurement, so it is
  // pulled back to muted rather than printed in the same weight as a real total.
  //
  // zinc-500, not zinc-600: at this size the figure is large text, so the bar is
  // 3:1 — and zinc-600 measures 2.6:1 against the panel. zinc-500 clears it at
  // ~4.1:1 while still reading as "nothing recorded here". The same reasoning is
  // behind METRIC_VALUE_RULE's dashed rule in the details modal.
  const logged = playtime > 0;
  return (
    <div className="flex items-start gap-4 sm:gap-5">
      <div className="shrink-0 text-right">
        <div
          className={`text-2xl sm:text-3xl font-black tabular-nums leading-none tracking-tight ${
            logged ? "text-white" : "text-zinc-500"
          }`}
        >
          {formatPlaytimePrecise(playtime)}
        </div>
      </div>

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={`px-1.5 py-0.5 border text-[9px] font-black uppercase tracking-widest ${
              isOriginal
                ? "border-brand-accent/50 text-brand-accent"
                : "border-brand-border text-brand-muted"
            }`}
          >
            {isOriginal ? "Original" : `Replay ${sequence}`}
          </span>
          <span
            className={`text-[10px] font-bold uppercase tracking-widest ${
              status === "completed" ? "text-emerald-400" : "text-brand-muted"
            }`}
          >
            {getStatusLabel(status)}
          </span>
        </div>

        {/* The date is shown only when the run is finished. A date on an unfinished
            run would be a claim the data does not support, and the server
            deliberately keeps `date_completed` null for those.

            Rendered only when something lands in it — an always-present empty
            flex row still claims a line of height, which on an untouched run
            leaves a conspicuous gap under the badge. */}
        {(status === "completed" || rating != null || platform) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
            {status === "completed" && <span>{formatDateShort(date)}</span>}
            {rating != null && <span className="text-brand-accent">Rated {rating}/10</span>}
            {platform && <span className="normal-case tracking-normal">{platform}</span>}
          </div>
        )}

        {notes && (
          <p className="text-[11px] font-normal text-zinc-300 whitespace-pre-wrap break-words leading-relaxed pt-0.5">
            {notes}
          </p>
        )}
      </div>
    </div>
  );
};

/**
 * Replay history for one game: the original run plus every replay.
 *
 * Read mode in the details modal. Editing a replay is deliberately *not* part of
 * the metadata edit form — the modal's Save commits one row of the games table,
 * and folding child rows into it would mean either saving them behind the user's
 * back or reporting a save that did not cover everything on screen. So replays
 * are self-contained here: each control saves immediately and refreshes, so what
 * is on screen always matches what is stored.
 *
 * A list, and only a list. The add and edit forms are a dialog owned by the host
 * (see RunFormDialog), requested through `onLogReplay` / `onEditRun` rather than
 * rendered here — a third layer of modal from inside a modal is only safe when
 * one component owns all of them, and that is GameDetailsModal.
 */
export const ReplayHistory: React.FC<{ game: Game; /** Suppressed when a host dialog already titles the panel, so the
   *  name is not printed twice within one screen. */
  hideHeading?: boolean;
  /** Open the add-run dialog. */
  onLogReplay: () => void;
  /** Open the edit-run dialog for one existing replay. */
  onEditRun: (run: Playthrough) => void }> = ({ game, hideHeading = false, onLogReplay, onEditRun }) => {
  // `useShallow` is required, not stylistic: zustand v5 has no default shallow
  // equality, so a selector returning a fresh object literal compares unequal on
  // every store write and re-renders forever. Fetching also writes to the store
  // it subscribes to, so an unstable selector turns that one write into a loop.
  const {
    playthroughs, loadingPlaythroughs,
    fetchPlaythroughs, deletePlaythrough,
  } = useGameTrackStore(useShallow((s) => ({
    playthroughs: s.playthroughs,
    loadingPlaythroughs: s.loadingPlaythroughs,
    fetchPlaythroughs: s.fetchPlaythroughs,
    deletePlaythrough: s.deletePlaythrough,
  })));

  // Delete confirmation stays inline: it is two buttons and one sentence, so it
  // belongs on the row it acts on rather than in a third stacked dialog. The
  // add/edit forms went the other way — they are six fields, and inline they
  // buried the ledger.
  const [confirmId, setConfirmId] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);

  const gameId = game.id;
  const runs = playthroughs[gameId] ?? [];
  const loading = loadingPlaythroughs[gameId] === true;

  // Load on open, and again whenever the modal moves to a different game — the
  // cached list is keyed by id, so switching games within one modal session must
  // not leave the previous game's history on screen. The pending delete
  // confirmation is dropped with it, so a half-made decision cannot follow the
  // user onto the next game.
  React.useEffect(() => {
    fetchPlaythroughs(gameId);
    setConfirmId(null);
    setBusy(false);
  }, [gameId, fetchPlaythroughs]);

  const totalRuns = timesPlayed(game);
  const replayHours = replayPlaytime(game);
  const allHours = totalPlaytime(game);
  // The game row is run #1 and is not in `runs`, so it has to be part of the
  // max. Derived rather than stored — there is no per-game "longest run" column.
  const longestRun = Math.max(game.playtime || 0, ...runs.map((r) => r.playtime || 0));
  // Recomputed whenever the game changes, not captured once: the user can flip a
  // title's status from the edit form while this panel is mounted behind the
  // dialog, and the control has to follow.
  const canReplay = replayAllowed(game.status);

  return (
    /* Owns its own padding and its own scroll container. The dialog that hosts
       it no longer scrolls (`overflow-hidden`), because the header and totals
       above need to stay pinned while a long list moves.

       `flex-1 min-h-0`, not `h-full`. A percentage height cannot resolve against
       a parent whose own height comes from flex layout rather than a `height`
       declaration, so it silently fell back to `auto`: the inner scroller kept
       its full content height, never overflowed, and therefore never scrolled —
       the list just ran past the bottom of the dialog and got clipped. Flex
       sizing resolves inside the flex line instead. */
    <section
      aria-labelledby="replay-history-heading"
      className="flex flex-col flex-1 min-h-0 px-5 pb-5"
    >
      {/* ── Ledger header ──────────────────────────────────────────────────
          The run count is the hero because it is the one number this panel
          exists to answer — "how many times have I finished this?" — and it was
          previously a `PLAYED 1×` fragment competing with a button for the same
          line. Hours sit beside it as the supporting figure, because that is
          what the reader is reconciling the rows against.

          The replay subtotal is shown only once it can mean something: with no
          replays it would read "0H across 0 replays", which is a true statement
          about nothing. */}
      <div className="flex items-end justify-between gap-4 pt-5 pb-4 border-b border-brand-border/60 shrink-0">
        <div className="min-w-0">
          <h3
            id="replay-history-heading"
            className={`flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-brand-muted ${hideHeading ? "sr-only" : ""}`}
          >
            <History className="w-3.5 h-3.5 shrink-0" />
            Runs
          </h3>
          <p className="mt-2 flex items-baseline gap-1.5">
            <span className="text-4xl sm:text-5xl font-black leading-none tracking-tight tabular-nums text-white">
              {totalRuns}
            </span>
            <span className="text-xl sm:text-2xl font-black leading-none text-brand-accent">
              &times;
            </span>
          </p>
        </div>

        {/* The add control is withheld outright until the game is Completed, not
            disabled. A greyed-out button still advertises the action and still
            costs the user a click to discover it is unavailable; not rendering it
            says the thing does not exist here, which is the truth. The reason is
            spelled out beneath so it reads as a decision rather than a gap. */}
        {canReplay ? (
          <button
            type="button"
            onClick={() => { setConfirmId(null); onLogReplay(); }}
            disabled={busy}
            title="Log another playthrough of this game"
            className="flex items-center gap-1.5 shrink-0 px-3 py-2 rounded-none bg-transparent border border-brand-border text-brand-muted text-[10px] font-black uppercase tracking-widest hover:bg-brand-accent/10 hover:text-brand-accent hover:border-brand-accent/50 active:bg-brand-accent/20 transition-colors cursor-pointer disabled:opacity-40"
          >
            <Plus className="w-3 h-3 shrink-0" />
            Log Replay
          </button>
        ) : (
          /* Names the status actually in force rather than a hardcoded "Endless".
             Replays now open up only once a game is Completed, so this stands in
             for every earlier status too, and labelling them all "Endless" would
             be a straightforward lie. */
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-brand-muted/70 text-right">
            {getStatusLabel(game.status)}
          </span>
        )}
      </div>

      {/* ── Totals strip ───────────────────────────────────────────────────
          Reconciles the rows beneath it: run #1's hours come from the game row,
          the replay subtotal from the replay rows, and the count from 1 + the
          number of rows. Stating all three together is what stops a reader
          assuming the list is the whole history when run #1 is not in it.

          A hairline-divided strip rather than the old run of `·`-separated
          fragments, so each figure is a discrete cell rather than a clause in a
          sentence, and the row of three holds its shape as values change width. */}
      <dl className="grid grid-cols-2 sm:grid-cols-3 divide-x divide-brand-border/60 border-b border-brand-border/60 shrink-0">
        <div className="py-3 pr-4">
          <dt className="text-[9px] font-bold uppercase tracking-widest text-brand-muted">All runs</dt>
          <dd className="mt-1 text-sm font-black text-white tabular-nums">
            {allHours > 0 ? formatPlaytimePrecise(allHours) : "—"}
          </dd>
        </div>
        <div className="py-3 pr-4">
          <dt className="text-[9px] font-bold uppercase tracking-widest text-brand-muted">Replays</dt>
          <dd className="mt-1 text-sm font-black text-white tabular-nums">
            {runs.length > 0 ? formatPlaytimePrecise(replayHours) : "—"}
          </dd>
        </div>
        <div className="py-3 pl-4 hidden sm:block">
          <dt className="text-[9px] font-bold uppercase tracking-widest text-brand-muted">Longest</dt>
          <dd className="mt-1 text-sm font-black text-white tabular-nums">
            {/* Max across the game row and every replay. Recomputed from the
                rows rather than stored: there is no per-game "longest run"
                column, and deriving it here keeps the server's denormalised
                replay totals out of a display concern. */}
            {longestRun > 0 ? formatPlaytimePrecise(longestRun) : "—"}
          </dd>
        </div>
      </dl>

      {/* The one scrolling region. Everything above it is the fixed reference
          frame; everything inside it is the growing list. `overscroll-contain`
          so scrolling the tail of a long list does not hand the gesture to the
          details modal behind. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
      {/* `divide-y` rather than separately bordered boxes. Every row carried its
          own 1px frame before, which made a run with notes look heavier than one
          without and turned the list into a stack of cards instead of a ledger.
          Dividers let the hours column run uninterrupted down the panel. */}
      <ol className="mt-1 divide-y divide-brand-border/50">
        {/* Run #1 is the game row itself, rendered here so the history reads as
            one list. It is not editable from here: its fields are the game's own,
            edited in the metadata form, and offering a second editor for the same
            values would just be two paths to one row. */}
        <li className="py-4 flex items-start justify-between gap-3">
          <RunRow
            status={game.status}
            playtime={game.playtime}
            date={game.date_completed}
            platform={null}
            sequence={1}
            isOriginal
          />
        </li>

        {loading && runs.length === 0 && (
          <li className="flex items-center gap-2 py-4 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading replays…
          </li>
        )}

        {!loading && runs.length === 0 && (
          /* Composed rather than one sentence: the state is "one run so far", so
             it says that in the panel's own terms instead of explaining the
             absence of a list that never had much in it. */
          <li className="py-6 flex items-start gap-3">
            <span className="mt-0.5 shrink-0 w-7 h-7 flex items-center justify-center border border-dashed border-zinc-600 text-zinc-500">
              {canReplay ? <Plus className="w-3 h-3" aria-hidden /> : <History className="w-3 h-3" aria-hidden />}
            </span>
            <div className="min-w-0 space-y-1">
              <p className="text-[11px] font-black uppercase tracking-widest text-brand-muted">
                One run so far
              </p>
              <p className="text-[11px] font-normal normal-case tracking-normal text-brand-muted/80 leading-relaxed">
                {canReplay
                  ? "No replays logged yet. The original run above is the only playthrough recorded for this game."
                  : REPLAY_UNAVAILABLE_REASON}
              </p>
            </div>
          </li>
        )}

        {runs.map((run) => (
          /* Only the delete confirmation expands in place now. The edit form used
             to sit here too, and it was the reason rows needed a framed
             expanded state at all — a six-field form wedged into a ledger row
             broke the divider rhythm and buried the hours column. */
          <li
            key={run.id}
            className={confirmId === run.id ? "my-3 border border-brand-border bg-zinc-950/60 p-4" : "py-4"}
          >
            {confirmId === run.id ? (
              <div className="space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-red-400">
                  Remove playthrough {run.sequence}?
                </p>
                <p className="text-[10px] font-semibold normal-case tracking-normal text-brand-muted">
                  This deletes the logged run and its hours. The original
                  playthrough above is not affected.
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    disabled={busy}
                    className="px-3 py-2 rounded-none bg-transparent border border-brand-border text-brand-muted text-[10px] font-black uppercase tracking-widest hover:text-white transition-colors cursor-pointer disabled:opacity-40"
                  >
                    Keep It
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setBusy(true);
                      const ok = await deletePlaythrough(run.id, gameId);
                      setBusy(false);
                      if (ok) setConfirmId(null);
                    }}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-none bg-red-500 text-brand-on-color text-[10px] font-black uppercase tracking-widest transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 shrink-0" />}
                    {busy ? "Removing…" : "Delete"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <RunRow
                  status={run.status}
                  playtime={run.playtime}
                  date={run.date_completed}
                  platform={run.platform}
                  rating={run.personal_rating}
                  notes={run.notes}
                  sequence={run.sequence}
                />
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => { setConfirmId(null); onEditRun(run); }}
                    disabled={busy}
                    title={`Edit playthrough ${run.sequence}`}
                    aria-label={`Edit playthrough ${run.sequence}`}
                    className="w-7 h-7 flex items-center justify-center rounded-none bg-transparent border border-brand-border text-brand-muted hover:bg-brand-accent/10 hover:text-brand-accent hover:border-brand-accent/50 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(run.id)}
                    disabled={busy}
                    title={`Delete playthrough ${run.sequence}`}
                    aria-label={`Delete playthrough ${run.sequence}`}
                    className="w-7 h-7 flex items-center justify-center rounded-none bg-transparent border border-brand-border text-brand-muted hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/35 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
      </div>
    </section>
  );
};