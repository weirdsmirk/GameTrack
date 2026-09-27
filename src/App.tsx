import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useGameTrackStore } from "./store";
import Toast from "./components/Toast";
import NotFoundView from "./components/NotFoundView";
import DashboardView from "./components/DashboardView";
import AnalyticsView from "./components/AnalyticsView";
import LibraryView from "./components/LibraryView";
import DiscoverView from "./components/DiscoverView";
import WishlistView from "./components/WishlistView";
import SettingsModal from "./components/SettingsModal";
import AuthModal from "./components/AuthModal";
import GameDetailsModal from "./components/GameDetailsModal";
import AddGameModal from "./components/AddGameModal";
import { ActivePlayingConflictModal } from "./components/ActivePlayingConflictModal";
import { Settings, Menu, X } from "lucide-react";
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
  // Navigation is a drawer at every width: there is no horizontal tab row and
  // no wordmark bar, so the hamburger and the settings gear float over the hero
  // as two accent squares and the page title owns the top of the screen.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  // Reset scroll position to top instantly when switching views.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    if (el.scrollTop === 0) return;
    el.scrollTo({ top: 0, behavior: "instant" });
  }, [activeTab]);

  // A drawer is only ever open over the view it was opened from, so any tab
  // change (a tap, a keyboard shortcut, a wishlist jump) closes it and hands
  // focus back to the trigger.
  useEffect(() => {
    setMenuOpen(false);
  }, [activeTab]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

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
    { id: "library", label: "LIBRARY" },
    { id: "analytics", label: "ANALYTICS" }
  ] as const;

  const renderActiveView = () => {
    switch (activeTab) {
      case "library":
        return <LibraryView />;
      case "discover":
        return <DiscoverView />;
      case "analytics":
        return <AnalyticsView />;
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
        {/* Primary nav — a floating control cluster, not a bar. The horizontal
            tab row and the wordmark are gone: every destination now lives in the
            drawer, at every viewport width, so navigation is the same gesture
            everywhere and the hero title owns the top of the page outright.

            Both controls are accent-filled squares in the app's `Buttons` icon
            language, which is what lets them float over the 110px hero title
            without a backdrop to hide behind — there is no opaque fill behind
            them at any scroll position, and no reveal to animate.

            Sits at z-20, below the page titles, which carry `relative z-30` so a
            110px title scrolls up and over the controls rather than being
            sliced by them. The titles are pointer-events-none, so their boxes
            cannot swallow clicks meant for the buttons. `pointer-events-none` on
            the nav keeps its full-bleed box from eating clicks across the top of
            the page; the button row re-enables them.

            pt-10 puts the row's top edge on the view's <h1> line rather than
            floating it above the title. */}
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 top-0 z-20 flex items-center justify-end px-6 md:px-12 pt-10 pointer-events-none"
        >
          <div className="flex items-stretch gap-1.5 pointer-events-auto">
            <Buttons
              ref={menuButtonRef}
              variant="icon"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-controls="primary-menu"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              title={menuOpen ? "Close menu" : "Open menu"}
              className="p-2"
            >
              {menuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </Buttons>
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

          {/* Drawer — every viewport width. It shares the cluster's solid accent
              square as its anchor and hangs off the nav's bottom edge, so the
              two read as one block with no seam. */}
          <AnimatePresence>
            {menuOpen && (
              <>
                <motion.div
                  key="menu-scrim"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  onClick={() => setMenuOpen(false)}
                  className="fixed inset-0 z-10 bg-black/70 pointer-events-auto"
                  aria-hidden="true"
                />
                <motion.div
                  key="menu-panel"
                  id="primary-menu"
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10, transition: { duration: 0.12 } }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute inset-x-0 top-full z-20 bg-brand-bg border-b border-brand-border pointer-events-auto"
                >
                  <div className="flex flex-col gap-1.5 px-6 pb-6 pt-1">
                    {tabs.map((tab) => {
                      const isActive = activeTab === tab.id;
                      return (
                        <Buttons
                          key={tab.id}
                          variant={isActive ? "primary" : "tab"}
                          onClick={() => setActiveTab(tab.id)}
                          aria-current={isActive ? "page" : undefined}
                          className="w-full py-3 border border-brand-border"
                        >
                          {tab.label}
                        </Buttons>
                      );
                    })}
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
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
