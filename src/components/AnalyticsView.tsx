import React, { useEffect } from "react";
import { useGameTrackStore } from "../store";
import { 
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid
} from "recharts";
import { STATUSES } from "../constants";
import { formatPlaytimePrecise } from "../utils/time";
const CustomTooltip = React.memo(({ active, payload, label }: { active?: boolean, payload?: { name: string, value: number | string }[], label?: string }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-zinc-950 border border-brand-border p-3 text-[11px] uppercase tracking-widest shadow-xl">
        <p className="font-bold text-white mb-1.5 border-b border-brand-border/40 pb-1">{label}</p>
        {payload.map((pld: { name: string, value: number | string }) => (
          <div key={pld.name} className="flex justify-between items-center gap-4 py-0.5">
            <span className="text-brand-muted">{pld.name}:</span>
            <span className="font-black text-brand-accent">{pld.value}</span>
          </div>
        ))}
      </div>
    );
  }
  return null;
});

const STATUS_BAR_COLORS: Record<string, string> = {
  backlog: "var(--zinc-600-val)",
  playing: "var(--emerald-400-val)",
  completed: "var(--brand-accent)",
  endless: "var(--fuchsia-400-val)",
};

export const AnalyticsView: React.FC = React.memo(() => {
  const { 
    games, genreAnalytics, summary, lastAnalyticsFetch, fetchAnalytics
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

  // Single-accent series — one clean color story instead of a rainbow.
  const genreData = genreAnalytics.slice(0, 7);

  return (
    <div className="space-y-10">
      {/* Page header — the same title / subtext / hairline treatment as every
          other view, and the only <h1> on the page now that analytics has its
          own route out of the dashboard. */}
      <div>
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
        <div aria-hidden="true" className="mt-8 h-px w-full bg-brand-border/60" />
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
          baseline however their labels wrap: at the narrowest four-column width
          "Total Telemetry Hours" is the longest string in the row, and without
          the reservation its figure drops a line below its neighbours. Same
          vocabulary as the app — square corners, 1px brand-border, tracked
          caps, black Inter figures, accent reserved for the one figure that is
          a ratio. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 auto-rows-fr gap-px bg-brand-border border border-brand-border">
        <div className="bg-brand-bg p-5 sm:p-6">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted">Registry Titles</p>
          <h3 className="text-5xl sm:text-7xl font-black text-white font-sans tracking-tighter leading-none mt-4">{totalGames}</h3>
        </div>

        <div className="bg-brand-bg p-5 sm:p-6">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted">Total Telemetry Hours</p>
          <div className="flex items-baseline gap-2 mt-4">
            <h3 className="text-5xl sm:text-7xl font-black text-white font-sans tracking-tighter leading-none">{Math.round(totalPlaytime)}</h3>
            <span className="text-sm sm:text-base font-black uppercase text-brand-muted">HRS</span>
          </div>
        </div>

        <div className="bg-brand-bg p-5 sm:p-6">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted">Avg Unit Duration</p>
          <div className="flex items-baseline gap-2 mt-4">
            <h3 className="text-5xl sm:text-7xl font-black text-white font-sans tracking-tighter leading-none">{avgPlaytime}</h3>
            <span className="text-sm sm:text-base font-black uppercase text-brand-muted">HRS/GAME</span>
          </div>
        </div>

        <div className="bg-brand-bg p-5 sm:p-6">
          <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-brand-muted">Completion Rate</p>
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

      {/* Row 1: Genres (wide) + Status Distribution (narrow) */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">

        {/* Genre distribution Area chart */}
        <div className="xl:col-span-3 border border-brand-border bg-transparent p-6 rounded-none space-y-4">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-black uppercase tracking-widest text-white">Genre Telemetry Share</h3>
          </div>
          <div
            className="h-72 w-full pt-4"
            role="img"
            aria-label={
              genreAnalytics.length === 0
                ? "Genre chart: no data"
                : `Genre chart by playtime: ${genreData.map((g) => `${g.genre} ${Math.round(g.total_playtime || 0)} hours`).join(", ")}`
            }
          >
            {genreData.length === 0 ? (
              <div className="w-full h-full flex items-center justify-center border border-brand-border/30 bg-zinc-950/20 text-xs uppercase text-brand-muted">
                No genre metrics registry
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={genreData} margin={{ top: 14, right: 14, left: -4, bottom: 0 }}>
                  <defs>
                    {/* Vertical fade: luminous at the line, dissolving into the background */}
                    <linearGradient id="genreAreaFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--brand-accent)" stopOpacity={0.28} />
                      <stop offset="70%" stopColor="var(--brand-accent)" stopOpacity={0.05} />
                      <stop offset="100%" stopColor="var(--brand-accent)" stopOpacity={0} />
                    </linearGradient>
                    {/* Soft bloom behind the line */}
                    <filter id="genreGlow" x="-20%" y="-20%" width="140%" height="140%">
                      <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="var(--brand-accent)" floodOpacity="0.35" />
                    </filter>
                  </defs>
                  <CartesianGrid vertical={false} stroke="var(--brand-border)" strokeOpacity={0.35} strokeDasharray="3 6" />
                  <XAxis 
                    dataKey="genre" 
                    stroke="var(--zinc-600-val)" 
                    tickLine={false}
                    axisLine={{ stroke: "var(--brand-border)", strokeOpacity: 0.5 }}
                    tickMargin={10}
                    tick={{ fill: "var(--brand-muted)", fontSize: 9, fontFamily: "var(--font-sans)", letterSpacing: "0.08em" }} 
                  />
                  <YAxis 
                    stroke="var(--zinc-600-val)" 
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                    tick={{ fill: "var(--brand-muted)", fontSize: 9, fontFamily: "var(--font-sans)" }}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{ stroke: "var(--brand-accent)", strokeOpacity: 0.35, strokeWidth: 1 }} />
                  <Area
                    type="monotone"
                    dataKey="total_playtime"
                    name="PLAYTIME HOURS"
                    stroke="var(--brand-accent)"
                    strokeWidth={2.5}
                    fill="url(#genreAreaFill)"
                    filter="url(#genreGlow)"
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
