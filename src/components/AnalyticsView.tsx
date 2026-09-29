import React, { useEffect } from "react";
import { useGameTrackStore } from "../store";
import { 
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid
} from "recharts";
import { STATUSES } from "../constants";
import { formatPlaytimePrecise } from "../utils/time";

/** How many calendar months the chart covers, current month included. */
const COMPLETED_MONTH_SPAN = 6;

/** The top of the personal-rating scale — 1-10, as the app stores and prints
    it. Declared once so the histogram cannot drift from the pickers. */
const RATING_SCALE_MAX = 10;

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

/** Fixed abbreviations rather than `toLocaleDateString`, so the axis does not
    reflow if the machine's locale renders a different month name. */
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
    games, summary, lastAnalyticsFetch, fetchAnalytics
  } = useGameTrackStore();

  useEffect(() => {
    if (!summary || Date.now() - lastAnalyticsFetch > 60_000) fetchAnalytics();
  }, [fetchAnalytics, summary, lastAnalyticsFetch]);

  const totalGames = games.length;

  const totalPlaytime = React.useMemo(() => {
    return games.reduce((sum, g) => sum + (g.hide_playtime === 1 ? 0 : (g.playtime || 0)), 0);
  }, [games]);

  const avgPlaytime = totalGames > 0 ? (totalPlaytime / totalGames).toFixed(1) : "0";

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

  // The strip's completion figures are read back out of the composition rather
  // than counted again, so the two panels cannot disagree. Same arithmetic,
  // same denominator, one source.
  const completedGames = composition.rows.find((r) => r.key === "completed")?.count ?? 0;
  const completionRate = totalGames > 0 ? Math.round((completedGames / totalGames) * 100) : 0;

  // Most played titles (top 6 by tracked hours)
  const mostPlayed = React.useMemo(() => {
    return [...games]
      .filter(g => g.hide_playtime !== 1 && (g.playtime || 0) > 0)
      .sort((a, b) => (b.playtime || 0) - (a.playtime || 0))
      .slice(0, 6);
  }, [games]);
  const maxPlayedHours = Math.max(1, ...mostPlayed.map(g => g.playtime || 0));

  // Completed titles, most recently finished first (top 8)
  const completedList = React.useMemo(() => {
    return [...games]
      .filter(g => g.status === "completed")
      .sort((a, b) => (b.date_completed || 0) - (a.date_completed || 0))
      .slice(0, 8);
  }, [games]);

  // ── Rating distribution ───────────────────────────────────────────
  // 1-10, the scale every other surface in the app prints as `/10`.
  //
  // Every title lands in exactly one of two places — a rating bucket or
  // unrated — so the figures here always add up to the library. That matters
  // more than usual here: with a large unrated majority, a distribution drawn
  // from rated titles alone reads as a verdict on the whole collection when it
  // is a verdict on a fraction of it.
  const ratings = React.useMemo(() => {
    const counts = new Array<number>(RATING_SCALE_MAX + 1).fill(0);
    let rated = 0;
    let unrated = 0;
    let sum = 0;
    for (const g of games) {
      const raw = g.personal_rating;
      // The pickers only offer 1-10, so anything else is unrateable data. Rounded
      // and clamped into the scale rather than dropped, so no title can vanish
      // from the panel and leave the counts quietly short.
      const value = raw == null ? 0 : Math.min(RATING_SCALE_MAX, Math.max(1, Math.round(raw)));
      if (raw == null || raw <= 0) {
        unrated += 1;
        continue;
      }
      counts[value] = (counts[value] ?? 0) + 1;
      rated += 1;
      sum += raw;
    }
    const buckets = counts.slice(1).map((count, i) => ({ value: i + 1, count }));
    // Scaled against the tallest bucket, not the library, so the shape across
    // the scale stays legible when unrated titles outnumber rated ones 3 to 1.
    const maxCount = Math.max(1, ...buckets.map((b) => b.count));
    const ratedValues = buckets.filter((b) => b.count > 0);
    // Seeded with a zero-count bucket rather than `buckets[0]`, so the peak is
    // well-defined even when every rating is unrated.
    let peak = { value: 0, count: 0 };
    for (const b of buckets) if (b.count > peak.count) peak = b;
    const total = games.length || 1;
    return {
      buckets,
      maxCount,
      rated,
      unrated,
      ratedPct: Math.round((rated / total) * 100),
      unratedPct: 100 - Math.round((rated / total) * 100),
      // Null rather than zero when nothing is rated: an average of 0/10 would
      // be a claim about taste rather than an absence of data.
      average: rated > 0 ? sum / rated : null,
      peak,
      floor: ratedValues.length ? Math.min(...ratedValues.map((b) => b.value)) : null,
      ceiling: ratedValues.length ? Math.max(...ratedValues.map((b) => b.value)) : null,
      spread: ratedValues.filter((b) => b.value >= 9).reduce((s, b) => s + b.count, 0),
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
      // Read in local time, matching `toLocaleDateString` everywhere else in
      // the app — a UTC month boundary would file a late-evening completion in
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
          two-column sizes, where the one cell carrying a bar would otherwise
          stretch its row and knock the meta lines out of line. Every label
          reserves two lines (`min-h-[2lh]`) so the four figures share one
          baseline however their labels wrap — at the narrowest four-column width
          a two-word label still folds on the tracked caps, and without the
          reservation its figure drops a line below its neighbours. The labels
          are held to two words so none of them can outrun its cell, and they
          borrow the dashboard's vocabulary rather than inventing a second one
          for the same two figures. Same language as the app — square corners,
          1px brand-border, tracked caps, black Inter figures, accent reserved
          for the one figure that is a ratio. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 auto-rows-fr gap-px bg-brand-border border border-brand-border">
        <div className="bg-brand-bg p-5 sm:p-6">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted min-h-[2lh]">Registry Titles</p>
          <h3 className="text-5xl sm:text-7xl font-black text-white font-sans tracking-tighter leading-none mt-4">{totalGames}</h3>
        </div>

        <div className="bg-brand-bg p-5 sm:p-6">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted min-h-[2lh]">Total Playtime</p>
          <div className="flex items-baseline gap-2 mt-4">
            <h3 className="text-5xl sm:text-7xl font-black text-white font-sans tracking-tighter leading-none">{Math.round(totalPlaytime)}</h3>
            <span className="text-sm sm:text-base font-black uppercase text-brand-muted">HRS</span>
          </div>
        </div>

        <div className="bg-brand-bg p-5 sm:p-6">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted min-h-[2lh]">Avg Playtime</p>
          <div className="flex items-baseline gap-2 mt-4">
            <h3 className="text-5xl sm:text-7xl font-black text-white font-sans tracking-tighter leading-none">{avgPlaytime}</h3>
            <span className="text-sm sm:text-base font-black uppercase text-brand-muted">HRS/GAME</span>
          </div>
        </div>

        <div className="bg-brand-bg p-5 sm:p-6">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted min-h-[2lh]">Completion Rate</p>
          <div className="flex items-baseline justify-between gap-3 mt-4">
            <h3 className="text-4xl sm:text-5xl font-black text-brand-accent font-sans tracking-tighter leading-none">{completionRate}%</h3>
            <span className="text-xs sm:text-sm text-brand-muted uppercase shrink-0">
              <span className="text-white font-bold">{completedGames}</span> / {totalGames}
            </span>
          </div>
          <div className="h-1 bg-zinc-900 mt-4">
            <div className="h-full bg-brand-accent" style={{ width: `${completionRate}%` }} />
          </div>
        </div>
      </div>

      {/* Row 1: Completions (wide) + Status Distribution (narrow) */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">

        {/* Completions, last six calendar months. Counted purely from recorded
            `date_completed` values — see the note on `completedMonths` for why
            status and playtime are both excluded. The Y axis is left to scale
            itself from zero, but `allowDecimals` is off so a count of 3 can
            never render as 2.5. */}
        <div className="xl:col-span-3 border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center justify-between gap-3">
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

        {/* Status Distribution — the library read two ways: what state each
            title is in, and whether it has ever been launched. The second
            question is the one the status split cannot answer on its own. */}
        <div className="xl:col-span-2 border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center justify-between gap-3">
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
                      className="h-full shrink-0"
                      style={{ width: `${s.pct}%`, backgroundColor: s.color }}
                      title={`${s.label}: ${s.count} titles (${s.pct}%)`}
                    />
                  ))}
                </div>

                <div className="flex-1 min-h-0 flex flex-col justify-center space-y-3.5 pt-6 pb-3">
                  {composition.rows.map((s) => (
                    <div key={s.key} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-widest">
                        <span className="text-zinc-300 font-black">{s.label}</span>
                        <span className="text-brand-muted">{s.count} TITLES · {s.pct}%</span>
                      </div>
                      <div className="h-2 bg-zinc-900 border border-brand-border/50">
                        <div
                          className="h-full transition-all"
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
                      className="h-full shrink-0 transition-all"
                      style={{ width: `${composition.neverLaunchedPct}%`, backgroundColor: "var(--zinc-500-val)" }}
                      title={`Never launched: ${composition.neverLaunched} titles (${composition.neverLaunchedPct}%)`}
                    />
                    <div
                      className="h-full shrink-0 transition-all"
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
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Row 2: Most Played (narrow) + Completed Titles (wide) */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">

        {/* Most Played Titles */}
        <div className="xl:col-span-2 border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">Most Played Titles</h3>
          </div>
          <div className="h-72 w-full pt-4">
            {mostPlayed.length === 0 ? (
              <div className="w-full h-full flex items-center justify-center border border-brand-border/30 bg-zinc-950/20 text-xs uppercase text-brand-muted">
                No playtime tracked yet
              </div>
            ) : (
              <div className="flex flex-col justify-center h-full space-y-3.5">
                {mostPlayed.map((g, i) => (
                  <div key={g.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-widest">
                      <span className="text-zinc-300 font-black truncate">
                        <span className="text-brand-muted mr-2">{String(i + 1).padStart(2, "0")}</span>
                        {g.title}
                      </span>
                      <span className="text-brand-accent font-black shrink-0">{formatPlaytimePrecise(g.playtime)}</span>
                    </div>
                    <div className="h-1.5 bg-zinc-900 border border-brand-border/50">
                      <div
                        className="h-full bg-brand-accent/80"
                        style={{ width: `${((g.playtime || 0) / maxPlayedHours) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Completed Titles */}
        <div className="xl:col-span-3 border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">Completed Titles</h3>
          </div>

          {/* Completed titles roster */}
          <div className="pt-2">
            <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-widest border-b border-brand-border/40 pb-3">
              <span className="text-brand-muted font-bold">COMPLETED REGISTRY</span>
              <span className="text-brand-accent font-black">{completedGames} TITLE{completedGames === 1 ? "" : "S"}</span>
            </div>
            {completedList.length === 0 ? (
              <div className="w-full h-48 flex items-center justify-center border border-brand-border/30 bg-zinc-950/20 text-xs uppercase text-brand-muted">
                No titles marked as completed
              </div>
            ) : (
              <ul className="mt-3 space-y-2">
                {completedList.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-widest py-1 border-b border-brand-border/20">
                    <span className="text-zinc-300 font-bold truncate">{g.title}</span>
                    <span className="text-brand-muted shrink-0">{g.date_completed ? new Date(g.date_completed).toLocaleDateString(undefined, { month: "short", year: "2-digit" }).toUpperCase() : "NO DATE"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

      </div>

      {/* Rating Distribution — full width. A histogram of ten buckets needs the
          room, and it is the only panel here whose subject is the whole library
          rather than a subset of it. */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        <div className="xl:col-span-5 border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">Rating Distribution</h3>
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
              N = {ratings.rated} Rated · {ratings.unrated} Unrated
            </span>
          </div>

          {totalGames === 0 ? (
            <div className="w-full h-48 flex items-center justify-center border border-brand-border/30 bg-zinc-950/20 text-xs uppercase text-brand-muted">
              No titles registered yet
            </div>
          ) : (
            <div className="pt-2">
              {/* Coverage first, and above the histogram, because it sets the
                  denominator. The bars below are scaled to the tallest bucket,
                  which is what makes the shape readable — and that same scaling
                  is exactly what would turn the shape into a verdict on the whole
                  library if this bar were not sitting above it. */}
              <div className="flex h-2.5 w-full shrink-0 border border-brand-border/50 overflow-hidden">
                <div
                  className="h-full shrink-0 transition-all"
                  style={{ width: `${ratings.ratedPct}%`, backgroundColor: "var(--brand-accent)" }}
                  title={`Rated: ${ratings.rated} titles (${ratings.ratedPct}%)`}
                />
                <div
                  className="h-full shrink-0 transition-all"
                  style={{ width: `${ratings.unratedPct}%`, backgroundColor: "var(--zinc-500-val)" }}
                  title={`Unrated: ${ratings.unrated} titles (${ratings.unratedPct}%)`}
                />
              </div>
              <div className="mt-1.5 flex items-baseline justify-between gap-3 text-[11px] uppercase tracking-widest">
                <span className="text-zinc-300 font-black">
                  Rated <span className="text-brand-muted">{ratings.ratedPct}%</span>
                </span>
                <span className="text-zinc-300 font-black">
                  Unrated <span className="text-brand-muted">{ratings.unratedPct}%</span>
                </span>
              </div>

              {/* The histogram. Every value on the scale gets a column, including
                  the empty ones — a gap at 3 is part of the shape, and a chart
                  that dropped empty buckets would hide the very thing it is
                  measuring. */}
              <div className="mt-5 grid grid-cols-10 gap-2 h-40">
                {ratings.buckets.map((b) => (
                  <div key={b.value} className="flex flex-col min-w-0">
                    <div className="flex-1 flex flex-col justify-end gap-1">
                      <span className="text-center text-[9px] font-black text-brand-muted">
                        {b.count || ""}
                      </span>
                      <div
                        className="w-full shrink-0 transition-all"
                        style={{
                          // 88 rather than 100: the count label sits above the bar
                          // inside the same box, and a full-height bar pushes it
                          // out of the panel.
                          height: `${(b.count / ratings.maxCount) * 88}%`,
                          backgroundColor: b.count ? "var(--brand-accent)" : "transparent",
                        }}
                      />
                    </div>
                    <div className="mt-1.5 text-center text-[10px] font-black uppercase tracking-wider text-brand-muted">
                      {b.value}
                    </div>
                  </div>
                ))}
              </div>

              {/* The reading, in the app's own comment voice: what the average is
                  worth, where the ratings pile up, and — the part a count alone
                  cannot tell you — whether the bottom of the scale is ever used. */}
              <p className="mt-4 text-[9px] uppercase tracking-wider text-brand-muted leading-relaxed">
                {ratings.rated === 0 ? (
                  "// No titles rated yet"
                ) : (
                  <>
                    // Avg {ratings.average?.toFixed(1)}/10 across {ratings.rated} rated · peak{" "}
                    <span className="text-brand-accent">{ratings.peak.value}</span> · {ratings.spread} of{" "}
                    {ratings.rated} rated {ratings.spread === 1 ? "is" : "are"} 9 or higher
                    {ratings.floor !== null && ratings.floor > 1 && (
                      <> · nothing rated below {ratings.floor}</>
                    )}
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      </div>

    </div>
  );
});

export default AnalyticsView;
