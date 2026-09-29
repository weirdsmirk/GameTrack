import React, { useEffect } from "react";
import { useGameTrackStore } from "../store";
import { 
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid
} from "recharts";
import { STATUSES, mergeCustomPlatforms, platformIdMatches } from "../constants";
import { formatPlaytimePrecise } from "../utils/time";

/** How many calendar months the chart covers, current month included. */
const COMPLETED_MONTH_SPAN = 6;

/** How many titles the Most Played list ranks. Six fills the panel at its
    current height without the rows crowding each other. */
const MOST_PLAYED_COUNT = 6;

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
    games, summary, lastAnalyticsFetch, fetchAnalytics, customPlatforms
  } = useGameTrackStore();

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
    for (const g of games) {
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
      // splitting is what keeps this column summing to exactly the Total
      // Playtime figure on the strip above. Titles are still counted in full on
      // every platform they are on, because a title owned on three platforms
      // really is owned on three — that count is ownership, not a share of one.
      const share = ids.length
        ? (g.hide_playtime === 1 ? 0 : g.playtime || 0) / ids.length
        : 0;
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
    // exactly the Total Playtime figure on the strip above it.
    const rounded = rows.map((r) => {
      const whole = Math.floor(r.hours);
      return { ...r, displayHours: whole, remainder: r.hours - whole };
    });
    let budget = Math.round(totalPlaytime) - rounded.reduce((s, r) => s + r.displayHours, 0);
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
      maxTitles: Math.max(1, ...rows.map((r) => r.titles)),
    };
  }, [games, platforms, totalPlaytime]);

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
          are held to two words so none of them can outrun its cell. Same
          language as the app — square corners, 1px brand-border, tracked caps,
          black Inter figures, accent reserved for the one figure that is a
          ratio.

          One figure per question, so the strip answers four different things:
          how big the library is, how much of it has actually been played, what
          the owner thinks of it, and how much is finished. The two it replaced
          were both about hours, which made them half-sayings of one fact. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 auto-rows-fr gap-px bg-brand-border border border-brand-border">
        <div className="bg-brand-bg p-5 sm:p-6">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted min-h-[2lh]">Registry Titles</p>
          <h3 className="text-5xl sm:text-7xl font-black text-white font-sans tracking-tighter leading-none mt-4">{totalGames}</h3>
        </div>

        {/* Engagement as breadth, not volume. Counted on the same
            hide-playtime-aware rule as the hour figures, so this cannot
            disagree with the "N of M played" line under Most Played. The "of"
            is the point: the gap between the two figures is the untouched
            library, which is the thing this metric exists to expose. */}
        <div className="bg-brand-bg p-5 sm:p-6">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted min-h-[2lh]">Played Titles</p>
          <div className="flex items-baseline justify-between gap-3 mt-4">
            <h3 className="text-5xl sm:text-7xl font-black text-white font-sans tracking-tighter leading-none">{playtime.playedCount}</h3>
            <span className="text-xs sm:text-sm text-brand-muted uppercase shrink-0">
              <span className="text-white font-bold">{totalGames}</span> total
            </span>
          </div>
        </div>

        {/* Taste, over rated titles only. Read from the same memo as the Rating
            Distribution below, so the figure here and the histogram there can
            never average different sets. An em dash rather than 0.0 when nothing
            is rated: a zero would be a claim about taste, not an absence of it. */}
        <div className="bg-brand-bg p-5 sm:p-6">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted min-h-[2lh]">Avg Rating</p>
          <div className="flex items-baseline gap-2 mt-4">
            <h3 className="text-5xl sm:text-7xl font-black text-white font-sans tracking-tighter leading-none">
              {ratings.average === null ? "—" : ratings.average.toFixed(1)}
            </h3>
            <span className="text-sm sm:text-base font-black uppercase text-brand-muted">/10</span>
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
                        <span className="text-brand-muted transition-colors group-hover/row:text-brand-accent">{s.count} TITLES · {s.pct}%</span>
                      </div>
                      <div className="h-2 bg-zinc-900 border border-brand-border/50 transition-colors group-hover/row:border-brand-accent/40">
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
              </div>
            )}
          </div>
        </div>

        {/* Platform Distribution — ownership against usage. The title count says
            what is on the shelf; the hours say what actually gets played, and on
            this library the two disagree. */}
        <div className="xl:col-span-2 border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center justify-between gap-3 border-b border-brand-border pb-4">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">Platform Distribution</h3>
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
              N = {platformRows.rows.length} Platforms
            </span>
          </div>

          {platformRows.rows.length === 0 ? (
            <div className="w-full h-48 flex items-center justify-center border border-brand-border/30 bg-zinc-950/20 text-xs uppercase text-brand-muted">
              No platform tags recorded
            </div>
          ) : (
            <div className="pt-2 space-y-3.5">
              {platformRows.rows.map((p) => (
                <div key={p.id} className="group/row space-y-1.5">
                  <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-widest">
                    <span className="text-zinc-300 font-black truncate min-w-0 transition-colors group-hover/row:text-white">{p.label}</span>
                    <span className="text-brand-muted shrink-0 transition-colors group-hover/row:text-brand-accent">
                      {p.titles} TITLES · {p.displayHours} HRS
                    </span>
                  </div>
                  <div className="h-2 bg-zinc-900 border border-brand-border/50 transition-colors group-hover/row:border-brand-accent/40">
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

              {/* The reconciliation, because the figures above deliberately do
                  not add up to the library and should not pretend otherwise.
                  39 titles across 37 games is not an error — it is two titles
                  owned on more than one platform. */}
              <p className="pt-1 text-[9px] uppercase tracking-wider text-brand-muted leading-relaxed">
                // {platformRows.associations} titles across {totalGames} games
                {platformRows.multiPlatform > 0 && (
                  <> · {platformRows.multiPlatform} on more than one platform</>
                )}
                {platformRows.unplatformed > 0 && (
                  <> · {platformRows.unplatformed} with no platform</>
                )}
                <> · playtime split across each title&apos;s platforms, summing to{" "}
                {Math.round(totalPlaytime)} hrs</>
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
                      <div className="h-2 bg-zinc-900 border border-brand-border/50 transition-colors group-hover/row:border-brand-accent/40">
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
                    <span className="text-brand-muted shrink-0 transition-colors group-hover/row:text-brand-accent">{g.date_completed ? new Date(g.date_completed).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" }).toUpperCase() : "NO DATE"}</span>
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
          <div className="flex items-center justify-between gap-3 border-b border-brand-border pb-4">
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
                  className="h-full shrink-0 transition-all hover:brightness-125"
                  style={{ width: `${ratings.ratedPct}%`, backgroundColor: "var(--brand-accent)" }}
                  title={`Rated: ${ratings.rated} titles (${ratings.ratedPct}%)`}
                />
                <div
                  className="h-full shrink-0 transition-all hover:brightness-125"
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
                  <div key={b.value} className="group/row flex flex-col min-w-0">
                    <div className="flex-1 flex flex-col justify-end gap-1">
                      <span className="text-center text-[9px] font-black text-brand-muted transition-colors group-hover/row:text-brand-accent">
                        {b.count || ""}
                      </span>
                      <div
                        className="w-full shrink-0 transition-all group-hover/row:brightness-125"
                        style={{
                          // 88 rather than 100: the count label sits above the bar
                          // inside the same box, and a full-height bar pushes it
                          // out of the panel.
                          height: `${(b.count / ratings.maxCount) * 88}%`,
                          backgroundColor: b.count ? "var(--brand-accent)" : "transparent",
                        }}
                      />
                    </div>
                    <div className="mt-1.5 text-center text-[10px] font-black uppercase tracking-wider text-brand-muted transition-colors group-hover/row:text-white">
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
