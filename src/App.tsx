import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useGameTrackStore } from "./store";
import Toast from "./components/Toast";
import NotFoundView from "./components/NotFoundView";
import LandingView from "./components/LandingView";
import DashboardView from "./components/DashboardView";
import LibraryView from "./components/LibraryView";
import DiscoverView from "./components/DiscoverView";
import WishlistView from "./components/WishlistView";
import SettingsModal from "./components/SettingsModal";
import AuthModal from "./components/AuthModal";
import GameDetailsModal from "./components/GameDetailsModal";
import AddGameModal from "./components/AddGameModal";
import { ActivePlayingConflictModal } from "./components/ActivePlayingConflictModal";
import { Settings, Terminal } from "lucide-react";
import PageLoader from "./components/PageLoader";
import BackToTop from "./components/BackToTop";
import { Buttons } from "./components/Buttons";

const ENTERED_KEY = "gametrack_entered";

export default function App() {
  const {
    activeTab, setActiveTab, fetchGames, fetchAnalytics,
    fetchTrending, fetchDiscoverLists,
    setSettingsOpen, fetchSteamSettings,
    fetchWishlist, fetchCustomPlatforms,
    loadingGames,
    fetchCustomizations,
  } = useGameTrackStore();
  const [pathname] = useState(() => window.location.pathname);
  const [booted, setBooted] = useState(false);
  // The floating tab row (and settings gear) is always on screen; only the
  // bar behind it — backdrop plus GAMETRACK wordmark — waits until the hero
  // has scrolled past. Listens on <main> — the real scroller — because the
  // shell is h-screen with an inner overflow container, so window never scrolls.
  const [navVisible, setNavVisible] = useState(false);
  const [entered, setEntered] = useState(() => {
    try {
      return localStorage.getItem(ENTERED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const mainRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  // Reset scroll position to top instantly when switching tabs
  useEffect(() => {
    if (mainRef.current) {
      mainRef.current.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [activeTab]);

  // Reveal the nav bar backdrop only after the hero has scrolled past.
  // `entered` gates this because mainRef is only mounted once the landing
  // gate is dismissed.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    // Reveal the nav bar backdrop as soon as the user starts scrolling the
    // hero away, rather than waiting for the hero to fully clear it.
    const HERO_SCROLL_END = 48;
    const onScroll = () => setNavVisible(el.scrollTop > HERO_SCROLL_END);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [entered]);

  // Preload everything once at boot — games, Steam identity, analytics,
  // wishlist and custom platforms — so every tab is instant afterwards.
  // Discover fetches respect the 5-minute freshness window inside the store;
  // reading current state via getState() keeps this effect from re-running
  // (its previous deps were written by the very fetches it started).
  useEffect(() => {
    const s = useGameTrackStore.getState();
    fetchGames();
    fetchSteamSettings();
    fetchAnalytics();
    fetchWishlist();
    fetchCustomPlatforms();
    fetchCustomizations();
    if (s.trendingGames.length === 0 || Date.now() - s.lastTrendingFetch > 300_000) fetchTrending();
    if (!s.discoverLists || Date.now() - s.lastListsFetch > 300_000) fetchDiscoverLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEnter = () => {
    try {
      localStorage.setItem(ENTERED_KEY, "1");
    } catch {
      /* ignore */
    }
    setEntered(true);
    setActiveTab("dashboard");
  };

  useEffect(() => {
    if (!entered) return;
    let chord: string | null = null;
    let chordTimer: ReturnType<typeof setTimeout> | null = null;

    const typing = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      const store = useGameTrackStore.getState();
      // Option + , toggles the system settings panel (macOS-style preferences
      // shortcut). Matched by physical code so it works even though Option
      // remaps e.key to a punctuation character on US layouts, and preventDefault
      // stops that character from landing in any focused input.
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === "Comma") {
        e.preventDefault();
        store.setSettingsOpen(!store.isSettingsOpen);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" && !typing(e.target)) {
        e.preventDefault();
        store.setActiveTab("library");
        store.requestSearchFocus();
        return;
      }
      if (typing(e.target)) return;
      const key = e.key.toLowerCase();
      if (chord === "g") {
        if (chordTimer) clearTimeout(chordTimer);
        chord = null;
        if (key === "l") store.setActiveTab("library");
        if (key === "d") store.setActiveTab("dashboard");
        return;
      }
      if (key === "g") {
        chord = "g";
        chordTimer = setTimeout(() => { chord = null; }, 800);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (chordTimer) clearTimeout(chordTimer);
    };
  }, [entered]);

const tabs = [
    { id: "dashboard", label: "CENTRAL" },
    { id: "discover", label: "DISCOVER" },
    { id: "library", label: "LIBRARY" }
  ] as const;

  const renderActiveView = () => {
    switch (activeTab) {
      case "library":
        return <LibraryView />;
      case "discover":
        return <DiscoverView />;
      case "wishlist":
        return <WishlistView />;
      case "dashboard":
      default:
        return <DashboardView />;
    }
  };

  // Custom 404 — any unknown path renders the not-found terminal instead of the app shell
  if (pathname !== "/") {
    return (
      <div className="min-h-dvh bg-brand-bg font-sans selection:bg-brand-accent/30 selection:text-brand-accent">
        <NotFoundView path={pathname} />
        {!booted && (
          <PageLoader checks={[!loadingGames]} onComplete={() => setBooted(true)} />
        )}
      </div>
    );
  }

  // Landing gate — shown full-screen until the user enters
  if (!entered) {
    return (
      <div className="h-screen overflow-y-auto bg-brand-bg text-zinc-300 font-sans selection:bg-brand-accent/30 selection:text-brand-accent">
        <LandingView onEnter={handleEnter} />
        <SettingsModal />
        <AuthModal />
        <Toast />
        {!booted && (
          <PageLoader checks={[!loadingGames]} onComplete={() => setBooted(true)} />
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex h-screen w-full bg-brand-bg overflow-hidden text-zinc-300 font-sans selection:bg-brand-accent/30 selection:text-brand-accent relative">

        {/* Subtle Ambient Glow accents across the entire app */}
        <div className="fixed top-[-150px] left-1/3 w-[800px] h-[400px] bg-brand-accent/[0.04] blur-[150px] rounded-full pointer-events-none z-0" />
        <div className="fixed bottom-[-200px] right-1/4 w-[600px] h-[500px] bg-brand-accent/[0.02] blur-[150px] rounded-full pointer-events-none z-0" />

        {/* Main workspace — full width, top navigation. The nav bar is hidden
            over the hero, so content keeps its original top offset and the
            title owns the top of the screen until the bar slides in. */}
        <main ref={mainRef} className="flex-1 flex flex-col min-w-0 min-h-0 bg-brand-bg overflow-y-auto scroll-smooth antialiased">
          <div className="w-full px-6 md:px-12 py-10 pb-24 overflow-x-hidden shrink-0 relative">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={activeTab}
                ref={pageRef}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } }}
                exit={{ opacity: 0, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
                className="w-full min-h-[60vh]"
                onAnimationComplete={() => {
                  const el = pageRef.current;
                  if (el && el.style.transform) el.style.transform = "";
                }}
              >
                {renderActiveView()}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>

        {/* Global Overlays & Portals */}
        {/* Primary nav — one element, two visual states. The tab row and
            settings gear are always mounted and always visible, floating over
            the hero; only the bar behind them (opaque fill + GAMETRACK
            wordmark) fades in once the user scrolls past the hero.

            Single element on purpose: the bar's height is driven by the 34px
            button row, so the row stays perfectly centred inside it instead of
            overflowing a fixed-height backdrop. The nav spans the full width
            in both states, so it carries pointer-events-none and re-enables
            them on the wordmark and buttons — otherwise the transparent
            over-hero state would swallow clicks across the top of the page.
            No border: the fill and height alone separate it from content. */}
        <nav
          aria-label="Primary"
          className={`fixed inset-x-0 top-0 z-20 flex items-center gap-4 px-6 md:px-12 py-8 pointer-events-none transition-colors duration-100 ease-out ${
            navVisible ? "bg-brand-bg" : "bg-transparent"
          }`}
        >
          <div
            className={`flex items-center gap-2 select-none transition-opacity duration-100 ease-out ${
              navVisible ? "opacity-100 pointer-events-auto" : "opacity-0"
            }`}
          >
            <Terminal className="w-4 h-4 text-brand-accent shrink-0" />
            <span className="text-base font-black tracking-tighter leading-none">
              <span className="text-white">GAME</span>
              <span className="text-brand-accent">TRACK</span>
            </span>
          </div>
          <div className="ml-auto flex items-stretch gap-1.5 pointer-events-auto">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <Buttons
                  key={tab.id}
                  variant={isActive ? "primary" : "tab"}
                  onClick={() => setActiveTab(tab.id)}
                  aria-current={isActive ? "page" : undefined}
                  className="px-4 py-2"
                >
                  {tab.label}
                </Buttons>
              );
            })}
            <Buttons
              variant="icon"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open Settings"
              title="Open Settings"
              className="p-2"
            >
              <Settings className="w-4 h-4" />
            </Buttons>
          </div>
        </nav>
        <GameDetailsModal />
        <AddGameModal />
        <SettingsModal />
        <AuthModal />
        <ActivePlayingConflictModal />
        <Toast />
        {/* Floating back-to-top: appears on every page once the user scrolls down */}
        <BackToTop scrollContainerRef={mainRef} />

        {/* Full-screen boot loader: the screen in index.html stays blank (like
            the theme change) while the game registry preloads, then fades to
            reveal. Analytics/discover data streams in behind — the views show
            their own states — so nothing else can delay the reveal. */}
        {!booted && (
          <PageLoader
            checks={[!loadingGames]}
            onComplete={() => setBooted(true)}
          />
        )}
      </div>
    </>
  );
}
