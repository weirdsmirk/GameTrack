import React, { useEffect } from "react";
import { useGameTrackStore } from "../store";
import { 
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid
} from "recharts";
import { STATUSES } from "../constants";
import { formatPlaytimePrecise } from "../utils/time";

/** One rated title, reduced to the two fields the chart reasons about. */
type RatedTitle = { hours: number; rating: number };

/** One playtime bucket: where a group of titles sits on the rating scale. */
type RatingBand = {
  /** The bucket's own label, used verbatim as the axis tick. */
  label: string;
  avgRating: number;
  count: number;
  hours: number;
};

/**
 * The playtime ladder — this is the "log axis", expressed as buckets.
 *
 * The requirement was that a 3-hour game and a 300-hour game stay legible in
 * the same plot. A true log axis does that, but it has no meaning at zero, and
 * a rated-but-never-launched game is a real title in this data, not an error.
 * Bucketing gives the same even visual weight per order of magnitude with none
 * of that: every rung is the same width on screen whether it spans 0-1 hours or
 * 250-500, so the eye compares the ratings, not the distances. The ladder runs
 * to 500+ because that is the tail that otherwise squashes everything else into
 * the left margin.
 */
const PLAYTIME_BANDS: { label: string; min: number; max: number }[] = [
  { label: "0-1", min: 0, max: 1 },
  { label: "1-5", min: 1, max: 5 },
  { label: "5-10", min: 5, max: 10 },
  { label: "10-25", min: 10, max: 25 },
  { label: "25-50", min: 25, max: 50 },
  { label: "50-100", min: 50, max: 100 },
  { label: "100-250", min: 100, max: 250 },
  { label: "250-500", min: 250, max: 500 },
  { label: "500+", min: 500, max: Infinity },
];

/** The band tooltip. Carries N as well as the average, because a band holding
    one title is a far weaker claim than a band holding twelve, and an average
    that hides its sample size is how a chart misleads. */
const BandTooltip = React.memo(
  ({ active, payload }: { active?: boolean; payload?: { payload: RatingBand }[] }) => {
    const b = payload?.[0]?.payload;
    if (!active || !b) return null;
    return (
      <div className="bg-zinc-950 border border-brand-border px-3 py-2.5 text-[11px] uppercase tracking-wider shadow-xl whitespace-nowrap">
        <p className="font-black text-white">{b.label} HRS</p>
        <p className="mt-1.5 text-brand-muted">
          Avg{" "}
          <span className="font-black text-brand-accent">{b.avgRating.toFixed(1)}/5</span>
        </p>
        <p className="text-brand-muted">
          N = <span className="font-black text-white">{b.count}</span>{" "}
          {b.count === 1 ? "Title" : "Titles"}
        </p>
        <p className="text-brand-muted">
          <span className="font-black text-white">{b.hours.toFixed(1)}</span> HRS Total
        </p>
      </div>
    );
  }
);

const STATUS_BAR_COLORS: Record<string, string> = {
  backlog: "var(--zinc-600-val)",
  playing: "var(--emerald-400-val)",
  completed: "var(--brand-accent)",
  endless: "var(--fuchsia-400-val)",
};

export const AnalyticsView: React.FC = React.memo(() => {
  const { 
    games, summary, lastAnalyticsFetch, fetchAnalytics
  } = useGameTrackStore();

  useEffect(() => {
    if (!summary || Date.now() - lastAnalyticsFetch > 60_000) fetchAnalytics();
  }, [fetchAnalytics, summary, lastAnalyticsFetch]);

  const totalGames = games.length;
  const completedGames = games.filter(g => g.status === "completed").length;
  const completionRate = totalGames > 0 ? Math.round((completedGames / totalGames) * 100) : 0;
  
  const totalPlaytime = React.useMemo(() => {
    return games.reduce((sum, g) => sum + (g.hide_playtime === 1 ? 0 : (g.playtime || 0)), 0);
  }, [games]);

  const avgPlaytime = totalGames > 0 ? (totalPlaytime / totalGames).toFixed(1) : "0";

  // Status distribution across the registry
  const statusCounts = React.useMemo(() => {
    const total = games.length || 1;
    return STATUSES.map((s) => {
      const count = games.filter(g => g.status === s.value).length;
      return { status: s.value, label: s.label, count, pct: Math.round((count / total) * 100) };
    }).filter((s) => s.count > 0);
  }, [games]);

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

  // ── Playtime vs rating ────────────────────────────────────────────
  // Two filters, both about not lying to the reader:
  //   - unrated titles have no Y, so they cannot contribute to an average;
  //   - `hide_playtime` titles are excluded outright, because bucketing one
  //     would republish the exact figure the user chose to hide — the same
  //     reason the hour total and the most-played list drop them.
  // The stored rating is an integer out of 10 (every other surface in the app
  // prints `/10`), halved here to the 0-5 this chart reads in.
  const ratedTitles = React.useMemo<RatedTitle[]>(() => {
    return games
      .filter((g) => (g.personal_rating ?? 0) > 0 && g.hide_playtime !== 1)
      .map((g) => ({
        hours: g.playtime || 0,
        rating: (g.personal_rating as number) / 2,
      }));
  }, [games]);

  // Bands with nothing in them are dropped rather than plotted as zero: a flat
  // trough at 0 would read as "these playtimes were rated terribly" when it
  // actually means "nobody has played anything in this bracket". Dropping also
  // keeps the line continuous, since an empty bucket has no average to draw.
  const ratingBands = React.useMemo<RatingBand[]>(() => {
    return PLAYTIME_BANDS.reduce<RatingBand[]>((acc, band) => {
      const inBand = ratedTitles.filter((g) => g.hours >= band.min && g.hours < band.max);
      if (!inBand.length) return acc;
      const sum = (pick: (g: RatedTitle) => number) =>
        inBand.reduce((s, g) => s + pick(g), 0);
      acc.push({
        label: band.label,
        avgRating: sum((g) => g.rating) / inBand.length,
        count: inBand.length,
        hours: sum((g) => g.hours),
      });
      return acc;
    }, []);
  }, [ratedTitles]);

  // The populated span, for the chart's accessible name. Optional-chained
  // because the list can be empty, which the label has its own branch for.
  const bandSpan =
    ratingBands.length > 0
      ? `${ratingBands[0]?.label} to ${ratingBands[ratingBands.length - 1]?.label} hours`
      : "";


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

      {/* Row 1: Playtime vs Rating (wide) + Status Distribution (narrow) */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">

        {/* Playtime vs rating. Replaces the genre area chart, which was summing
            each game's hours once per genre tag it carried — a title in two
            genres counted its full playtime twice, so the plotted total came to
            more than the library's actual hours. Bucketing by playtime has no
            such arithmetic: every hour is counted once, in exactly one band. */}
        <div className="xl:col-span-3 border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">Playtime vs Rating</h3>
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
              N = {ratedTitles.length} Rated Titles
            </span>
          </div>
          <div
            className="h-72 w-full pt-4"
            role="img"
            aria-label={
              ratingBands.length === 0
                ? "Playtime versus rating: no rated titles to plot"
                : `Area chart of average personal rating by playtime band, across ${ratingBands.length} populated bands covering ${ratedTitles.length} rated titles. Bands run left to right from ${bandSpan}; personal rating out of 5 runs bottom to top.`
            }
          >
            {ratingBands.length === 0 ? (
              <div className="w-full h-full flex items-center justify-center border border-brand-border/30 bg-zinc-950/20 text-xs uppercase text-brand-muted">
                No rated titles to plot
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={ratingBands} margin={{ top: 14, right: 14, left: -4, bottom: 0 }}>
                  <defs>
                    {/* Vertical fade: luminous at the line, dissolving into the background */}
                    <linearGradient id="ratingAreaFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--brand-accent)" stopOpacity={0.28} />
                      <stop offset="70%" stopColor="var(--brand-accent)" stopOpacity={0.05} />
                      <stop offset="100%" stopColor="var(--brand-accent)" stopOpacity={0} />
                    </linearGradient>
                    {/* Soft bloom behind the line */}
                    <filter id="ratingGlow" x="-20%" y="-20%" width="140%" height="140%">
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
                    domain={[0, 5]}
                    ticks={[0, 1, 2, 3, 4, 5]}
                    allowDecimals={false}
                    stroke="var(--zinc-600-val)"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                    tick={{ fill: "var(--brand-muted)", fontSize: 9, fontFamily: "var(--font-sans)" }}
                  />
                  <Tooltip content={<BandTooltip />} cursor={{ stroke: "var(--brand-accent)", strokeOpacity: 0.35, strokeWidth: 1 }} />
                  <Area
                    type="monotone"
                    dataKey="avgRating"
                    name="AVG RATING"
                    stroke="var(--brand-accent)"
                    strokeWidth={2.5}
                    fill="url(#ratingAreaFill)"
                    filter="url(#ratingGlow)"
                    dot={{ fill: "var(--brand-bg)", stroke: "var(--brand-accent)", strokeWidth: 2, r: 3.5 }}
                    activeDot={{ fill: "var(--brand-accent)", stroke: "var(--brand-bg)", strokeWidth: 2, r: 5.5 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Status Distribution */}
        <div className="xl:col-span-2 border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">Status Distribution</h3>
          </div>
          <div className="h-72 w-full pt-4">
            {statusCounts.length === 0 ? (
              <div className="w-full h-full flex items-center justify-center border border-brand-border/30 bg-zinc-950/20 text-xs uppercase text-brand-muted">
                No titles registered yet
              </div>
            ) : (
              <div className="flex flex-col justify-center h-full space-y-4">
                {statusCounts.map((s) => (
                  <div key={s.status} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-widest">
                      <span className="text-zinc-300 font-black">{s.label}</span>
                      <span className="text-brand-muted">{s.count} TITLES · {s.pct}%</span>
                    </div>
                    <div className="h-2 bg-zinc-900 border border-brand-border/50">
                      <div
                        className="h-full transition-all"
                        style={{ width: `${s.pct}%`, backgroundColor: STATUS_BAR_COLORS[s.status] || "var(--zinc-500-val)" }}
                      />
                    </div>
                  </div>
                ))}
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

    </div>
  );
});

export default AnalyticsView;
