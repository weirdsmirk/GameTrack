import React, { useEffect, useState } from "react";
import { useGameTrackStore } from "../store";
import { useShallow } from "zustand/react/shallow";
import { 
  Trophy, Clock, Sparkles, Calendar, Shuffle, ChevronDown
} from "lucide-react";
import { motion } from "motion/react";
import { formatPlaytime, formatPlaytimeLong, formatPlaytimePrecise } from "../utils/time";
import { getStatusBadgeColor, getStatusLabel, platformIdMatches, mergeCustomPlatforms } from "../constants";
import { PosterImage } from "./PosterImage";
import { Buttons } from "./Buttons";
import AnalyticsView from "./AnalyticsView";
import ActiveGamesModal from "./ActiveGamesModal";

// Render a single stat card in bold brutalist style
interface StatCardProps {
  title: string;
  value: string | number;
  subtext: string;
  onClick?: () => void;
}

const StatCard = React.memo(({ title, value, subtext, onClick }: StatCardProps) => {
  // Check if the value is a string with a space or ends with H (e.g. "13H 34M" or "38H")
  const isPlaytime = typeof value === "string" && (value.includes(" ") || value.endsWith("H"));
  
  return (
    <div
      onClick={onClick}
      onKeyDown={onClick ? (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      } : undefined}
      tabIndex={onClick ? 0 : undefined}
      role={onClick ? "button" : undefined}
      className={`bg-transparent border border-brand-border px-6 py-8 rounded-none relative overflow-hidden group hover:border-brand-accent/50 transition-colors h-full flex flex-col justify-between${onClick ? " cursor-pointer focus:outline-none focus-visible:outline-2 focus-visible:outline-brand-accent" : ""}`}>
      <div className="space-y-2">
        <p className="text-[13px] font-bold uppercase tracking-widest text-brand-muted font-mono">{title}</p>
        
        {isPlaytime ? (
          <div className="flex flex-wrap items-baseline gap-x-1.5 mt-2 font-sans tracking-tighter leading-none">
            {value.split(" ").map((part: string, idx: number) => {
              const numberVal = part.slice(0, -1);
              const unitVal = part.slice(-1);
              return (
                <React.Fragment key={idx}>
                  {idx > 0 && <span className="w-1" />}
                  <span className="text-6xl sm:text-7xl font-black text-white leading-none">{numberVal}</span>
                  <span className="text-2xl sm:text-3xl font-black text-brand-accent uppercase leading-none self-baseline align-baseline">{unitVal}</span>
                </React.Fragment>
              );
            })}
          </div>
        ) : (
          <h3 className="text-5xl sm:text-6xl lg:text-7xl font-black text-white mt-2 font-sans tracking-tighter leading-none flex flex-wrap">
            {value}
          </h3>
        )}
      </div>
      
      <p className="text-[13px] text-brand-muted mt-3 font-medium uppercase tracking-wider">{subtext}</p>
    </div>
  );
});

const formatStatus = (status: string) => getStatusLabel(status).toUpperCase();

export const DashboardView: React.FC = React.memo(() => {
  const {
    games, summary, suggestions, recentActivity, loadingAnalytics, fetchAnalytics,
    fetchSuggestions, setSelectedGame, lastAnalyticsFetch, customPlatforms, customizations
  } = useGameTrackStore(useShallow(s => ({
    games: s.games, summary: s.summary,
    suggestions: s.suggestions, recentActivity: s.recentActivity,
    loadingAnalytics: s.loadingAnalytics, fetchAnalytics: s.fetchAnalytics,
    fetchSuggestions: s.fetchSuggestions,
    setSelectedGame: s.setSelectedGame,
    lastAnalyticsFetch: s.lastAnalyticsFetch,
    customPlatforms: s.customPlatforms,
    customizations: s.customizations
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
  const [activeGamesOpen, setActiveGamesOpen] = useState(false);

  return (
    <div className="space-y-10">
      {/* Top Welcome / Action Area */}
      <div className="flex flex-col lg:flex-row justify-between items-start gap-8">
        <div className="space-y-3">
          {/* Huge Display Hero Title */}
          <h1 className="text-6xl sm:text-8xl lg:text-[110px] font-black tracking-tighter leading-[0.85] uppercase text-white font-sans select-none">
            GAME<br /><span className="text-brand-accent">TRACK_</span>
          </h1>
          <p className="max-w-none text-brand-muted text-sm sm:text-base font-medium leading-relaxed lg:whitespace-nowrap">
            Your personal gaming registry. Track, organize, and analyze your library.
          </p>
        </div>
      </div>

      {/* Analytics KPI Block */}
      {loadingAnalytics && !summary ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 animate-pulse">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-49 bg-zinc-900/50 border border-brand-border rounded-none" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          <StatCard
            title="Registered Games"
            value={summary?.total_games ?? 0}
            subtext="tracked in local database"
          />
          <StatCard
            title="Active Backlog"
            value={summary?.active_games ?? 0}
            subtext="currently in active play"
            onClick={() => setActiveGamesOpen(true)}
          />
          <StatCard
            title="Completed"
            value={summary?.completed_games ?? 0}
            subtext={`${summary?.total_games ? Math.round(((summary.completed_games) / summary.total_games) * 100) : 0}% aggregate rate`}
          />
          <StatCard
            title="Total Playtime"
            value={formatPlaytime(summary?.total_playtime_hours)}
            subtext={`avg ${formatPlaytime(summary?.average_playtime_per_game).toLowerCase()} per title`}
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
                <h3 className="text-xs font-bold uppercase tracking-widest text-session-subtext font-mono">
                  CURRENT_SESSION
                </h3>
                <h2 className="text-3xl sm:text-5xl lg:text-6xl font-black uppercase tracking-tighter leading-none text-session-text font-sans">
                  {game.title}
                </h2>
                <p className="text-xs font-bold text-session-subtext font-mono tracking-wider max-w-lg uppercase">
                  {game.genres?.slice(0, 3).join("  •  ") ?? ""}
                </p>
              </div>
              
              <div className="text-left sm:text-right shrink-0">
                <p className="text-[11px] font-mono tracking-widest text-session-subtext uppercase font-bold">
                  Accumulated
                </p>
                <div className="font-mono text-3xl sm:text-4xl font-black text-session-text tracking-tight mt-1">
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
            <h3 className="text-xs font-bold uppercase tracking-widest text-session-subtext font-mono">
              NO_ACTIVE_SESSION
            </h3>
            <h2 className="text-3xl sm:text-5xl lg:text-6xl font-black uppercase tracking-tighter leading-none text-session-text font-sans">
              READY_FOR_ENGAGEMENT
            </h2>
            <p className="text-xs font-bold text-session-subtext font-mono tracking-wider max-w-lg uppercase">
              MARK_A_TITLE_AS_CURRENTLY_PLAYING_TO_INITIATE_METRIC_TRACKING
            </p>
          </div>
        </div>
      )}
      {/* Suggestions and Recent Activity Grid — 3:1, so the Logs rail stays a
          rail. Log rows truncate their title and keep the status badge
          shrink-0, so the narrower column degrades to an ellipsis. */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-10">
        
        {/* Next To Play Recommendations */}
        <div className="lg:col-span-3 space-y-6">
          <div className="flex items-center justify-between border-b border-brand-border pb-3 gap-3 lg:h-[46px]">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-brand-accent" />
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
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-5 lg:h-[418px]">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="aspect-[2/3] lg:aspect-auto lg:h-full bg-zinc-900/50 border border-brand-border animate-pulse" />
              ))}
            </div>
          ) : suggestions.length === 0 ? (
            <div className="border border-brand-border border-dashed rounded-none p-8 text-center flex flex-col items-center justify-center lg:h-[418px]">
              <Trophy className="w-10 h-10 text-brand-muted mb-3" />
              <p className="text-white text-sm font-bold uppercase tracking-wider">Suggested directive empty</p>
              <p className="text-brand-muted text-xs mt-1 max-w-sm">
                Mark games as "Backlog" inside My Library or log discovery entries to run auto-prioritization models.
              </p>
            </div>
          ) : (
            /* Poster row. lg:h-[418px] is 46px header + 24px gap + 418px, so
               this block ends flush with the 488px Logs rail beside it. At lg
               the cards drop their 2:3 ratio and fill that height (object-cover
               crops ~4% off the width) to keep the two columns aligned. */
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-5 lg:h-[418px]">
              {suggestions.map((game, index) => (
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
                  className="relative aspect-[2/3] lg:aspect-auto lg:h-full overflow-hidden border border-brand-border bg-zinc-900 group hover:border-brand-accent transition-colors focus:outline-none focus-visible:outline-2 focus-visible:outline-brand-accent cursor-pointer"
                >
                  <PosterImage
                    src={game.poster_url}
                    alt={game.title}
                    eager={index === 0}
                    className="absolute inset-0 h-full w-full object-cover group-hover:scale-[1.03] transition-transform duration-300 transform-gpu will-change-transform"
                  />

                  {/* Scrim: legibility only — the title sits on artwork, so it
                      needs a guaranteed floor of contrast at the bottom edge. */}
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/55 to-transparent"
                  />

                  {customizations.showRatingBadge && game.critic_score != null && (
                    <div className="absolute top-3 left-3 bg-zinc-950/90 border border-brand-accent px-2 py-0.5 font-mono text-[11px] font-black text-brand-accent uppercase tracking-wider">
                      MC: {game.critic_score}
                    </div>
                  )}

                  <div className="absolute inset-x-0 bottom-0 p-4 flex flex-col gap-2">
                    <h4 className="text-sm xl:text-base font-black uppercase tracking-tight leading-[1.05] text-white line-clamp-3 break-words">
                      {game.title}
                    </h4>
                    <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-widest text-white/70">
                      {game.year ? <span className="shrink-0">{game.year}</span> : <span />}
                      {game.owned_platforms && game.owned_platforms.filter(p => platforms.some(ap => platformIdMatches(ap.id, p))).length > 0 && (
                        <span className="truncate">
                          {game.owned_platforms.filter(p => platforms.some(ap => platformIdMatches(ap.id, p))).map(p => platforms.find(ap => platformIdMatches(ap.id, p))?.label || p).join(", ")}
                        </span>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Activity Panel */}
        <div className="space-y-6">
          <div className="border-b border-brand-border pb-3 flex items-center lg:h-[46px]">
            <h3 className="text-lg font-bold tracking-tight uppercase text-white flex items-center gap-2">
              <Clock className="w-5 h-5 text-brand-accent" />
              Logs
            </h3>
          </div>

          {loadingAnalytics ? (
            <div className="space-y-3 animate-pulse">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-16 bg-zinc-900/50 rounded-none border border-brand-border" />
              ))}
            </div>
          ) : recentActivity.length === 0 ? (
            <div className="border border-brand-border border-dashed rounded-none p-6 text-center flex flex-col items-center justify-center h-48">
              <Calendar className="w-8 h-8 text-brand-muted mb-2" />
              <p className="text-brand-muted text-xs uppercase font-bold font-mono">No recent activity logs</p>
            </div>
          ) : (
            <div className="relative">
              <div className="space-y-3 lg:h-[488px] lg:overflow-y-auto lg:pr-1">
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
                      <span className="text-[11px] text-brand-muted font-mono font-bold">
                        {game.hide_playtime === 1 ? "—" : formatPlaytimeLong(game.playtime)}
                      </span>
                      <p className="text-[11px] text-brand-muted font-mono uppercase font-bold">
                        {new Date(game.updated_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              {recentActivity.length > 6 && (
                <>
                  <div className="absolute bottom-0 inset-x-0 h-10 bg-gradient-to-t from-brand-bg to-transparent pointer-events-none hidden lg:block" />
                  <div className="absolute -bottom-1.5 inset-x-0 flex justify-center pointer-events-none hidden lg:flex">
                    <ChevronDown className="w-6 h-6 text-brand-accent" />
                  </div>
                </>
              )}
            </div>
          )}
        </div>

      </div>

      {/* Full analytics telemetry — moved here from the former standalone tab */}
      <div className="border-t border-brand-border pt-10">
        <AnalyticsView />
      </div>

      <ActiveGamesModal
        open={activeGamesOpen}
        games={activeGames}
        onClose={() => setActiveGamesOpen(false)}
      />

    </div>
  );
});
export default DashboardView;
