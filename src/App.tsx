import { useEffect, useMemo, useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useGameTrackStore } from "./store";
import { TABS } from "./tabs";
import Toast from "./components/Toast";
import NotFoundView from "./components/NotFoundView";
import DashboardView from "./components/DashboardView";
import AnalyticsView from "./components/AnalyticsView";
import LibraryView from "./components/LibraryView";
import DiscoverView from "./components/DiscoverView";
import WishlistView from "./components/WishlistView";
import SettingsModal from "./components/SettingsModal";
import ShortcutsModal from "./components/ShortcutsModal";
import AuthModal from "./components/AuthModal";
import GameDetailsModal from "./components/GameDetailsModal";
import AddGameModal from "./components/AddGameModal";
import { ActivePlayingConflictModal } from "./components/ActivePlayingConflictModal";
import { Menu, X, ArrowRight } from "lucide-react";
import PageLoader from "./components/PageLoader";
import { Buttons } from "./components/Buttons";
import { KeyRow } from "./components/KeyRow";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { preloadImages } from "./utils/image";
import { Spinner } from "./components/Spinner";
import AppFooter from "./components/AppFooter";
import { getLegalDoc, LegalView } from "./components/LegalView";

/** Longest the page gate will hold a view back waiting for its covers. */
const GATE_MAX_WAIT_MS = 2500;

/**
 * The right-hand slot of a menu row: the row's own Option digit from md up,
 * an arrow below it. Both are `shrink-0` and sit in the same place, so the
 * labels line up down the column at every width — the arrow is a plain
 * "this goes somewhere" mark that inherits the row's colour (black on the
 * filled row, muted on the rest).
 */
const MenuHint = ({ digit }: { digit: string }) => (
  <>
    <ArrowRight className="w-4 h-4 shrink-0 md:hidden" />
    <KeyRow keys={["ALT", digit]} className="hidden md:block" />
  </>
);

export default function App() {
  const {
    activeTab, setActiveTab, fetchGames, fetchAnalytics,
    fetchTrending, fetchDiscoverLists,
    setSettingsOpen, setShortcutsOpen, fetchSteamSettings,
    fetchWishlist, fetchCustomPlatforms,
    loadingGames,
    fetchCustomizations,
    showToast,
    customizations, updateCustomizations,
    games, loadingAnalytics, loadingWishlist, loadingLists, loadingDiscover,
    trendingGames, discoverSearchResults, discoverQuery, wishlist,
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
  // Matches the `md` breakpoint the shortcut button and the menu hints switch
  // on, so keyboard-only affordances are never offered where they cannot work.
  const hasKeyboard = useMediaQuery("(min-width: 768px)");
  // Navigation is a drawer at every width: there is no horizontal tab row and
  // no wordmark bar, so the hamburger and the settings gear float over the hero
  // as two accent squares and the page title owns the top of the screen.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
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

  // Ten seconds after the app is up — not after mount, which would put the
  // toast on screen while the boot loader was still up — point at the
  // keyboard. md and up only: the shortcut button is hidden below it, and a
  // phone has no Alt key, so there is nothing to point at. The timer is keyed
  // on `booted`, so a slow first load waits for the app rather than counting
  // from the document.
  //
  // Dismiss is permanent and writes the preference, which lands in
  // `customizations` — so it survives a reload, a new tab and a cleared cache,
  // and Settings > Onboarding puts it back. The hint is offered once, not
  // repeatedly: an unread nag that survives dismissal is worse than none.
  const shortcutHintAllowed = customizations.showShortcutHint !== false;
  useEffect(() => {
    if (!booted || !hasKeyboard || !shortcutHintAllowed) return;
    const timer = setTimeout(() => {
      showToast(
        "Most of this app is one keystroke away — the keyboard is quicker.",
        "info",
        undefined,
        12000,
        [
          { label: "View shortcuts", onClick: () => setShortcutsOpen(true) },
          {
            label: "Dismiss",
            tone: "secondary",
            title: "Don't show this again — re-enable it in Settings › Onboarding",
            onClick: () => updateCustomizations({ showShortcutHint: false }),
          },
        ]
      );
    }, 10000);
    return () => clearTimeout(timer);
  }, [booted, hasKeyboard, shortcutHintAllowed, showToast, setShortcutsOpen, updateCustomizations]);

  useEffect(() => {
    if (!menuOpen) return;
    // Move focus into the menu when it opens. The panel is positioned, not
    // reordered, so it still comes before the toggle in the DOM — leaving
    // focus there would make a keyboard user Tab backwards to reach the items.
    // Escape below hands focus back.
    firstItemRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    // Outside clicks dismiss too. The phone scrim covers the viewport, but the
    // desktop popover deliberately has no scrim, so without this there is no
    // way to close it by clicking away. Capture phase so it fires before the
    // click lands on whatever is underneath.
    const onPointerDown = (e: PointerEvent) => {
      if (navRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
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
      // Option + 1..4 jumps to a page, in menu order. Matched by physical code
      // for the same reason as the comma above: Option rewrites e.key, so
      // Option+1 reports "¡" on a US layout and would never match "1". Reading
      // the digit off the end of the code also covers the numpad for free, and
      // indexing TABS is what ties the digit to the page's menu position — the
      // cheat-sheet modal numbers its rows from the same list.
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        const isDigitKey = e.code.startsWith("Digit") || e.code.startsWith("Numpad");
        // Anything that is not a plain 1-9 — NumpadDecimal, NumpadAdd, or a
        // digit past the end of TABS — falls out as undefined here.
        const tab = isDigitKey ? TABS[Number(e.code.slice(-1)) - 1] : undefined;
        if (tab) {
          e.preventDefault();
          store.setActiveTab(tab.id);
          return;
        }
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

  // ── Page gate ───────────────────────────────────────────────────
  // A view is presented only once its own data has landed and the covers it is
  // about to show are in the browser cache. Without this a tab switch renders
  // the view immediately and the posters stream in one by one as each card
  // scrolls into view, so every navigation looks like a half-loaded page.
  //
  // Readiness is per view, not global: switching to Analytics should not wait
  // on the Discover feed, and a view whose data is already in the store (every
  // switch after the first) never shows the spinner at all. The first batch is
  // preloaded — the same twenty the view reveals — so the gate covers what is
  // on screen and nothing more.
  //
  // Readiness *latches per tab* rather than tracking the live load flags. The
  // gate covers a view's first presentation, and that is all it should cover:
  // once a view is on screen an inline reload — Discover's debounced search or
  // its infinite feed both set `loadingDiscover` — used to flip the gate back
  // to the spinner, unmount the view and remount it. That wiped the search box
  // mid-keystroke and reverted the results to trending, i.e. search did nothing.
  // Keying the latch on the tab id means only a real navigation re-gates.
  const [readyTab, setReadyTab] = useState<string | null>(null);
  const coversReady = readyTab === activeTab;

  const viewDataReady = (() => {
    switch (activeTab) {
      case "library":
      case "dashboard":
        return !loadingGames;
      case "discover":
        return !loadingLists && !loadingDiscover && trendingGames.length > 0;
      case "analytics":
        return !loadingAnalytics;
      case "wishlist":
        return !loadingWishlist;
      default:
        return true;
    }
  })();

  const firstBatchCovers = useMemo(() => {
    if (activeTab === "library" || activeTab === "dashboard") {
      return games.slice(0, 20).map((g) => g.poster_url);
    }
    if (activeTab === "discover") {
      const feed = discoverQuery ? discoverSearchResults : trendingGames;
      return feed.slice(0, 20).map((g) => g.poster_url);
    }
    if (activeTab === "wishlist") {
      return wishlist.slice(0, 20).map((g) => g.poster_url);
    }
    return [];
  }, [activeTab, games, trendingGames, discoverSearchResults, discoverQuery, wishlist]);

  const preloading = useRef(false);
  useEffect(() => {
    if (!viewDataReady || coversReady) return;
    if (firstBatchCovers.length === 0) {
      setReadyTab(activeTab);
      return;
    }
    // One preloader at a time: a rapid tab flip would otherwise start a second
    // batch against a list the view has already moved on from.
    if (preloading.current) return;
    preloading.current = true;
    let cancelled = false;
    // Hard ceiling on the wait. A cover that will not arrive must not hold the
    // page hostage — `PosterImage` has its own fallback for a broken URL, so
    // revealing on time with one empty box beats a spinner that never clears.
    // Cleared as soon as the real preload lands, so the cap only ever applies
    // when the network is the problem.
    const cap = setTimeout(() => {
      if (!cancelled) setReadyTab(activeTab);
    }, GATE_MAX_WAIT_MS);
    preloadImages(firstBatchCovers, { timeoutMs: 4000 }).then(() => {
      if (cancelled) return;
      clearTimeout(cap);
      setReadyTab(activeTab);
    });
    return () => {
      cancelled = true;
      clearTimeout(cap);
      preloading.current = false;
    };
  }, [viewDataReady, coversReady, firstBatchCovers, activeTab]);

  // `coversReady` can only latch once the effect above saw `viewDataReady`, so
  // it is the whole gate on its own — no need to re-assert the live flag.
  const viewReady = coversReady;

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

        {/* No ambient glow behind the app. Two 150px-blurred accent blobs at 4%
            and 2% used to sit here, `fixed` and behind everything; at that
            radius they are not decoration but a wash over the whole page, and
            the background is meant to be one flat `brand-bg` like the rest of
            the language. The page now has one background colour, not a
            gradient that happens to average out to it. */}

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
                {/* The gate sits inside the switching wrapper so it inherits the
                    same enter/exit as the view it stands in for — the spinner
                    is a placeholder for the page, not an overlay on top of a
                    half-drawn one. */}
                {viewReady ? (
                  renderActiveView()
                ) : (
                  <div className="min-h-[60vh] flex items-center justify-center">
                    <Spinner size={34} label="Loading page" />
                  </div>
                )}
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
            menu, at every viewport width, so navigation is the same gesture
            everywhere and the hero title owns the top of the page outright.

            The control is an accent-filled square in the app's `Buttons` icon
            language, which is what lets it float over the 110px hero title
            without a backdrop to hide behind — there is no opaque fill behind
            it at any scroll position, and no reveal to animate. Settings is not
            a second button beside it; it is the last row of the menu, so
            everything the app can do is one tap behind the same control.

            Sits at z-40, ABOVE the page titles (z-30) — the reverse of the old
            bar, and deliberately so. The bar was a full-bleed strip whose whole
            job was to sit under a scrolling title; the menu is an overlay, and
            measured at every width below 1280px its box overlaps the title (up
            to 342x68px on a phone, 226x166px of the dropdown at 768). Below the
            titles, the hero glyphs drew straight over the menu items. Still
            under the modals (z-50/60) and the toast (z-100), so opening settings
            covers the control as it always did.

            `pointer-events-none` on the nav keeps its full-bleed box from eating
            clicks across the top of the page; the button row re-enables them.
            The titles are pointer-events-none too, so their boxes cannot swallow
            clicks meant for the menu.

            pt-8 on phones (the controls are 44px there, so the row needs less
            air above it) and pt-10 from md, which puts the row's top edge on the
            view's <h1> line rather than floating it above the title.

            The cluster's `md:px-12` right inset is load-bearing twice over: it
            holds the controls off the viewport edge, and the menu reads the
            same value as `md:right-12` to line its own right edge up with the
            cluster. Change one and the other has to change with it. */}
        <nav
          ref={navRef}
          aria-label="Primary"
          className="fixed inset-x-0 top-0 z-40 flex justify-end px-6 md:px-12 pt-8 md:pt-10 pointer-events-none"
        >
          {/* Menu — one component, two shapes, both opening downward. On a
              phone it is a full-width panel hanging off the nav's bottom edge,
              because a column of four labels has nowhere to go at 390px. From
              md up it is the same column inset from the left, dropping below
              the toggle like any other preview.

              Either way it is absolutely positioned, so it never takes part in
              the nav's layout and the two controls cannot be pushed around by
              it — the click-jump this cluster used to have is gone by
              construction rather than by an alignment workaround. */}
          <AnimatePresence>
            {menuOpen && (
              <>
                {/* Phone only: on a large screen the popover is small and
                    pointer-precise, so dimming the page behind it would be
                    heavy-handed. Outside clicks are caught by the nav-level
                    pointerdown handler below instead. */}
                <motion.div
                  key="menu-scrim"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  onClick={() => setMenuOpen(false)}
                  className="md:hidden fixed inset-0 z-10 bg-black/70 pointer-events-auto"
                  aria-hidden="true"
                />
                {/* Dropdown below the control cluster, at every width. On a
                    phone `inset-x-0` makes it a full-bleed panel hanging off
                    the nav's bottom edge, because a column of four labels has
                    nowhere to go at 390px. From md up it is inset from the left
                    instead, so it drops straight down under the toggle the way
                    any other preview does, with its right edge on the
                    cluster's — `right-12` is the nav's own `md:px-12`, which is
                    what keeps the two flush; `left-auto` releases the
                    full-bleed `inset-x-0` the phone uses.

                    A framed box, but with no padding inside it: the border is
                    the edge and the rows start against it, so the filled row
                    runs the full width of the frame with no inset gutter. The
                    6px of padding that used to sit between border and row is
                    the gap that made the box look twice as wide as its
                    contents. `border` rather than `border-b` here — the base
                    sets a bottom-only rule for the phone panel, and both agree
                    on the bottom edge, so no override is needed. */}
                <motion.div
                  key="menu-panel"
                  id="primary-menu"
                  ref={panelRef}
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10, transition: { duration: 0.12 } }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute inset-x-0 top-full z-20 mt-1.5 bg-brand-bg border-b border-brand-border pointer-events-auto
                    md:left-auto md:right-12 md:border"
                >
                  {/* One column, five rows — at every width: the four
                      destinations, then settings. Settings is an action rather
                      than a place, so it takes the same row as everything else
                      instead of a box of its own; the menu is the only way in
                      to it now, which is why there is a single control in the
                      nav at every width.

                      Each row is label-left, hint-right. The hint is the row's
                      own Option digit from md up, where there is a keyboard to
                      press it on; below md a phone has no Alt key, so it gets
                      an arrow instead — a key chord there would be a shortcut
                      nobody on that screen can take. Both occupy the same slot
                      so the labels line up down the column either way.

                      Rows are separated by hairlines rather than boxed: with a
                      label on the left and a hint on the right, a border around
                      every row drew a box inside a box.

                      The rules hang off a wrapper per row, not off the row. A
                      border colour on the row itself loses — `tab`/`primary`
                      both set `border-transparent`, and utility order (not class
                      order) decides, so it renders invisible. `divide-y` on the
                      column does not help either: Tailwind v4 nests it in
                      `:where()`, which contributes no specificity at all, so
                      `divide-brand-border` ties with `border-transparent` and
                      loses on source order. A wrapper has no competing
                      declaration. The rows keep their transparent 1px border so
                      nothing changes size when one is selected. */}
                  <div className="flex flex-col px-6 pb-6 pt-1 md:w-max md:min-w-[17rem] md:p-0">
                    {TABS.map((tab, i) => {
                      const isActive = activeTab === tab.id;
                      return (
                        <div key={tab.id} className={i > 0 ? "border-t border-brand-border" : undefined}>
                          <Buttons
                            ref={i === 0 ? firstItemRef : undefined}
                            variant={isActive ? "primary" : "tab"}
                            onClick={() => setActiveTab(tab.id)}
                            aria-current={isActive ? "page" : undefined}
                            className="w-full py-3.5 text-left md:px-5 flex items-center justify-between gap-4"
                          >
                            <span className="truncate min-w-0">{tab.label}</span>
                            <MenuHint digit={String(i + 1)} />
                          </Buttons>
                        </div>
                      );
                    })}
                    <div className="border-t border-brand-border">
                      <Buttons
                        variant="tab"
                        onClick={() => {
                          setMenuOpen(false);
                          setSettingsOpen(true);
                        }}
                        className="w-full py-3.5 text-left md:px-5 flex items-center justify-between gap-4"
                      >
                        <span className="truncate min-w-0">SETTINGS</span>
                        <MenuHint digit="," />
                      </Buttons>
                    </div>
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>

          {/* Above the phone scrim (z-10 inside this nav) so the toggle stays
              crisp and readable while the menu is open. The filled accent
              square is the only control here: the keyboard cheat sheet used to
              sit beside it as a keycap, but a nav slot is the wrong home for a
              reference list — it reads as decoration and it is invisible on
              phones, which is the one size with the least room for it. It now
              lives in Settings, next to the shortcut-hint switch it belongs
              with. */}
          <div className="relative z-20 flex items-center gap-1.5 pointer-events-auto">
            <Buttons
              ref={menuButtonRef}
              variant="icon"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-controls="primary-menu"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              title={menuOpen ? "Close menu" : "Open menu"}
              /* 46px on touch — the only navigation control a phone has, kept
                 above the 44px touch minimum. Tailwind's scale has no 13px
                 step, so the two options either side of that floor are 42px
                 (p-3) and 46px (p-3.5), and only one of them clears it. md+ is
                 pointer-driven, where the target does not have to clear
                 anything, so that is where the button gets smaller: 38px. */
              className="p-3.5 md:p-2.5"
            >
              {menuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </Buttons>
          </div>
        </nav>
        <GameDetailsModal />
        <AddGameModal />
        <SettingsModal />
        <ShortcutsModal />
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
