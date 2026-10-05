import React from "react";
import {
  History, Loader2, Pencil, Plus, Trash2, X,
} from "lucide-react";
import { useGameTrackStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import type { Game, Playthrough } from "../types";
import { STATUSES, getStatusLabel, timesPlayed, replayPlaytime, totalPlaytime, replayAllowed, REPLAY_UNAVAILABLE_REASON } from "../constants";
import { formatPlaytimePrecise, formatDateShort } from "../utils/time";

/**
 * Local-midnight date-string <-> epoch-ms.
 *
 * Deliberately built from local getters rather than `Date.toISOString`, and
 * mirrored on the server. `toISOString` converts to UTC first, so entering
 * 02/10/2026 anywhere west of Greenwich stored the 9th — and this app reads that
 * back as a completion date, so the bug is visible rather than theoretical. The
 * same conversion is used for the game's own completion date; see the note on
 * `formatDateInputValue` in GameDetailsModal, which this must not drift from.
 */
const toDateInputValue = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Inverse of `toDateInputValue`: local midnight, not UTC midnight. */
const fromDateInputValue = (value: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parts = value.split("-").map(Number);
  const [y, m, d] = parts as [number, number, number];
  const date = new Date(y, m - 1, d);
  return isNaN(date.getTime()) ? null : date.getTime();
};

/** Hours-and-minutes entry, parsed into the fractional hours the API stores. */
const parseHoursMinutes = (h: string, m: string): number => {
  const hours = Math.max(0, parseFloat(h) || 0);
  const minutes = Math.max(0, Math.min(59, parseInt(m, 10) || 0));
  return Math.round((hours + minutes / 60) * 100) / 100;
};

/** Inverse of `parseHoursMinutes`, for seeding the form from a stored value. */
const splitPlaytime = (hours: number): { h: string; m: string } => {
  const safe = Math.max(0, hours || 0);
  const whole = Math.floor(safe);
  const minutes = Math.round((safe - whole) * 60);
  return { h: whole ? String(whole) : "", m: minutes ? String(minutes) : "" };
};

/**
 * Editable state for one run's fields. Shared by the "log a replay" form and the
 * per-row editor so the two cannot drift — the create and update paths submit
 * the same shape, and only the endpoint differs.
 */
interface Draft {
  status: Playthrough["status"];
  hours: string;
  minutes: string;
  rating: string;
  dateCompleted: string;
  platform: string;
  notes: string;
}

const emptyDraft = (): Draft => ({
  status: "completed",
  hours: "",
  minutes: "",
  rating: "",
  dateCompleted: "",
  platform: "",
  notes: "",
});

const draftFrom = (run: Playthrough): Draft => {
  const { h, m } = splitPlaytime(run.playtime);
  return {
    status: run.status,
    hours: h,
    minutes: m,
    rating: run.personal_rating == null ? "" : String(run.personal_rating),
    dateCompleted: run.date_completed ? toDateInputValue(run.date_completed) : "",
    platform: run.platform ?? "",
    notes: run.notes ?? "",
  };
};

/** Turn a draft into the API payload, dropping fields the user left blank. */
const payloadFrom = (draft: Draft) => ({
  status: draft.status,
  playtime: parseHoursMinutes(draft.hours, draft.minutes),
  // Rating and date are genuinely nullable, and "cleared it" has to be
  // expressible — sending `undefined` would be stripped by the partial schema and
  // leave the old value in place, so an explicit null is what actually erases it.
  personal_rating: draft.rating === "" ? null : Math.max(0, Math.min(10, parseInt(draft.rating, 10) || 0)),
  date_completed: draft.dateCompleted ? fromDateInputValue(draft.dateCompleted) : null,
  platform: draft.platform.trim() ? draft.platform.trim() : null,
  notes: draft.notes,
});

const PlaythroughFields: React.FC<{
  draft: Draft;
  setDraft: (patch: Partial<Draft>) => void;
  locked: boolean;
  idPrefix: string;
}> = ({ draft, setDraft, locked, idPrefix }) => (
  <div className="space-y-3">
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-status`} className="block text-[11px] font-bold uppercase tracking-wider text-brand-muted">Run Status</label>
        <select
          id={`${idPrefix}-status`}
          value={draft.status}
          disabled={locked}
          onChange={(e) => setDraft({ status: e.target.value as Draft["status"] })}
          className="w-full px-3 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wide text-white focus:outline-none focus:border-brand-accent cursor-pointer disabled:opacity-50"
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-date`} className="block text-[11px] font-bold uppercase tracking-wider text-brand-muted">Completed</label>
        <input
          id={`${idPrefix}-date`}
          type="date"
          value={draft.dateCompleted}
          disabled={locked}
          onChange={(e) => setDraft({ dateCompleted: e.target.value })}
          className="w-full px-3 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wide text-white focus:outline-none focus:border-brand-accent disabled:opacity-50"
        />
      </div>
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-hours`} className="block text-[11px] font-bold uppercase tracking-wider text-brand-muted">Playtime (H)</label>
        <input
          id={`${idPrefix}-hours`}
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={draft.hours}
          disabled={locked}
          onChange={(e) => setDraft({ hours: e.target.value })}
          className="w-full px-3 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-bold text-white focus:outline-none focus:border-brand-accent disabled:opacity-50"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-minutes`} className="block text-[11px] font-bold uppercase tracking-wider text-brand-muted">Min</label>
        <input
          id={`${idPrefix}-minutes`}
          type="number"
          min={0}
          max={59}
          step={1}
          inputMode="numeric"
          value={draft.minutes}
          disabled={locked}
          onChange={(e) => setDraft({ minutes: e.target.value })}
          className="w-full px-3 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-bold text-white focus:outline-none focus:border-brand-accent disabled:opacity-50"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-rating`} className="block text-[11px] font-bold uppercase tracking-wider text-brand-muted">Rating (0-10)</label>
        <input
          id={`${idPrefix}-rating`}
          type="number"
          min={0}
          max={10}
          step={1}
          inputMode="numeric"
          placeholder="—"
          value={draft.rating}
          disabled={locked}
          onChange={(e) => setDraft({ rating: e.target.value })}
          className="w-full px-3 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-bold text-white focus:outline-none focus:border-brand-accent disabled:opacity-50 placeholder:text-zinc-600"
        />
      </div>
    </div>

    <div className="space-y-1">
      <label htmlFor={`${idPrefix}-platform`} className="block text-[11px] font-bold uppercase tracking-wider text-brand-muted">Platform Played On</label>
      <input
        id={`${idPrefix}-platform`}
        type="text"
        maxLength={100}
        placeholder="Optional — a friend's console, shared PC…"
        value={draft.platform}
        disabled={locked}
        onChange={(e) => setDraft({ platform: e.target.value })}
        className="w-full px-3 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-normal text-white focus:outline-none focus:border-brand-accent disabled:opacity-50 placeholder:text-zinc-600"
      />
      <p className="text-[10px] font-semibold normal-case tracking-normal text-brand-muted/80">
        Free text, not the collection's platform tags — a replay is often on a
        copy you do not own.
      </p>
    </div>

    <div className="space-y-1">
      <label htmlFor={`${idPrefix}-notes`} className="block text-[11px] font-bold uppercase tracking-wider text-brand-muted">Run Notes</label>
      <textarea
        id={`${idPrefix}-notes`}
        rows={2}
        maxLength={2000}
        placeholder="Optional — how this run went"
        value={draft.notes}
        disabled={locked}
        onChange={(e) => setDraft({ notes: e.target.value })}
        className="w-full px-3 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-normal text-white focus:outline-none focus:border-brand-accent resize-y disabled:opacity-50 placeholder:text-zinc-600"
      />
    </div>
  </div>
);

/** One line of summary facts about a run, shared by the game row and replays. */
const RunFacts: React.FC<{ status: Playthrough["status"]; playtime: number; date: number | null; platform: string | null }> = ({
  status, playtime, date, platform,
}) => (
  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
    <span className={status === "completed" ? "text-emerald-400" : undefined}>{getStatusLabel(status)}</span>
    <span aria-hidden="true" className="text-zinc-700">/</span>
    <span>{formatPlaytimePrecise(playtime)}</span>
    {/* The date is shown only when the run is finished. A date on an unfinished
        run would be a claim the data does not support, and the server deliberately
        keeps `date_completed` null for those. */}
    {status === "completed" && (
      <>
        <span aria-hidden="true" className="text-zinc-700">/</span>
        <span>{formatDateShort(date)}</span>
      </>
    )}
    {platform && (
      <>
        <span aria-hidden="true" className="text-zinc-700">/</span>
        <span className="text-brand-muted normal-case tracking-normal">{platform}</span>
      </>
    )}
  </div>
);

/**
 * Replay history for one game: the original run plus every replay, and the
 * controls to add, edit or remove a replay.
 *
 * Read mode in the details modal. Editing a replay is deliberately *not* part of
 * the metadata edit form — the modal's Save commits one row of the games table,
 * and folding child rows into it would mean either saving them behind the user's
 * back or reporting a save that did not cover everything on screen. So replays
 * are self-contained here: each control saves immediately and refreshes, so what
 * is on screen always matches what is stored.
 */
export const ReplayHistory: React.FC<{ game: Game; /** Suppressed when a host dialog already titles the panel, so the
   *  name is not printed twice within one screen. */
  hideHeading?: boolean;
  /** Opens with the "log a replay" form already expanded.
   *
   *  Set by the caller that owns the entry point, so one click on a control
   *  labelled "add a replay" does not land the user on a list and then require a
   *  second click to find the button that does the thing they asked for. Reset to
   *  false whenever the panel is closed, or reopening it for the history alone
   *  would put the form back up unasked. */
  startAdding?: boolean }> = ({ game, hideHeading = false, startAdding = false }) => {
  // `useShallow` is required, not stylistic: zustand v5 has no default shallow
  // equality, so a selector returning a fresh object literal compares unequal on
  // every store write and re-renders forever. Fetching also writes to the store
  // it subscribes to, so an unstable selector turns that one write into a loop.
  const {
    playthroughs, loadingPlaythroughs,
    fetchPlaythroughs, addPlaythrough, updatePlaythrough, deletePlaythrough,
  } = useGameTrackStore(useShallow((s) => ({
    playthroughs: s.playthroughs,
    loadingPlaythroughs: s.loadingPlaythroughs,
    fetchPlaythroughs: s.fetchPlaythroughs,
    addPlaythrough: s.addPlaythrough,
    updatePlaythrough: s.updatePlaythrough,
    deletePlaythrough: s.deletePlaythrough,
  })));

  const [adding, setAdding] = React.useState(startAdding);
  const [draft, setDraft] = React.useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = React.useState<number | null>(null);
  const [editDraft, setEditDraft] = React.useState<Draft>(emptyDraft);
  const [confirmId, setConfirmId] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);

  const gameId = game.id;
  const runs = playthroughs[gameId] ?? [];
  const loading = loadingPlaythroughs[gameId] === true;

  // Load on open, and again whenever the modal moves to a different game — the
  // cached list is keyed by id, so switching games within one modal session must
  // not leave the previous game's history on screen.
  //
  // `lastGameIdRef` is what keeps the reset from eating `startAdding`. This
  // effect runs on mount as well as on every switch, and the form's open state
  // is the one piece of transient state that is legitimately non-blank there;
  // resetting unconditionally would slam the form shut on the same tick the
  // caller asked for it to be open.
  const lastGameIdRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    fetchPlaythroughs(gameId);
    // Reset every transient control on a game switch, or an abandoned draft
    // would silently attach itself to the next game opened.
    if (lastGameIdRef.current !== null) {
      setAdding(false);
      setDraft(emptyDraft());
      setEditingId(null);
      setConfirmId(null);
      setBusy(false);
    }
    lastGameIdRef.current = gameId;
  }, [gameId, fetchPlaythroughs]);

  const patchDraft = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const patchEdit = (patch: Partial<Draft>) => setEditDraft((d) => ({ ...d, ...patch }));

  const submitAdd = async () => {
    setBusy(true);
    const ok = await addPlaythrough(gameId, payloadFrom(draft));
    setBusy(false);
    if (ok) {
      setDraft(emptyDraft());
      setAdding(false);
    }
  };

  const submitEdit = async (id: number) => {
    setBusy(true);
    const ok = await updatePlaythrough(id, gameId, payloadFrom(editDraft));
    setBusy(false);
    if (ok) setEditingId(null);
  };

  const totalRuns = timesPlayed(game);
  const replayHours = replayPlaytime(game);
  const allHours = totalPlaytime(game);
  // Recomputed whenever the game changes, not captured once: the user can flip a
  // title's status from the edit form while this panel is mounted behind the
  // dialog, and the control has to follow.
  const canReplay = replayAllowed(game.status);

  return (
    <section aria-labelledby="replay-history-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3
          id="replay-history-heading"
          className={`flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-brand-muted ${hideHeading ? "sr-only" : ""}`}
        >
          <History className="w-3.5 h-3.5 shrink-0" />
          Replay History
        </h3>
        {/* The add control is withheld outright until the game is Completed, not
            disabled. A greyed-out button still advertises the action and still
            costs the user a click to discover it is unavailable; not rendering it
            says the thing does not exist here, which is the truth. The reason is
            spelled out beneath so it reads as a decision rather than a gap. */}
        {canReplay ? (
          <button
            type="button"
            onClick={() => { setAdding((v) => !v); setEditingId(null); setConfirmId(null); }}
            disabled={busy}
            title="Log another playthrough of this game"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-none bg-transparent border border-brand-border text-brand-muted text-[10px] font-black uppercase tracking-widest hover:bg-brand-accent/10 hover:text-brand-accent hover:border-brand-accent/50 transition-colors cursor-pointer disabled:opacity-40"
          >
            {adding ? <X className="w-3 h-3 shrink-0" /> : <Plus className="w-3 h-3 shrink-0" />}
            {adding ? "Cancel" : "Log Replay"}
          </button>
        ) : (
          /* Names the status actually in force rather than a hardcoded "Endless".
             Replays now open up only once a game is Completed, so this stands in
             for every earlier status too, and labelling them all "Endless" would
             be a straightforward lie. */
          <span className="text-[10px] font-bold uppercase tracking-widest text-brand-muted/70 text-right">
            {getStatusLabel(game.status)}
          </span>
        )}
      </div>

      {/* The totals line reconciles the rows beneath it: run #1's hours come from
          the game row, replay hours from the replay rows, and the count from
          1 + the number of rows. Stating all three together is what stops a
          reader assuming the list is the whole history when run #1 is not in it. */}
      <p className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">
        Played{" "}
        <span className="text-brand-accent">{totalRuns}×</span>
        {allHours > 0 && (
          <>
            {" · "}
            <span className="text-white">{formatPlaytimePrecise(allHours)}</span> total
          </>
        )}
        {runs.length > 0 && (
          <>
            {" · "}
            {formatPlaytimePrecise(replayHours)} across {runs.length} replay{runs.length === 1 ? "" : "s"}
          </>
        )}
      </p>

      {adding && (
        <div className="border border-brand-border bg-zinc-950/60 p-4 space-y-3">
          <PlaythroughFields draft={draft} setDraft={patchDraft} locked={busy} idPrefix="replay-new" />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => { setAdding(false); setDraft(emptyDraft()); }}
              disabled={busy}
              className="px-3 py-2 rounded-none bg-transparent border border-brand-border text-brand-muted text-[10px] font-black uppercase tracking-widest hover:text-white transition-colors cursor-pointer disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitAdd}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-2 rounded-none bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink text-[10px] font-black uppercase tracking-widest transition-colors cursor-pointer disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5 shrink-0" />}
              {busy ? "Saving…" : "Log Replay"}
            </button>
          </div>
        </div>
      )}

      <ol className="space-y-2">
        {/* Run #1 is the game row itself, rendered here so the history reads as
            one list. It is not editable from here: its fields are the game's own,
            edited in the metadata form, and offering a second editor for the same
            values would just be two paths to one row. */}
        <li className="border border-brand-border/60 bg-zinc-950/40 px-3 py-2.5 flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-white">Playthrough 1</span>
              <span className="px-1.5 py-0.5 border border-brand-border text-[9px] font-black uppercase tracking-widest text-brand-muted">
                Original
              </span>
            </div>
            <RunFacts
              status={game.status}
              playtime={game.playtime}
              date={game.date_completed}
              platform={null}
            />
          </div>
        </li>

        {loading && runs.length === 0 && (
          <li className="flex items-center gap-2 px-3 py-2.5 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading replays…
          </li>
        )}

        {!loading && runs.length === 0 && (
          <li className="px-3 py-2.5 text-[10px] font-semibold normal-case tracking-normal text-brand-muted/80">
            {canReplay
              ? "No replays logged. The original run above is the only playthrough recorded for this game."
              : REPLAY_UNAVAILABLE_REASON}
          </li>
        )}

        {runs.map((run) => (
          <li key={run.id} className="border border-brand-border/60 bg-zinc-950/40 px-3 py-2.5">
            {editingId === run.id ? (
              <div className="space-y-3">
                <PlaythroughFields draft={editDraft} setDraft={patchEdit} locked={busy} idPrefix={`replay-${run.id}`} />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    disabled={busy}
                    className="px-3 py-2 rounded-none bg-transparent border border-brand-border text-brand-muted text-[10px] font-black uppercase tracking-widest hover:text-white transition-colors cursor-pointer disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => submitEdit(run.id)}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-none bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink text-[10px] font-black uppercase tracking-widest transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5 shrink-0" />}
                    {busy ? "Saving…" : "Save Run"}
                  </button>
                </div>
              </div>
            ) : confirmId === run.id ? (
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
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-white">
                      Playthrough {run.sequence}
                    </span>
                    <span className="px-1.5 py-0.5 border border-brand-border text-[9px] font-black uppercase tracking-widest text-brand-muted">
                      Replay
                    </span>
                  </div>
                  <RunFacts
                    status={run.status}
                    playtime={run.playtime}
                    date={run.date_completed}
                    platform={run.platform}
                  />
                  {run.personal_rating != null && (
                    <p className="text-[10px] font-bold uppercase tracking-widest text-brand-accent">
                      Rated {run.personal_rating}/10
                    </p>
                  )}
                  {run.notes && (
                    <p className="text-[11px] font-normal text-zinc-300 whitespace-pre-wrap break-words">{run.notes}</p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(run.id);
                      setEditDraft(draftFrom(run));
                      setConfirmId(null);
                      setAdding(false);
                    }}
                    disabled={busy}
                    title={`Edit playthrough ${run.sequence}`}
                    aria-label={`Edit playthrough ${run.sequence}`}
                    className="w-7 h-7 flex items-center justify-center rounded-none bg-transparent border border-brand-border text-brand-muted hover:bg-brand-accent/10 hover:text-brand-accent hover:border-brand-accent/50 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => { setConfirmId(run.id); setEditingId(null); }}
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
    </section>
  );
};