import React, { useEffect } from "react";
import { useGameTrackStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { 
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid
} from "recharts";
import { STATUSES, mergeCustomPlatforms, platformIdMatches, isOwned } from "../constants";
import { formatPlaytimePrecise, formatDateShort } from "../utils/time";

/** How many calendar months the chart covers, current month included. */
const COMPLETED_MONTH_SPAN = 6;

/** How many titles the Most Played list ranks. Six fills the panel at its
    current height without the rows crowding each other. */
const MOST_PLAYED_COUNT = 6;

/** One calendar month on the completion chart. */
type CompletedMonth = {
  /** Three-letter month, used verbatim as the axis tick. */
  label: string;
  /** Month and year, for the tooltip — six ticks can straddle a year end. */
  full: string;
  /** Key for matching a timestamp to this bucket. */
  key: string;
  count: number;
};

/** Fixed month abbreviations for the completions axis. These are axis
    categories, not dates: a month on a six-month time axis is a name, and
    printing it as DD/MM/YY would imply a specific day the data does not have.
    Hard-coded so the axis cannot reflow to a different width per locale. */
const MONTH_ABBR = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/** `Date.getMonth()` is always 0-11, so this lookup cannot miss; the fallback
    is only there to satisfy the compiler's index signature. */
const monthAbbr = (index: number) => MONTH_ABBR[index] ?? "";

/** The month tooltip. Names the month and year, because a bare "SEP" among six
    ticks gives no way to tell a September this year from one three years ago. */
const MonthTooltip = React.memo(
  ({ active, payload }: { active?: boolean; payload?: { payload: CompletedMonth }[] }) => {
    const m = payload?.[0]?.payload;
    if (!active || !m) return null;
    return (
      <div className="bg-zinc-950 border border-brand-border px-3 py-2.5 text-[11px] uppercase tracking-wider shadow-xl whitespace-nowrap">
        <p className="font-black text-white">{m.full}</p>
        <p className="mt-1.5 text-brand-muted">
          <span className="font-black text-brand-accent">{m.count}</span>{" "}
          {m.count === 1 ? "Game" : "Games"} Completed
        </p>
      </div>
    );
  }
);

/**
 * Solid status colours for bars, keyed to the shared palette — the same four
 * the Library badges and the details-modal status group use. This map had
 * drifted: it gave `playing` emerald and `completed` the brand accent, which
 * `constants.ts` explicitly rejects, because yellow there reads as "this is
 * selected", not "you finished this". On the analytics page the same yellow
 * also meant "the current completion rate", so the accent was carrying three
 * unrelated jobs at once.
 */
const STATUS_BAR_COLORS: Record<string, string> = {
  backlog: "var(--zinc-500-val)",
  playing: "var(--blue-500-val)",
  completed: "var(--emerald-500-val)",
  endless: "var(--fuchsia-500-val)",
};

export const AnalyticsView: React.FC = React.memo(() => {
  const { 
    games, summary, mostReplayed, lastAnalyticsFetch, fetchAnalytics, customPlatforms
  } = useGameTrackStore(useShallow((s) => ({
    games: s.games, summary: s.summary, mostReplayed: s.mostReplayed,
    lastAnalyticsFetch: s.lastAnalyticsFetch,
    fetchAnalytics: s.fetchAnalytics, customPlatforms: s.customPlatforms,
  })));

  useEffect(() => {
    if (!summary || Date.now() - lastAnalyticsFetch > 60_000) fetchAnalytics();
  }, [fetchAnalytics, summary, lastAnalyticsFetch]);

  const totalGames = games.length;

  const totalPlaytime = React.useMemo(() => {
    return games.reduce((sum, g) => sum + (g.hide_playtime === 1 ? 0 : (g.playtime || 0)), 0);
  }, [games]);



  // ── Library composition ───────────────────────────────────────────
  // One pass over the library, because the status split and the launch-state
  // split are two readings of the same rows and counting them separately is how
  // the two halves of the panel drift apart.
  //
  // The status split on its own cannot say whether the collection has been
  // touched: a backlog game with hours logged was tried and put down, which is
  // a different thing from one that has never been launched. With this
  // library, 17 of the 23 backlog titles have zero hours and 6 have hours —
  // so "backlog" alone overstates how much is genuinely untouched. That split
  // is the only figure in this panel that appears nowhere else on the page.
  const composition = React.useMemo(() => {
    const total = games.length;
    if (total === 0) {
      return {
        rows: [] as { key: string; label: string; count: number; pct: number; color: string }[],
        neverLaunched: 0,
        launched: 0,
        neverLaunchedPct: 0,
        shelved: 0,
        backlogUnlaunched: 0,
      };
    }
    const knownLabels = new Set<string>(STATUSES.map((s) => s.value));
    const counts = new Map<string, number>();
    let neverLaunched = 0;
    let shelved = 0;
    let backlogUnlaunched = 0;
    for (const g of games) {
      counts.set(g.status, (counts.get(g.status) ?? 0) + 1);
      const started = (g.playtime || 0) > 0;
      if (started) {
        if (g.status === "backlog") shelved += 1;
      } else {
        neverLaunched += 1;
        if (g.status === "backlog") backlogUnlaunched += 1;
      }
    }
    // A status outside the four the picker offers still has to be counted, or
    // the rows would not add up to the library total and the panel would
    // quietly disagree with the strip above it.
    const unknown = [...counts.entries()]
      .filter(([key]) => !knownLabels.has(key))
      .map(([key, count]) => ({ key, label: key, count }));
    const rows = [
      ...STATUSES.map((s) => ({ key: s.value, label: s.label, count: counts.get(s.value) ?? 0 })),
      ...unknown,
    ]
      .filter((r) => r.count > 0)
      .map((r) => ({
        ...r,
        pct: Math.round((r.count / total) * 100),
        color: STATUS_BAR_COLORS[r.key] ?? "var(--zinc-500-val)",
      }));
    const neverLaunchedPct = Math.round((neverLaunched / total) * 100);
    return {
      rows,
      neverLaunched,
      launched: total - neverLaunched,
      neverLaunchedPct,
      shelved,
      backlogUnlaunched,
    };
  }, [games]);

  // ── Ownership split ──────────────────────────────────────────────
  // Played-but-not-owned titles are real library rows with real hours and real
  // ratings, so nothing here excludes them — they are simply counted apart from
  // the collection, because "how much of this is on my shelf" and "how much have
  // I actually played" are different questions and merging them hides the
  // second one.
  //
  // Read off `games` rather than the server summary, so this bar cannot
  // disagree with the figures above it while an analytics fetch is in flight.
  // Counted from the same rows and the same hide_playtime rule as everything
  // else here, so the hours quoted reconcile with Total Playtime on the strip.
  const ownership = React.useMemo(() => {
    let owned = 0;
    let notOwned = 0;
    let notOwnedHours = 0;
    for (const g of games) {
      if (isOwned(g)) {
        owned += 1;
      } else {
        notOwned += 1;
        notOwnedHours += g.hide_playtime === 1 ? 0 : g.playtime || 0;
      }
    }
    // The bar is a share of *titles*, so the percentage is a share of the
    // library's rows. Hours are reported separately, against the strip's own
    // Total Playtime figure, rather than folded into the same percentage —
    // three hours across two borrowed titles is not half the library.
    const total = owned + notOwned;
    return {
      owned,
      notOwned,
      notOwnedHours,
      ownedPct: total > 0 ? Math.round((owned / total) * 100) : 0,
    };
  }, [games]);

  /* Replay figures, read from the server's summary rather than recounted here.
     They are aggregates over a table the analytics payload does not carry, and
     the server already computes them inside the same query as the totals they
     must reconcile with — recounting from `games` could only reproduce them,
     or drift from them if the rules ever differ.

     `?? 0` on every field rather than a whole-object fallback: the analytics
     cache is backfilled for a pre-replays payload, but a partial payload should
     render zeros, not NaN, and NaN in a `<span>` prints as "NaN of NaN hrs". */
  const replays = React.useMemo(() => {
    const s = summary;
    const timesPlayed = s?.times_played ?? 0;
    const totalGames = s?.total_games ?? 0;
    return {
      replayedGames: s?.replayed_games ?? 0,
      timesPlayed,
      totalGames,
      // Stated as a derived difference rather than trusting `replay_runs`: the
      // identity `times_played - total_games === extra runs` is the one worth
      // showing, and computing it here makes the reconciliation visible instead of
      // asserting it. Clamped at 0 so a cache written mid-migration (totals from
      // one build, runs from another) cannot render a negative run count.
      extraRuns: Math.max(0, timesPlayed - totalGames),
      replayHours: s?.replay_playtime_hours ?? 0,
      allHours: s?.all_playthroughs_hours ?? 0,
    };
  }, [summary]);

  // The strip's completion figures are read back out of the composition rather
  // than counted again, so the two panels cannot disagree. Same arithmetic,
  // same denominator, one source.
  const completedGames = composition.rows.find((r) => r.key === "completed")?.count ?? 0;
  const completionRate = totalGames > 0 ? Math.round((completedGames / totalGames) * 100) : 0;

  // ── Most played ───────────────────────────────────────────────────
  // The ranking is tracked hours and nothing else. `hide_playtime` titles are
  // dropped rather than shown as a bar with a hidden figure, which is the same
  // reason the hour total above excludes them — so the share quoted underneath
  // is measured against that same total and the two cannot disagree.
  const playtime = React.useMemo(() => {
    const visible = games
      .filter((g) => g.hide_playtime !== 1 && (g.playtime || 0) > 0)
      .sort((a, b) => (b.playtime || 0) - (a.playtime || 0));
    const listed = visible.slice(0, MOST_PLAYED_COUNT);
    const listedHours = listed.reduce((s, g) => s + (g.playtime || 0), 0);
    // How concentrated the library's hours are: how many titles it takes to
    // reach half of them. A library spread across dozens of games needs a large
    // number here; one dominated by a handful needs a very small one, and the
    // two look identical in a ranked list until you say so.
    let running = 0;
    let halfAt = 0;
    for (const g of visible) {
      running += g.playtime || 0;
      halfAt += 1;
      if (running >= (totalPlaytime || 0) / 2) break;
    }
    return {
      listed,
      maxHours: Math.max(1, ...listed.map((g) => g.playtime || 0)),
      playedCount: visible.length,
      listedHours,
      // Null rather than a number when the library has no tracked hours at all,
      // so the panel never claims a share of nothing.
      listedPct: totalPlaytime > 0 ? Math.round((listedHours / totalPlaytime) * 100) : null,
      halfAt: totalPlaytime > 0 ? halfAt : null,
      avgHours: visible.length > 0 ? totalPlaytime / visible.length : null,
    };
  }, [games, totalPlaytime]);
  const mostPlayed = playtime.listed;

  // Completed titles, most recently finished first (top 8)
  const completedList = React.useMemo(() => {
    return [...games]
      .filter(g => g.status === "completed")
      .sort((a, b) => (b.date_completed || 0) - (a.date_completed || 0))
      .slice(0, 8);
  }, [games]);

  // ── Platform distribution ──────────────────────────────────────────
  // Built-in platforms plus the user's own tags, so a custom platform is named
  // rather than shown as the raw slug it is stored as.
  const platforms = React.useMemo(() => mergeCustomPlatforms(customPlatforms), [customPlatforms]);

  const platformRows = React.useMemo(() => {
    const totals = new Map<string, { id: string; label: string; titles: number; hours: number }>();
    const bump = (id: string, label: string) => {
      const key = id.toLowerCase();
      const found = totals.get(key);
      if (found) return found;
      const row = { id: key, label, titles: 0, hours: 0 };
      totals.set(key, row);
      return row;
    };
    let associations = 0;
    let multiPlatform = 0;
    let unplatformed = 0;
    // Games played without a copy. Counted and timed, but kept OUT of the
    // platform buckets below: a not-owned title has no platform tags at all
    // (see PLATFORMS_LOCKED_REASON), so it cannot contribute one, and folding
    // it into the distribution anyway would count it toward a shelf it was never
    // on. Reported as their own line instead, so nothing is hidden and the two
    // never masquerade as each other.
    let ownedTitles = 0;
    let ownedHours = 0;
    let notOwnedTitles = 0;
    let notOwnedHours = 0;
    for (const g of games) {
      const hours = g.hide_playtime === 1 ? 0 : g.playtime || 0;
      if (!isOwned(g)) {
        notOwnedTitles += 1;
        notOwnedHours += hours;
        continue;
      }
      ownedTitles += 1;
      ownedHours += hours;
      // `owned_platforms` holds free strings, and the same platform can arrive
      // as "Steam" or "steam", so every value is matched through
      // `platformIdMatches` before it is bucketed. An unmatched value still
      // gets a row of its own rather than being dropped — a title carrying a
      // tag the app has never heard of is still an owned title.
      const ids = (g.owned_platforms || []).map((raw) => {
        const match = platforms.find((p) => platformIdMatches(p.id, raw));
        return match ? match.id : raw.trim().toLowerCase();
      });
      if (ids.length === 0) unplatformed += 1;
      if (ids.length > 1) multiPlatform += 1;
      associations += ids.length;
      // A title on several platforms has its playtime SPLIT between them rather
      // than credited in full to each. Crediting it whole is what made the
      // genre chart this panel replaced total 2.11x the library's real hours;
      // splitting is what keeps this column summing to exactly the playtime it
      // claims. Titles are still counted in full on every platform they are on,
      // because a title owned on three platforms really is owned on three —
      // that count is ownership, not a share of one.
      const share = ids.length ? hours / ids.length : 0;
      for (const id of ids) {
        const known = platforms.find((p) => p.id === id);
        const row = bump(id, known ? known.label : id);
        row.titles += 1;
        row.hours += share;
      }
    }
    const rows = [...totals.values()].sort(
      (a, b) => b.titles - a.titles || a.label.localeCompare(b.label)
    );
    // Rounding that adds up. Rounding each row on its own put this column at
    // 188 hours against a library total of 187 — splitting leaves fractions
    // everywhere, and three independent roundings gained an hour the library
    // does not have. Largest-remainder instead: floor every row, then hand the
    // leftover hours to whichever rows lost the most. The column now sums to
    // exactly the owned playtime subtotal, which the note underneath prints
    // alongside the not-owned one so the two still reconcile with Total
    // Playtime on the strip above.
    const rounded = rows.map((r) => {
      const whole = Math.floor(r.hours);
      return { ...r, displayHours: whole, remainder: r.hours - whole };
    });
    let budget = Math.round(ownedHours) - rounded.reduce((s, r) => s + r.displayHours, 0);
    for (const r of [...rounded].sort((a, b) => b.remainder - a.remainder)) {
      if (budget <= 0) break;
      r.displayHours += 1;
      budget -= 1;
    }
    return {
      rows: rounded,
      associations,
      multiPlatform,
      unplatformed,
      ownedTitles,
      ownedHours,
      notOwnedTitles,
      notOwnedHours,
      maxTitles: Math.max(1, ...rows.map((r) => r.titles)),
    };
  }, [games, platforms]);

  // ── Rating distribution ───────────────────────────────────────────
  // 1-10, the scale every other surface in the app prints as `/10`.
  //
  // Every title lands in exactly one of two places — a rating bucket or
  // unrated — so the figures here always add up to the library. That matters
  // more than usual here: with a large unrated majority, a distribution drawn
  // from rated titles alone reads as a verdict on the whole collection when it
  // is a verdict on a fraction of it.
  const ratings = React.useMemo(() => {
    let rated = 0;
    let sum = 0;
    for (const g of games) {
      const raw = g.personal_rating;
      // 0 and null both mean "not rated" — the pickers only offer 1-10, and the
      // store stores an unrated title as 0.
      if (raw == null || raw <= 0) continue;
      rated += 1;
      sum += raw;
    }
    return {
      rated,
      // Null rather than zero when nothing is rated: an average of 0/10 would
      // be a claim about taste rather than an absence of data. The strip prints
      // an em dash in that case.
      average: rated > 0 ? sum / rated : null,
    };
  }, [games]);

  // ── Completions, last six calendar months ─────────────────────────
  // Month placement comes only from `date_completed`. Playtime is never read:
  // there is no way to derive a finish date from hours, and pretending
  // otherwise would be inventing history. A title marked completed with no date
  // therefore cannot appear here at all, and the figure below can total less
  // than the `completedGames` count on the strip above — the gap is exactly the
  // titles missing a date.
  const completedMonths = React.useMemo<CompletedMonth[]>(() => {
    const now = new Date();
    // Six buckets ending with the current month, built first and at zero so a
    // month with no completions is still on the axis. `new Date(y, m - back, 1)`
    // rolls the year over on its own, so January walks back into December.
    const buckets: CompletedMonth[] = [];
    for (let back = COMPLETED_MONTH_SPAN - 1; back >= 0; back--) {
      const first = new Date(now.getFullYear(), now.getMonth() - back, 1);
      buckets.push({
        label: monthAbbr(first.getMonth()),
        full: `${monthAbbr(first.getMonth())} ${first.getFullYear()}`,
        key: `${first.getFullYear()}-${first.getMonth()}`,
        count: 0,
      });
    }
    const index = new Map(buckets.map((b, i) => [b.key, i]));
    for (const g of games) {
      // A completion needs both halves. The status says it finished; the date
      // says when. Either alone is not enough:
      //   - no date — nothing to file it under, and inferring one from
      //     `date_added` or playtime would be a guess about when it ended;
      //   - dated but not `completed` — a stale date left behind when a title
      //     was moved back to backlog or playing. The server stamps
      //     `date_completed` on entry to completed but never clears it on the
      //     way out, so these rows are real and counting them would report a
      //     completion the rest of the library does not claim.
      if (g.status !== "completed" || !g.date_completed) continue;
      // Read in local time, matching `formatDateShort` everywhere else in the
      // app — a UTC month boundary would file a late-evening completion in
      // the wrong month for most of the world.
      const d = new Date(g.date_completed);
      const i = index.get(`${d.getFullYear()}-${d.getMonth()}`);
      // Outside the window: too old to appear, or dated in the future. Either
      // way it belongs to no bucket and is dropped rather than clamped in.
      const bucket = i === undefined ? undefined : buckets[i];
      if (bucket) bucket.count += 1;
    }
    return buckets;
  }, [games]);

  const completedTotal = completedMonths.reduce((sum, m) => sum + m.count, 0);

  return (
    <div className="space-y-10">
      {/* Page header — the same title / subtext / hairline treatment as every
          other view, and the only <h1> on the page now that analytics has its
          own route out of the dashboard. */}
      <div className="relative pb-8">
        {/* Text stays title case in the DOM and is uppercased by the class, so
            the rendered result matches the other views' titles pixel for pixel
            while the accessible name is still read as "System Analytics"
            rather than shouted in caps. The <br /> would otherwise splice a
            line break into that name, so it is set explicitly — the visible
            text is the same words, so label-in-name still holds. */}
        <h1
          aria-label="System Analytics"
          className="text-6xl sm:text-8xl lg:text-[110px] font-black tracking-tighter leading-[0.85] uppercase text-white font-sans select-none"
        >
          System<br />Analytics
        </h1>
        <p className="mt-3 max-w-xl text-brand-muted text-sm sm:text-base font-medium leading-relaxed">
          Personal gameplay telemetry &amp; system analytics
        </p>
        {/* Full-bleed header rule: cancels the page gutter so it spans the
            screen, matching the other views. Same technique as the footer rule. */}
        <div aria-hidden="true" className="absolute bottom-0 -left-6 -right-6 md:-left-12 md:-right-12 h-px bg-brand-border/60" />
      </div>

      {/* Telemetry readout — one instrument, not four cards.
          The dashboard's strip directly above this is five separately-bordered
          boxes with air between them. This is a single band divided by
          hairlines: `gap-px` over a border-coloured ground with opaque cells
          paints the rules at any column count, so there are never double
          borders to misalign and never a stray cell outline to mistake for the
          other section. `auto-rows-fr` keeps the rows equal height at the
          two-column sizes, where the tallest cell would otherwise stretch its
          row and knock the meta lines out of line. Every label
          reserves two lines (`min-h-[2lh]`) so the four figures share one
          baseline however their labels wrap — at the narrowest four-column width
          a two-word label still folds on the tracked caps, and without the
          reservation its figure drops a line below its neighbours. The labels
          are held to two words so none of them can outrun its cell. Same
          language as the app — square corners, 1px brand-border, tracked caps,
          black Inter figures, accent reserved for the one figure that is a
          ratio.

          The figures run at 56px / 88px, with the cell padding and the label
          size set to match. 88px is the same step the dashboard's registry band
          uses, which is what this readout is matched to — a named scale step
          would have put it at 72 or 96 and split the two bands apart again, so
          the sizes are given explicitly instead. All four are the same size:
          the row is read as one set of comparable numbers, and a percentage set
          a step down reads as a different kind of quantity rather than a
          different value. Its `%` is the widest figure in the row, so the
          context line beside it is the one that yields — `6 / 37` is
          `shrink-0` and the figure takes the room.

          One figure per question, so the strip answers four different things:
          how big the library is, how much of it has actually been played, what
          the owner thinks of it, and how much is finished. The two it replaced
          were both about hours, which made them half-sayings of one fact. */}
      {/* The column count is set by a container query, not a viewport
          breakpoint. This band is the widest thing on the page and its content
          is fixed-size — 88px figures and a `6 / 37` line — so what decides
          whether four columns fit is the band's own width, not the window's.
          A viewport `lg` got this wrong in both directions: four columns were
          laid out from 1024px, which is narrower than four cells of this
          content need, and the "6 / 37" was pushed out past the padding.

          1136px is that measurement, not a guess. Completion Rate is the binding
          cell: "16%" at the full 88px figure is 178px, and with the gap and the
          "6 / 37" line it wants 224px of content room — 280px of cell, ×4 plus
          the three 1px rules and the band's own 1px border. Below the threshold
          the band drops to 2×2, where every cell is twice as wide and nothing
          can overflow. The query sits on a wrapper because a container queries
          its ancestors, not itself. */}
      <div className="@container">
        <div className="grid grid-cols-2 @min-[1136px]:grid-cols-4 auto-rows-fr gap-px bg-brand-border border border-brand-border">
        <div className="bg-brand-bg p-5 sm:p-7">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted min-h-[2lh]">Registry Titles</p>
          <h3 className="text-[3.5rem] sm:text-[5.5rem] font-black text-white font-sans tracking-tighter leading-none mt-4">{totalGames}</h3>
        </div>

        {/* Engagement as breadth, not volume. Counted on the same
            hide-playtime-aware rule as the hour figures, so this cannot
            disagree with the "N of M played" line under Most Played. The "of"
            is the point: the gap between the two figures is the untouched
            library, which is the thing this metric exists to expose. */}
        <div className="bg-brand-bg p-5 sm:p-7">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted min-h-[2lh]">Played Titles</p>
          <div className="flex items-baseline justify-between gap-3 mt-4">
            <h3 className="text-[3.5rem] sm:text-[5.5rem] font-black text-white font-sans tracking-tighter leading-none">{playtime.playedCount}</h3>
            <span className="text-xs sm:text-sm text-brand-muted uppercase shrink-0">
              <span className="text-white font-bold">{totalGames}</span> total
            </span>
          </div>
        </div>

        {/* Taste, over rated titles only — the denominator is the titles that
            actually carry a rating, not the library. An em dash rather than 0.0
            when nothing is rated: a zero would be a claim about taste, not an
            absence of it. */}
        <div className="bg-brand-bg p-5 sm:p-7">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted min-h-[2lh]">Avg Rating</p>
          <div className="flex items-baseline gap-2 mt-4">
            <h3 className="text-[3.5rem] sm:text-[5.5rem] font-black text-white font-sans tracking-tighter leading-none">
              {ratings.average === null ? "—" : ratings.average.toFixed(1)}
            </h3>
            <span className="text-sm sm:text-base font-black uppercase text-brand-muted">/10</span>
          </div>
        </div>

        {/* The accent is the one thing that separates this figure from the
            other three, so it needs no bar to say so. The bar was also the only
            cell carrying a second row, which made this the one cell whose
            content did not line up with its neighbours.

            Same figure size as the rest of the row, so the four read as one set
            of comparable numbers rather than three measurements and a
            statistic. */}
        <div className="bg-brand-bg p-5 sm:p-7">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted min-h-[2lh]">Completion Rate</p>
          <div className="flex items-baseline justify-between gap-2 mt-4">
            {/* Full-size %: it is part of the figure, not a unit hung off it, and
                at 0.4em it read as a diminutive of a number rather than the
                number itself. The cost is that "16%" is now the widest figure
                in the row and the cell has to be wider — which is what the
                container query on the band below is for. */}
            <h3 className="text-[3.5rem] sm:text-[5.5rem] font-black text-brand-accent font-sans tracking-tighter leading-none">{completionRate}%</h3>
            <span className="text-xs sm:text-sm text-brand-muted uppercase shrink-0">
              <span className="text-white font-bold">{completedGames}</span> / {totalGames}
            </span>
          </div>
        </div>
        </div>
      </div>

      {/* Row 1: the completions chart, alone across the full width. It is the
          only plotted series on the page and the only one with a time axis, so
          it reads as the trend it is rather than as a panel competing for
          attention with a table of counts beside it. */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">

        {/* Completions, last six calendar months. Counted purely from recorded
            `date_completed` values — see the note on `completedMonths` for why
            status and playtime are both excluded. The Y axis is left to scale
            itself from zero, but `allowDecimals` is off so a count of 3 can
            never render as 2.5. */}
        <div className="xl:col-span-5 border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center justify-between gap-3 border-b border-brand-border pb-4">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">Games Completed — Last 6 Months</h3>
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
              N = {completedTotal} Completed
            </span>
          </div>
          <div
            className="h-76 w-full pt-4"
            role="img"
            aria-label={`Games completed per month for the last ${COMPLETED_MONTH_SPAN} calendar months, ending ${completedMonths[completedMonths.length - 1]?.full}. ${completedMonths
              .map((m) => `${m.full}: ${m.count}`)
              .join(", ")}.`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={completedMonths} margin={{ top: 14, right: 14, left: -4, bottom: 0 }}>
                <defs>
                  {/* Vertical fade: luminous at the line, dissolving into the
                      background. Same idiom as the area chart this slot has
                      carried before, so the panel keeps one visual voice. */}
                  <linearGradient id="completedAreaFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--brand-accent)" stopOpacity={0.28} />
                    <stop offset="70%" stopColor="var(--brand-accent)" stopOpacity={0.05} />
                    <stop offset="100%" stopColor="var(--brand-accent)" stopOpacity={0} />
                  </linearGradient>
                  {/* Soft bloom behind the line */}
                  <filter id="completedGlow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="var(--brand-accent)" floodOpacity="0.35" />
                  </filter>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--brand-border)" strokeOpacity={0.35} strokeDasharray="3 6" />
                <XAxis
                  dataKey="label"
                  stroke="var(--zinc-600-val)"
                  tickLine={false}
                  axisLine={{ stroke: "var(--brand-border)", strokeOpacity: 0.5 }}
                  tickMargin={10}
                  tick={{ fill: "var(--brand-muted)", fontSize: 9, fontFamily: "var(--font-sans)", letterSpacing: "0.08em" }}
                />
                <YAxis
                  allowDecimals={false}
                  stroke="var(--zinc-600-val)"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={6}
                  tick={{ fill: "var(--brand-muted)", fontSize: 9, fontFamily: "var(--font-sans)" }}
                />
                <Tooltip
                  content={<MonthTooltip />}
                  cursor={{ stroke: "var(--brand-accent)", strokeOpacity: 0.35, strokeWidth: 1 }}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  name="COMPLETED"
                  stroke="var(--brand-accent)"
                  strokeWidth={2.5}
                  fill="url(#completedAreaFill)"
                  filter="url(#completedGlow)"
                  /* A dot per month, so the six discrete counts stay readable
                     against the curve the fill is drawn between. */
                  dot={{ fill: "var(--brand-bg)", stroke: "var(--brand-accent)", strokeWidth: 2, r: 3.5 }}
                  activeDot={{ fill: "var(--brand-accent)", stroke: "var(--brand-bg)", strokeWidth: 2, r: 5.5 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Row 2: Status and Platform, unevenly. Both answer a question about the
          same collection, so they belong side by side; the three-track split
          keeps them from reading as a matched pair of equal-weight tables, and
          gives the denser status panel the room it needs. `items-start` lets the
          platform panel hug its content — a library with many platform tags
          grows taller than its neighbour rather than being flattened to match,
          which is what makes the row read as a bento instead of two equal
          boxes. */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6 items-start">
        {/* Status Distribution — the library read two ways: what state each
            title is in, and whether it has ever been launched. The second
            question is the one the status split cannot answer on its own. */}
        <div className="xl:col-span-3 border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center justify-between gap-3 border-b border-brand-border pb-4">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">Status Distribution</h3>
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
              N = {totalGames} Titles
            </span>
          </div>
          <div className="h-76 w-full pt-4">
            {composition.rows.length === 0 ? (
              <div className="w-full h-full flex items-center justify-center border border-brand-border/30 bg-zinc-950/20 text-xs uppercase text-brand-muted">
                No titles registered yet
              </div>
            ) : (
              <div className="flex flex-col h-full">
                {/* The whole library as one object. Four separate bars say how
                    big each status is; they cannot say how the statuses sit
                    against each other, which is the actual question. No gaps
                    between segments, so it reads as one bar rather than four.

                    `shrink-0` is load-bearing. This sits in a column flex
                    container alongside a `flex-1` block, so without it the bar
                    is a shrinkable item with no intrinsic content and the
                    column quietly collapsed it to zero height — the bar was
                    present in the DOM and invisible on screen. */}
                <div className="flex h-2.5 w-full shrink-0 border border-brand-border/50 overflow-hidden">
                  {composition.rows.map((s) => (
                    <div
                      key={s.key}
                      className="h-full shrink-0 transition-all hover:brightness-125"
                      style={{ width: `${s.pct}%`, backgroundColor: s.color }}
                      title={`${s.label}: ${s.count} titles (${s.pct}%)`}
                    />
                  ))}
                </div>

                <div className="flex-1 min-h-0 flex flex-col justify-center space-y-3.5 pt-6 pb-3">
                  {composition.rows.map((s) => (
                    <div key={s.key} className="group/row space-y-1.5">
                      <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-widest">
                        <span className="text-zinc-300 font-black transition-colors group-hover/row:text-white">{s.label}</span>
                        <span className="text-brand-muted">{s.count} TITLES · {s.pct}%</span>
                      </div>
                      <div className="h-2 bg-zinc-900 border border-brand-border/50">
                        <div
                          className="h-full transition-all group-hover/row:brightness-125"
                          style={{ width: `${s.pct}%`, backgroundColor: s.color }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                {/* Launch state — orthogonal to status, and the one figure here
                    that appears nowhere else on the page. `hide_playtime` is not
                    consulted: the question is whether hours exist, not what they
                    are, so no hidden title's hours are implied by appearing
                    here.

                    One bar, not two rows with bars. A binary split is fully
                    described by a single bar with its two ends named, and
                    drawing the same two percentages a second time in shorter
                    bars was saying nothing new. The full-strength rule above
                    separates this from the status read: it is a different
                    question, not a fifth status. */}
                <div className="shrink-0 border-t border-brand-border pt-4 mt-1 space-y-2.5">
                  <div className="flex items-baseline justify-between gap-3 text-[11px] uppercase tracking-widest">
                    <span className="text-zinc-300 font-black">
                      Never Launched{" "}
                      <span className="text-brand-muted">{composition.neverLaunchedPct}%</span>
                    </span>
                    <span className="text-zinc-300 font-black">
                      Launched{" "}
                      <span className="text-brand-muted">{100 - composition.neverLaunchedPct}%</span>
                    </span>
                  </div>
                  <div className="flex h-2.5 w-full shrink-0 border border-brand-border/50 overflow-hidden">
                    <div
                      className="h-full shrink-0 transition-all hover:brightness-125"
                      style={{ width: `${composition.neverLaunchedPct}%`, backgroundColor: "var(--zinc-500-val)" }}
                      title={`Never launched: ${composition.neverLaunched} titles (${composition.neverLaunchedPct}%)`}
                    />
                    <div
                      className="h-full shrink-0 transition-all hover:brightness-125"
                      style={{ width: `${100 - composition.neverLaunchedPct}%`, backgroundColor: "var(--brand-accent)" }}
                      title={`Launched: ${composition.launched} titles (${100 - composition.neverLaunchedPct}%)`}
                    />
                  </div>
                  {/* Reconciles the two readings, so the panel explains itself:
                      backlog is not one thing. */}
                  {composition.shelved > 0 && (
                    <p className="text-[9px] uppercase tracking-wider text-brand-muted leading-relaxed">
                      // {composition.backlogUnlaunched} backlog unlaunched ·{" "}
                      <span className="text-brand-accent">{composition.shelved} shelved</span> with hours logged
                    </p>
                  )}
                </div>

                {/* Ownership — the other orthogonal axis, drawn exactly like the
                    launch state above for the same reason: a binary split needs
                    one bar with two named ends, not two rows of bars saying the
                    same thing twice. Only rendered when there is something to
                    distinguish — on an all-owned library it would be a bar that is
                    100% one colour, which is the absence of news presented as a
                    figure. */}
                {ownership.notOwned > 0 && (
                  <div className="shrink-0 border-t border-brand-border pt-4 mt-1 space-y-2.5">
                    <div className="flex items-baseline justify-between gap-3 text-[11px] uppercase tracking-widest">
                      <span className="text-zinc-300 font-black">
                        Owned <span className="text-brand-muted">{ownership.ownedPct}%</span>
                      </span>
                      <span className="text-zinc-300 font-black">
                        Not Owned <span className="text-brand-muted">{100 - ownership.ownedPct}%</span>
                      </span>
                    </div>
                    <div className="flex h-2.5 w-full shrink-0 border border-brand-border/50 overflow-hidden">
                      <div
                        className="h-full shrink-0 transition-all hover:brightness-125"
                        style={{ width: `${ownership.ownedPct}%`, backgroundColor: "var(--brand-accent)" }}
                        title={`Owned: ${ownership.owned} titles (${ownership.ownedPct}%)`}
                      />
                      <div
                        className="h-full shrink-0 transition-all hover:brightness-125"
                        style={{ width: `${100 - ownership.ownedPct}%`, backgroundColor: "var(--zinc-500-val)" }}
                        title={`Not owned: ${ownership.notOwned} titles (${100 - ownership.ownedPct}%)`}
                      />
                    </div>
                    {/* Names what the second segment is, because "Not Owned" in a
                        status panel otherwise reads as a fifth status. These
                        titles are played and tracked in full — they just are not
                        a copy the user holds. */}
                    <p className="text-[9px] uppercase tracking-wider text-brand-muted leading-relaxed">
                      // {ownership.notOwned} played without a copy ·{" "}
                      <span className="text-zinc-300">{Math.round(ownership.notOwnedHours)} of {Math.round(totalPlaytime)} hrs</span> spent outside the collection
                    </p>
                  </div>
                )}

                {/* Replays — how often the library has been played more than
                    once, and how much of the total those extra runs account for.

                    Not drawn as a split bar like the two axes above, because it
                    has no clean binary: the meaningful figure is a ratio of runs to
                    titles (1.2x on a library this size), not a percentage of two
                    categories that partition the library. A bar would have to
                    pretend games and runs are the same unit.

                    The figures reconcile with the totals above by construction —
                    `times_played - total_games` is exactly the extra-run count, and
                    replay hours plus first-run hours is the all-in total — so the
                    rows state both rather than leaving the reader to trust it. */}
                {replays.replayedGames > 0 && summary && (
                  <div className="shrink-0 border-t border-brand-border pt-4 mt-1 space-y-2.5">
                    <div className="flex items-baseline justify-between gap-3 text-[11px] uppercase tracking-widest">
                      <span className="text-zinc-300 font-black">
                        Replayed{" "}
                        <span className="text-brand-accent">
                          {replays.replayedGames} of {summary.total_games}
                        </span>
                      </span>
                      <span className="text-zinc-300 font-black">
                        <span className="text-brand-accent">{replays.timesPlayed}</span> total runs
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3 text-[10px] uppercase tracking-wider text-brand-muted">
                      <span>Extra runs past the first</span>
                      <span className="text-zinc-300">{replays.extraRuns}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3 text-[10px] uppercase tracking-wider text-brand-muted">
                      <span>Hours on replays</span>
                      <span className="text-zinc-300">
                        {Math.round(replays.replayHours)} of {Math.round(replays.allHours)} hrs
                      </span>
                    </div>
                    {mostReplayed && (
                      <p className="text-[9px] uppercase tracking-wider text-brand-muted leading-relaxed">
                        // most replayed is{" "}
                        <span className="text-zinc-300">{mostReplayed.title}</span> at{" "}
                        <span className="text-brand-accent">{mostReplayed.times_played}&times;</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Platform Distribution — ownership against usage. The title count says
            what is on the shelf; the hours say what actually gets played, and on
            this library the two disagree. Titles the user has played without
            owning a copy are excluded from the bars — they carry no platform
            tags at all — and reported on their own line beneath them. */}
        <div className="xl:col-span-2 border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center justify-between gap-3 border-b border-brand-border pb-4">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">Platform Distribution</h3>
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
              N = {platformRows.rows.length} Platforms
            </span>
          </div>

          {platformRows.rows.length === 0 && platformRows.notOwnedTitles === 0 ? (
            <div className="w-full h-48 flex items-center justify-center border border-brand-border/30 bg-zinc-950/20 text-xs uppercase text-brand-muted">
              No platform tags recorded
            </div>
          ) : (
            <div className="pt-2 space-y-3.5">
              {platformRows.rows.map((p) => (
                <div key={p.id} className="group/row space-y-1.5">
                  <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-widest">
                    <span className="text-zinc-300 font-black truncate min-w-0 transition-colors group-hover/row:text-white">{p.label}</span>
                    <span className="text-brand-muted shrink-0">
                      {p.titles} TITLES · {p.displayHours} HRS
                    </span>
                  </div>
                  <div className="h-2 bg-zinc-900 border border-brand-border/50">
                    <div
                      className="h-full transition-all group-hover/row:brightness-125"
                      style={{
                        width: `${(p.titles / platformRows.maxTitles) * 100}%`,
                        backgroundColor: "var(--brand-accent)",
                      }}
                    />
                  </div>
                </div>
              ))}

              {/* Played-but-not-owned, kept below the platform bars as a
                  separate line rather than merged into them. A not-owned title
                  has no platform tags, so it has no bar to join — but it is
                  still part of the registry and still spent hours, and dropping
                  it silently would make this panel understate the library.
                  Dashed rule and a grey fill mark it as outside the
                  collection. */}
              {platformRows.notOwnedTitles > 0 && (
                <div className="group/row space-y-1.5 pt-1">
                  <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-widest">
                    <span className="text-zinc-400 font-black truncate min-w-0">Not Owned</span>
                    <span className="text-brand-muted shrink-0">
                      {platformRows.notOwnedTitles} TITLES · {Math.round(platformRows.notOwnedHours)} HRS
                    </span>
                  </div>
                  <div className="h-2 bg-zinc-900 border border-dashed border-brand-border/70">
                    <div
                      className="h-full transition-all group-hover/row:brightness-125"
                      style={{
                        width: `${Math.min(100, (platformRows.notOwnedTitles / platformRows.maxTitles) * 100)}%`,
                        backgroundColor: "var(--zinc-500-val)",
                      }}
                    />
                  </div>
                </div>
              )}

              {/* The reconciliation, because the figures above deliberately do
                  not add up to the library and should not pretend otherwise.
                  39 titles across 37 games is not an error — it is two titles
                  owned on more than one platform. And the hours are stated as
                  two subtotals that add back up to the strip's Total Playtime,
                  so the not-owned set is visible without being folded into the
                  shelf. */}
              <p className="pt-1 text-[9px] uppercase tracking-wider text-brand-muted leading-relaxed">
                // {platformRows.associations} titles across {platformRows.ownedTitles} owned games
                {platformRows.multiPlatform > 0 && (
                  <> · {platformRows.multiPlatform} on more than one platform</>
                )}
                {platformRows.unplatformed > 0 && (
                  <> · {platformRows.unplatformed} with no platform</>
                )}
                <> · playtime split across each title&apos;s platforms, summing to{" "}
                {Math.round(platformRows.ownedHours)} hrs
                {platformRows.notOwnedTitles > 0 && (
                  <>
                    {" "}+ {Math.round(platformRows.notOwnedHours)} hrs not owned ={" "}
                    {Math.round(totalPlaytime)} hrs
                  </>
                )}</>
              </p>
            </div>
          )}
        </div>

      </div>

      {/* Row 2: Most Played and Completed Titles, as two equal halves. The row
          uses its own two-column grid rather than the five-column one above:
          with five tracks the pair can only split 2/5 and 3/5, and these two
          answer the same question — what you have spent time on — so they read
          as equals rather than as a panel and a satellite. Grid stretch then
          gives them a shared height as well as a shared width. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

        {/* Most Played Titles */}
        <div className="border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center gap-2 border-b border-brand-border pb-4">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">Most Played Titles</h3>
          </div>
          <div className="h-72 w-full pt-4">
            {mostPlayed.length === 0 ? (
              <div className="w-full h-full flex items-center justify-center border border-brand-border/30 bg-zinc-950/20 text-xs uppercase text-brand-muted">
                No playtime tracked yet
              </div>
            ) : (
              <div className="flex flex-col justify-center h-full">
                <div className="space-y-3.5">
                  {mostPlayed.map((g, i) => (
                    <div key={g.id} className="group/row space-y-1">
                      <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-widest">
                        <span className="text-zinc-300 font-black truncate min-w-0 transition-colors group-hover/row:text-white">
                          <span className="text-brand-muted mr-2">{String(i + 1).padStart(2, "0")}</span>
                          {g.title}
                        </span>
                        {/* Hours stay the figure the row is ranked and read by;
                            the grade rides beside it, muted, as context rather
                            than a second ranking. An em dash, not a zero, for
                            unrated — the same mark the details modal uses. */}
                        <span className="shrink-0 flex items-baseline gap-2.5">
                          <span className="text-brand-muted">
                            {g.personal_rating != null ? `${g.personal_rating}/10` : "—"}
                          </span>
                          <span className="text-brand-accent font-black">
                            {formatPlaytimePrecise(g.playtime)}
                          </span>
                        </span>
                      </div>
                      {/* Same bar as every other row on the page: a solid accent
                          fill in the 8px bordered track. This one was 6px tall
                          and drawn at 80% opacity, so it read as a lighter,
                          thinner mark than the status, platform and launch bars
                          directly above and below it. */}
                      <div className="h-2 bg-zinc-900 border border-brand-border/50">
                        <div
                          className="h-full transition-all group-hover/row:brightness-125"
                          style={{
                            width: `${((g.playtime || 0) / playtime.maxHours) * 100}%`,
                            backgroundColor: "var(--brand-accent)",
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                {/* What a ranked list cannot show about itself: whether the hours
                    are spread across the library or piled into a few titles.
                    A top-six list looks the same either way. */}
                {playtime.listedPct !== null && (
                  <p className="pt-4 text-[9px] uppercase tracking-wider text-brand-muted leading-relaxed">
                    // Top {MOST_PLAYED_COUNT} of {playtime.playedCount} played hold{" "}
                    <span className="text-brand-accent">{playtime.listedPct}%</span> of{" "}
                    {Math.round(totalPlaytime)} hrs
                    {playtime.halfAt !== null && (
                      <> · half your hours sit in {playtime.halfAt} titles</>
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Completed Titles — the registry it started as: which titles are
            finished, most recent first. */}
        <div className="border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center gap-2 border-b border-brand-border pb-4">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">Completed Titles</h3>
          </div>

          {/* Completed titles roster */}
          <div className="pt-2">
            <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-widest border-b border-brand-border pb-4">
              <span className="text-brand-accent font-bold">COMPLETED REGISTRY</span>
              <span className="text-brand-accent font-black">{completedGames} TITLE{completedGames === 1 ? "" : "S"}</span>
            </div>
            {completedList.length === 0 ? (
              <div className="w-full h-48 flex items-center justify-center border border-brand-border/30 bg-zinc-950/20 text-xs uppercase text-brand-muted">
                No titles marked as completed
              </div>
            ) : (
              <ul className="mt-3 space-y-2">
                {completedList.map((g) => (
                  <li key={g.id} className="group/row flex items-center justify-between gap-3 text-[11px] uppercase tracking-widest py-1 border-b border-brand-border/20">
                    <span className="text-zinc-300 font-bold truncate transition-colors group-hover/row:text-white">{g.title}</span>
                    {/* Day first. `month: "short", year: "2-digit"` rendered
                        every row as "SEP 26", "JUL 26", "JUN 26" — all ending
                        in 26, which reads as the 26th of the month rather than
                        the year. Leading with the day makes it unambiguous. */}
                    <span className="text-brand-muted shrink-0">{g.date_completed ? formatDateShort(g.date_completed) : "NO DATE"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

      </div>

    </div>
  );
});

export default AnalyticsView;
