import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useGameTrackStore } from "./store";
import Toast from "./components/Toast";
import NotFoundView from "./components/NotFoundView";
import DashboardView from "./components/DashboardView";
import LibraryView from "./components/LibraryView";
import DiscoverView from "./components/DiscoverView";
import WishlistView from "./components/WishlistView";
import SettingsModal from "./components/SettingsModal";
import AuthModal from "./components/AuthModal";
import GameDetailsModal from "./components/GameDetailsModal";
import AddGameModal from "./components/AddGameModal";
import { ActivePlayingConflictModal } from "./components/ActivePlayingConflictModal";
import { Settings } from "lucide-react";
import PageLoader from "./components/PageLoader";
import { Buttons } from "./components/Buttons";
import AppFooter from "./components/AppFooter";
import { getLegalDoc, LegalView } from "./components/LegalView";

export default function App() {
  const {
    activeTab, setActiveTab, fetchGames, fetchAnalytics,
    fetchTrending, fetchDiscoverLists,
    setSettingsOpen, fetchSteamSettings,
    fetchWishlist, fetchCustomPlatforms,
    loadingGames,
    fetchCustomizations,
  } = useGameTrackStore();
  const [pathname, setPathname] = useState(() => window.location.pathname);
  // The app has no router; Link pushes history state and fires popstate, so
  // re-read the path when that happens instead of reloading the document.
  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [booted, setBooted] = useState(false);
  // The floating tab row (and settings gear) is always on screen; only the
  // bar behind it — backdrop plus GAMETRACK wordmark — waits until the hero
  // has scrolled past. Listens on <main> — the real scroller — because the
  // shell is h-screen with an inner overflow container, so window never scrolls.
  const [navVisible, setNavVisible] = useState(false);
  // Suppresses the bar's fade for a single update, so a tab switch can drop it
  // as a hard cut instead of animating it out across the view swap.
  const [navNoTransition, setNavNoTransition] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  // Set for exactly one scroll event: the one caused by the tab-switch reset
  // below. See the reset effect for why.
  const navResetRef = useRef(false);

  // Reset scroll position to top instantly when switching tabs.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    // This programmatic scroll emits a real scroll event, which the reveal
    // handler would otherwise process as an ordinary "scrolled home" — fading
    // the bar out over 420ms in the middle of the page swap. Two animated
    // things crossing at once is what read as a flash.
    //
    // The bar still has to go: the new view opens at scrollTop 0, and "bar
    // down" only looks right once the h1 has scrolled up and cleared the
    // wordmark. Holding it down here would drop the GAMETRACK wordmark behind
    // the title. So the reset is flagged, and the handler responds to it with
    // an instant hide instead of a fade.
    //
    // Bail when already at the top: there is no reset to absorb, and the flag
    // is consumed by the next event — which on a fresh load would otherwise be
    // the user's very first scroll, turning their normal reveal into a cut.
    if (el.scrollTop === 0) return;
    navResetRef.current = true;
    el.scrollTo({ top: 0, behavior: "instant" });
  }, [activeTab]);

  // Reveal the nav bar backdrop only after the hero has scrolled past. <main>
  // is mounted unconditionally now that the landing gate is gone, so this runs
  // once on mount with no gating.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    // Reveal the nav bar backdrop as soon as the user starts scrolling the
    // hero away, rather than waiting for the hero to fully clear it.
    const HERO_SCROLL_END = 48;
    // Crossing the threshold only *arms* the reveal. The bar drops in after a
    // beat, so a flick of the wheel (or a rubber-band that snaps back) doesn't
    // flash it. Hiding is deliberately not delayed — scrolling back up should
    // clear the bar at once, never leave it hanging over the hero.
    const HERO_REVEAL_DELAY = 300;
    let revealTimer: ReturnType<typeof setTimeout> | null = null;

    const onScroll = () => {
      // Any real scroll re-arms the fade for subsequent reveals/hides.
      setNavNoTransition(false);
      const past = el.scrollTop > HERO_SCROLL_END;
      if (past) {
        if (revealTimer === null) {
          revealTimer = setTimeout(() => {
            revealTimer = null;
            setNavVisible(true);
          }, HERO_REVEAL_DELAY);
        }
      } else {
        if (revealTimer !== null) {
          clearTimeout(revealTimer);
          revealTimer = null;
        }
        setNavVisible(false);
      }
    };
    // A tab switch is not a scroll gesture. Consume its event and drop the bar
    // without a transition, so the cut lands in a single frame instead of
    // animating out underneath the incoming view. One-shot: scrollTo with an
    // explicit position emits exactly one event.
    const onScrollEvent = () => {
      if (navResetRef.current) {
        navResetRef.current = false;
        if (revealTimer !== null) {
          clearTimeout(revealTimer);
          revealTimer = null;
        }
        setNavNoTransition(true);
        setNavVisible(false);
        return;
      }
      onScroll();
    };
    // Called directly, not through the wrapper, so the initial state read can
    // never consume a pending flag.
    onScroll();
    el.addEventListener("scroll", onScrollEvent, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScrollEvent);
      if (revealTimer !== null) clearTimeout(revealTimer);
    };
  }, []);

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

  useEffect(() => {
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
  }, []);

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

  // Legal pages (privacy, terms, licence, DMCA). Rendered before the 404
  // check and before the app shell, so a policy is reachable without booting
  // the data layer.
  const legalDoc = getLegalDoc(pathname);
  if (legalDoc) {
    return <LegalView doc={legalDoc} />;
  }

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
          <div className="w-full px-6 md:px-12 pt-10 pb-10 overflow-x-hidden shrink-0 relative">
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
            {/* Sits outside AnimatePresence so it persists across tab switches
                instead of re-animating with the view. */}
            <AppFooter />
          </div>
        </main>

        {/* Global Overlays & Portals */}
        {/* Primary nav — one element, two visual states. The tab row and
            settings gear are always mounted and always visible, floating over
            the hero; only the bar behind them (opaque fill + GAMETRACK
            wordmark) fades in once the user scrolls past the hero.

            Both states cross-fade on opacity/background-color only — no
            transform, so nothing pops or slides. The fill runs 420ms and the
            wordmark 520ms on the same expo-out curve, so the backdrop
            resolves just ahead of the wordmark and the reveal cascades
            instead of snapping as one block.

            This bar sits at z-20, deliberately below the page titles, which
            carry `relative z-30` so a 110px title scrolls up and over the
            bar rather than being sliced by it. That only works because the
            view's motion.div has no residual transform/opacity/will-change
            once its enter animation completes and the inline transform is
            cleared — any of those would re-create a stacking context and
            trap the title's z-index below this bar. The titles are also
            pointer-events-none so their boxes cannot swallow clicks meant
            for the tab row.

            Single element on purpose: the bar's height is driven by the 34px
            button row, so the row stays perfectly centred inside it instead of
            overflowing a fixed-height backdrop. py-10 puts that row's top edge
            at 40px, level with the view's <h1> box, so the tabs sit on the
            title's line rather than floating above it. The nav spans the full width
            in both states, so it carries pointer-events-none and re-enables
            them on the wordmark and buttons — otherwise the transparent
            over-hero state would swallow clicks across the top of the page.
            No border: the fill and height alone separate it from content. */}
        <nav
          aria-label="Primary"
          className={`fixed inset-x-0 top-0 z-20 flex items-center gap-4 px-6 md:px-12 py-10 pointer-events-none ${
            navNoTransition
              ? "transition-none"
              : "transition-colors duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
          } ${navVisible ? "bg-brand-bg" : "bg-transparent"}`}
        >
          <div
            className={`flex items-center gap-2 select-none ${
              navNoTransition
                ? "transition-none"
                : "transition-opacity duration-[520ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
            } ${navVisible ? "opacity-100 pointer-events-auto" : "opacity-0"}`}
          >
            <span className="text-base font-black tracking-tighter leading-none">
              <span className="text-white">GAME</span>
              <span className="text-brand-accent">TRACK</span>
              <span className="text-brand-accent">_</span>
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
