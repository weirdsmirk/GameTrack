import React from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown, Loader2, Pencil, Plus, X } from "lucide-react";
import { STATUSES } from "../constants";
import { useModalA11y } from "../hooks/useModalA11y";
import type { Playthrough } from "../types";

/**
 * The log/edit form for one playthrough, as a dialog in its own right.
 *
 * It was an inline panel inside the replay-history dialog, which read as a wall
 * of fields dropped into the middle of a list: opening it pushed the ledger down
 * by ~400px, the run count and totals strip stopped being the frame the rows were
 * read against, and on a short viewport the form's own buttons fell off the
 * bottom. As a dialog it gets its own scroll, its own focus trap and its own
 * Escape, and the history behind it stays where it was.
 *
 * Both modes live here on purpose. Add and edit are the same six fields and the
 * same payload shape — only the endpoint differs — so one dialog serving both is
 * what stops the two presentations drifting apart the way two inline forms did.
 */

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
 * per-row editor so the two cannot drift — the create and update paths submit the
 * same shape, and only the endpoint differs.
 */
export interface Draft {
  status: Playthrough["status"];
  hours: string;
  minutes: string;
  rating: string;
  dateCompleted: string;
  platform: string;
  notes: string;
}

export const emptyDraft = (): Draft => ({
  status: "completed",
  hours: "",
  minutes: "",
  rating: "",
  dateCompleted: "",
  platform: "",
  notes: "",
});

/** Seeds the form from a stored run, for the edit path. */
export const draftFrom = (run: Playthrough): Draft => {
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
export const payloadFrom = (draft: Draft) => ({
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

const RunFields: React.FC<{
  draft: Draft;
  setDraft: (patch: Partial<Draft>) => void;
  locked: boolean;
  idPrefix: string;
}> = ({ draft, setDraft, locked, idPrefix }) => (
  <div className="space-y-3">
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-status`} className="block text-[11px] font-bold uppercase tracking-wider text-brand-muted">Run Status</label>
        {/* `appearance-none` + a lucide chevron, which is how every other select in
            the app is built (LibraryView's filters, AddGameModal). Left native,
            this one drew the browser's own arrow: a thin hairline chevron in the
            UA's colour, sitting at whatever inset the platform chose, which is
            the only control in the app not wearing its own icon set. The `pr-10`
            is what keeps the text clear of it. */}
        <div className="relative">
          <select
            id={`${idPrefix}-status`}
            value={draft.status}
            disabled={locked}
            onChange={(e) => setDraft({ status: e.target.value as Draft["status"] })}
            className="w-full pl-3 pr-10 py-2 bg-brand-bg border border-brand-border rounded-none text-xs font-bold uppercase tracking-wide text-white focus:outline-none focus:border-brand-accent cursor-pointer appearance-none disabled:opacity-50"
          >
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <div
            aria-hidden="true"
            className={`absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-brand-muted ${locked ? "opacity-50" : ""}`}
          >
            <ChevronDown className="w-4 h-4" />
          </div>
        </div>
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

/**
 * Which run this dialog is editing. `sequence` is only set on edit, where it names
 * the run being changed; on add it is the number the new run will get, which the
 * caller knows from the game's current play count.
 */
export type RunDialogMode = { kind: "add"; sequence: number } | { kind: "edit"; run: Playthrough };

export const RunFormDialog: React.FC<{
  mode: RunDialogMode;
  /** The game the run belongs to — named in the header so the dialog says which
   *  game it is about without the history behind having to be read. */
  gameTitle: string;
  draft: Draft;
  setDraft: (patch: Partial<Draft>) => void;
  busy: boolean;
  onClose: () => void;
  onSubmit: () => void;
}> = ({ mode, gameTitle, draft, setDraft, busy, onClose, onSubmit }) => {
  const dialogRef = useModalA11y(true);
  const editing = mode.kind === "edit";
  const sequence = editing ? mode.run.sequence : mode.sequence;

  return (
    /* z-[90] sits above the replay history's z-[70] and the delete confirm's
       z-[80]: this is the third layer, and it has to paint over both. The
       backdrop is darker than theirs because there is more behind it to bury. */
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/85"
        onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <motion.div
          ref={dialogRef}
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          transition={{ duration: 0.15 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="run-form-title"
          /* `max-h` rather than `max-h-[85vh]`, and the cap accounts for the
             backdrop's `p-4`: 85vh left the panel taller than the space it was
             centred in, so on a short viewport it overflowed at both ends and the
             header went off screen with nothing to scroll. `dvh` so a collapsing
             mobile address bar cannot shrink the viewport under the form. */
          className="relative w-full max-w-lg max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden border border-brand-border bg-brand-bg text-white shadow-2xl"
        >
          <div className="px-5 py-4 border-b border-brand-border/60 shrink-0 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 id="run-form-title" className="text-[11px] font-black uppercase tracking-widest text-brand-accent">
                {editing ? "Edit Run" : "Log Replay"}
              </h3>
              <p className="text-[10px] font-bold uppercase tracking-widest text-brand-muted truncate mt-0.5">
                Run {sequence} · {gameTitle}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label={editing ? `Close edit run ${sequence}` : "Close log replay"}
              className="w-[30px] h-[30px] shrink-0 rounded-none bg-zinc-950 border border-brand-border text-brand-muted hover:text-white hover:border-brand-accent/50 transition-colors cursor-pointer flex items-center justify-center disabled:opacity-40"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* The one scrolling region. The actions live in their own shrink-0 row
              rather than at the end of the fields, so Save is reachable on a short
              screen without scrolling to find it. */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5">
            <RunFields draft={draft} setDraft={setDraft} locked={busy} idPrefix={editing ? `replay-${mode.run.id}` : "replay-new"} />
          </div>

          <div className="px-5 py-3 border-t border-brand-border/60 shrink-0 flex items-center justify-end gap-2 bg-zinc-950/40">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-3 py-2 rounded-none bg-transparent border border-brand-border text-brand-muted text-[10px] font-black uppercase tracking-widest hover:text-white hover:border-brand-accent/50 transition-colors cursor-pointer disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-2 rounded-none bg-brand-accent hover:bg-brand-accent-hover text-brand-accent-ink text-[10px] font-black uppercase tracking-widest active:translate-y-px transition-all cursor-pointer disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : editing ? <Pencil className="w-3.5 h-3.5 shrink-0" /> : <Plus className="w-3.5 h-3.5 shrink-0" />}
              {busy ? "Saving…" : editing ? "Save Run" : "Log Replay"}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};