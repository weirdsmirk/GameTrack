import { useEffect, useMemo, useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { useGameTrackStore } from "./store";
import { TABS } from "./tabs";
import { resolveShortcutAction } from "./shortcuts";
import Toast from "./components/Toast";
import NotFoundView from "./components/NotFoundView";
import DashboardView from "./components/DashboardView";
import AnalyticsView from "./components/AnalyticsView";
import LibraryView from "./components/LibraryView";
import DiscoverView from "./components/DiscoverView";
import WishlistView from "./components/WishlistView";
import SettingsModal from "./components/SettingsModal";
import ShortcutsModal from "./components/ShortcutsModal";
import GameDetailsModal from "./components/GameDetailsModal";
import AddGameModal from "./components/AddGameModal";
import { ActivePlayingConflictModal } from "./components/ActivePlayingConflictModal";
import { Menu, X, Settings as SettingsIcon } from "lucide-react";
import PageLoader from "./components/PageLoader";
import { Buttons } from "./components/Buttons";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { preloadImages } from "./utils/image";
import { Spinner } from "./components/Spinner";
import AppFooter from "./components/AppFooter";
import { getLegalDoc, LegalView } from "./components/LegalView";

/** Longest the page gate will hold a view back waiting for its covers. */
const GATE_MAX_WAIT_MS = 2500;

export default function App() {
  /* useShallow, not a bare `useGameTrackStore()`. Subscribing to the whole store
     meant every write re-rendered App and therefore the entire tree plus all six
     modals — including on every toast push and dismiss, every trending append,
     and every debounced filter keystroke. `React.memo` on the views could not
     help, because the subscription itself had changed. Each call site now gets
     exactly the fields it reads, and useShallow keeps the returned object
     referentially stable so this does not reintroduce the same problem with a
     fresh object on every store write. */
  const {
    activeTab, setActiveTab, fetchGames, fetchAnalytics,
    fetchTrending, fetchDiscoverLists,
    setSettingsOpen, setShortcutsOpen, fetchSteamSettings, scheduleAutoSteamSync,
    fetchWishlist, fetchCustomPlatforms,
    loadingGames,
    fetchCustomizations,
    showToast,
    customizations, updateCustomizations,
    games, loadingAnalytics, loadingWishlist, loadingLists, loadingDiscover,
    trendingSettled,
    trendingGames, discoverSearchResults, discoverQuery, wishlist,
  } = useGameTrackStore(useShallow((s) => ({
    activeTab: s.activeTab, setActiveTab: s.setActiveTab, fetchGames: s.fetchGames,
    fetchAnalytics: s.fetchAnalytics, fetchTrending: s.fetchTrending,
    fetchDiscoverLists: s.fetchDiscoverLists, setSettingsOpen: s.setSettingsOpen,
    setShortcutsOpen: s.setShortcutsOpen, fetchSteamSettings: s.fetchSteamSettings,
    scheduleAutoSteamSync: s.scheduleAutoSteamSync,
    fetchWishlist: s.fetchWishlist, fetchCustomPlatforms: s.fetchCustomPlatforms,
    loadingGames: s.loadingGames, fetchCustomizations: s.fetchCustomizations,
    showToast: s.showToast, customizations: s.customizations,
    updateCustomizations: s.updateCustomizations, games: s.games,
    loadingAnalytics: s.loadingAnalytics, loadingWishlist: s.loadingWishlist,
    loadingLists: s.loadingLists, loadingDiscover: s.loadingDiscover,
    trendingSettled: s.trendingSettled,
    trendingGames: s.trendingGames, discoverSearchResults: s.discoverSearchResults,
    discoverQuery: s.discoverQuery, wishlist: s.wishlist,
  })));
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
    /* The Steam identity is a precondition for the automatic sync, so the
       scheduler runs off the back of this fetch rather than racing it. Not
       awaited: the boot sequence should not block on a settings round-trip, and
       a failed fetch leaves `steamSettings` null, which is precisely the state
       that makes the scheduler decline — so the failure mode is silence, not a
       sync that cannot work. */
    void fetchSteamSettings().then(() => scheduleAutoSteamSync());
    fetchAnalytics();
    fetchWishlist();
    fetchCustomPlatforms();
    fetchCustomizations();
    if (s.trendingGames.length === 0 || Date.now() - s.lastTrendingFetch > 300_000) fetchTrending();
    if (!s.discoverLists || Date.now() - s.lastListsFetch > 300_000) fetchDiscoverLists();
    // Intentionally mount-only, with the dep list deliberately omitted: every
    // call above is read from getState() rather than from a dep, and adding
    // them would re-run this effect on each write it triggers — a fetch loop.
    // (This was an `eslint-disable-next-line react-hooks/exhaustive-deps`;
    // there is no ESLint in this project, so the comment was only ever
    // documentation pretending to be a directive. `npm run lint` was a
    // duplicate of `typecheck` and has been removed.)
  }, []);

  useEffect(() => {
    let chord: string | null = null;
    let chordTimer: ReturnType<typeof setTimeout> | null = null;

    const typing = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    };

    /* Navigation shortcuts are suppressed while any overlay is up.

       `setActiveTab` clears `selectedGame`, so an Option+digit pressed with the
       details modal open closed it — discarding unsaved metadata edits with no
       warning and no undo. `/` was worse: it closed the modal *and* moved focus
       into the library search box behind it. Toggling Settings was also
       stacking a second dialog over the first, and since both register their own
       window-level Escape handler, one keypress then closed both.

       `typing()` only excludes form fields, so it does not catch any of this —
       the keystroke lands on the document, not on an input. */
    const overlayOpen = () => {
      const s = useGameTrackStore.getState();
      return Boolean(
        s.selectedGame ||
        s.isAddGameOpen ||
        s.isSettingsOpen ||
        s.isShortcutsOpen ||
        s.playingConflict
      );
    };

    const onKey = (e: KeyboardEvent) => {
      const store = useGameTrackStore.getState();

      // Rebindable shortcuts: Option plus a key, resolved from the binding map
      // rather than a hardcoded digit. Every action is one lookup, so adding a
      // destination or changing a default does not touch this handler. Matched
      // by physical `code` for the reason in `shortcuts.ts` — Option rewrites
      // `key`, so Option+1 reports "¡" on a US layout — and the modifiers are
      // excluded explicitly so a user's Ctrl+Alt+digit is left to the browser.
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && !typing(e.target) && !overlayOpen()) {
        const action = resolveShortcutAction(store.shortcuts, e.code);
        if (action) {
          e.preventDefault();
          if (action === "settings") {
            store.setSettingsOpen(!store.isSettingsOpen);
          } else {
            store.setActiveTab(action);
          }
          return;
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" && !typing(e.target) && !overlayOpen()) {
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
        /* "Settled", not "non-empty" and not "no more pages".

           This used to require `trendingGames.length > 0`, which made an empty
           result indistinguishable from a request still in flight — so the gate
           never released and DiscoverView's error panel and empty state were
           unreachable. Two ordinary situations land there: IGDB credentials are
           OPTIONAL in this app, so a fresh install with none configured settles on
           an empty feed, and a failed request settles empty too.

           The attempted fix — `!hasMoreTrending` — was wrong in a way that made
           it worse, because `hasMoreTrending` means "is there another page", not
           "did the request finish". It is `true` before the first request and is
           only ever cleared by a request that SUCCEEDS with a short or empty page,
           so a 429, a network error or an abort all left it `true` and the gate
           shut again — silently, since the view holding the error message was the
           thing never rendered.

           `trendingSettled` is set by every terminal path of `fetchTrending`:
           success, empty, throttled, and failed. */
        return !loadingLists && !loadingDiscover && trendingSettled;
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
        {/* Skip link. Without it, a keyboard user starts at the top of <main>
            and has to tab through every focusable element in the current view
            (~45 on a populated Library) to reach the menu button, because the
            nav is rendered after <main> in the DOM. It is the first focusable
            thing on the page and normally invisible; it only paints when
            focused. `-translate-y-full` plus `focus:translate-y-0` rather than
            `sr-only`, because sr-only keeps the element at a 1px clip and a
            focused skip link has to be visible to be useful. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[200] focus:px-4 focus:py-2.5 focus:bg-brand-accent focus:text-brand-accent-ink focus:font-black focus:text-[11px] focus:uppercase focus:tracking-widest focus:outline-none focus:ring-2 focus:ring-white"
        >
          Skip to content
        </a>

        {/* No ambient glow behind the app. Two 150px-blurred accent blobs at 4%
            and 2% used to sit here, `fixed` and behind everything; at that
            radius they are not decoration but a wash over the whole page, and
            the background is meant to be one flat `brand-bg` like the rest of
            the language. The page now has one background colour, not a
            gradient that happens to average out to it. */}

        {/* Main workspace — full width, top navigation. The nav bar is hidden
            over the hero, so content keeps its original top offset and the
            title owns the top of the screen until the bar slides in. */}
        {/* tabIndex={-1} so the skip link's target can actually receive focus.
            A fragment target without it is scroll-only: the browser moves the
            viewport but sequential focus still resumes from the link, so the
            skip link would appear not to work. The class drops the focus ring
            the default outline would otherwise draw around the whole pane. */}
        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="flex-1 flex flex-col min-w-0 min-h-0 bg-brand-bg overflow-y-auto scroll-smooth antialiased focus:outline-none"
        >
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

            `items-start`, not `items-center`, and that is deliberate: the panel
            is taller than the toggle, so centring the row would re-centre the
            toggle whenever the panel mounted and drop it 4px — the whole
            cluster visibly settling on click. Anchoring both to the row's top
            edge means the toggle's position cannot depend on the panel at all,
            so no change to the panel's height or content can move it again. */}
        <nav
          ref={navRef}
          aria-label="Primary"
          className="fixed inset-x-0 top-0 z-40 flex justify-end items-start gap-2 px-6 md:px-12 pt-8 md:pt-10 pointer-events-none"
        >
          {/* Menu — one component, two shapes. On a phone it is a full-width
              panel hanging off the nav's bottom edge, because a column of four
              labels has nowhere to go at 390px; it is absolutely positioned, so
              it never takes part in the nav's layout and cannot push the toggle
              around.

              From md up the panel stops being positioned at all and becomes an
              ordinary flex item of the nav, sitting immediately before the
              toggle in DOM order. The row above it is `justify-end`, so the pair
              is pushed to the right edge and the menu lands directly left of the
              control, level with it. Placing it with the flex row rather than
              with an offset is the point: an earlier version anchored it to
              `left-12` to mirror the nav's gutter, which put it at the far left
              of the screen on top of the page title, and the fix for that was
              not a different magic number but letting the row do the placing.
              Nothing here has to know how wide the toggle is. */}
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
                {/* The panel itself. `absolute` with `inset-x-0` and `top-full`
                    is the phone shape: full-bleed, hanging off the nav's bottom
                    edge. `md:static` releases both, which puts the panel back
                    into the nav's flex row as a normal item — so it is placed
                    by the row (right-aligned, immediately left of the toggle,
                    vertically centred by `md:items-center`) rather than by an
                    offset that would have to hardcode the toggle's width.
                    `md:mt-0` drops the phone's gap under the nav edge. The
                    nav's `gap-2` is the gap between the two on desktop, and
                    inert on a phone where the panel is out of flow.

                    A framed box, but with no padding inside it: the border is
                    the edge and the items start against it, so the filled item
                    runs the full height or width of the frame with no inset
                    gutter. The 6px of padding that used to sit between border
                    and item is the gap that made the box look twice as wide as
                    its contents. `border` rather than `border-b` here — the base
                    sets a bottom-only rule for the phone panel, and both agree
                    on the bottom edge, so no override is needed.

                    The entrance follows the axis the panel actually sits on: a
                    short slide down on a phone, where it hangs below the nav,
                    and a short slide in from the right on desktop, where it
                    unfolds out of the toggle beside it. The old unconditional
                    `y: -10` was correct for the popover-below shape and read as
                    the whole cluster settling once the panel moved onto the
                    toggle's line. */}
                {/* The top and bottom rules are pseudo-elements from md up, so
                    they are drawn on the panel's edges without consuming any of
                    its height. As real borders they cost 1px each, which left
                    every cell 36px inside a 38px panel — two short of the 38px
                    toggle beside it, and no amount of padding arithmetic could
                    close that, because the height was being spent on the frame
                    rather than the content. `md:border-l` is a real border: it
                    costs width, which the row has plenty of.

                    `md:border-l` and not `md:border-x`, deliberately. The
                    settings box at the end of the row carries its own 1px frame
                    on all four sides, so a right border here would sit
                    immediately beside the box's own right edge and the two read
                    as a single 2px stroke. Letting the box's right border be the
                    panel's right edge makes the outermost line one border instead
                    of two, and the box still closes on all four sides because
                    nothing else draws that edge.

                    `md:relative` is the only positioning here from md up, and it
                    has to be the only one: the rules are absolutely positioned
                    and need this box as their containing block. An earlier
                    `md:static` survived alongside it, and with two position
                    utilities on one element the winner is whichever the
                    stylesheet happens to list later — not the one written later
                    — so the rules anchored to the nav and were drawn nowhere near
                    the panel. `relative` also leaves the panel a flex item,
                    which is all `static` was ever needed for.

                    This note lives out here, not inside the `className` string
                    above. A C-style block comment written between the
                    attribute's quotes is not a comment — it is literal text in
                    the class list, and every word of it is a candidate class
                    name. One of these paragraphs contains a bare "border", so the
                    panel silently grew a 1px frame on all four sides: a phantom
                    top and right edge, a panel one pixel too tall, and a right
                    edge that read as 2px where it met the settings box. */}
                <motion.div
                  key="menu-panel"
                  id="primary-menu"
                  ref={panelRef}
                  initial={{ opacity: 0, ...(hasKeyboard ? { x: 10 } : { y: -10 }) }}
                  animate={{ opacity: 1, x: 0, y: 0 }}
                  exit={{ opacity: 0, ...(hasKeyboard ? { x: 10 } : { y: -10 }), transition: { duration: 0.12 } }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute inset-x-0 top-full z-20 mt-1.5 bg-brand-bg border-b border-brand-border pointer-events-auto
                    md:mt-0 md:shrink-0 md:relative md:border-l md:border-b-0
                    md:before:absolute md:before:inset-x-0 md:before:top-0 md:before:h-px md:before:bg-brand-border md:before:content-['']
                    md:after:absolute md:after:inset-x-0 md:after:bottom-0 md:after:h-px md:after:bg-brand-border md:after:content-['']"
                >
                  {/* Five items, four destinations then settings. Settings is an
                      action rather than a place, so it takes the same slot as
                      everything else instead of a box of its own; the menu is the
                      only way in to it now, which is why there is a single
                      control in the nav at every width.

                      A single column on a phone, one horizontal row from md up.
                      The split is the same breakpoint the panel itself uses to
                      stop being full-bleed, because it is the same reason: below
                      md a column is the only shape that fits, and from md up
                      there is a pointer and room for a row. `md:flex-row` turns
                      the same five children into the row, so the items and their
                      order are defined once and only the axis changes.

                      `md:w-max` lets the row size to its contents instead of
                      stretching to the panel's width, and the buttons drop to
                      `md:w-auto` to match — left as `w-full` inside a `w-max`
                      row, each item would resolve its width against the row's
                      own max-content width and the sizing would be circular.

                      Each item is label-left, hint-right. The hint is the item's
                      own Option digit from md up, where there is a keyboard to
                      press it on; below md a phone has no Alt key, so it gets
                      an arrow instead — a key chord there would be a shortcut
                      nobody on that screen can take. Both occupy the same slot
                      so the labels line up either way.

                      Items are separated by hairlines rather than boxed: with a
                      label on the left and a hint on the right, a border around
                      every item drew a box inside a box. The rule follows the
                      axis — `border-t` down the phone column, `md:border-l` along
                      the row, with the horizontal half cancelled so the two
                      never compound into a double line at the corner.

                      The rules hang off a wrapper per item, not off the item. A
                      border colour on the button itself loses — `tab`/`primary`
                      both set `border-transparent`, and utility order (not class
                      order) decides, so it renders invisible. `divide-y` on the
                      column does not help either: Tailwind v4 nests it in
                      `:where()`, which contributes no specificity at all, so
                      `divide-brand-border` ties with `border-transparent` and
                      loses on source order. A wrapper has no competing
                      declaration. The buttons keep their transparent 1px border
                      so nothing changes size when one is selected. */}
                  <div className="flex flex-col px-6 pb-6 pt-1 md:flex-row md:w-max md:p-0">
                    {TABS.map((tab, i) => {
                      const isActive = activeTab === tab.id;
                      return (
                        <div
                          key={tab.id}
                          className={i > 0 ? "border-t border-brand-border md:border-t-0 md:border-l" : undefined}
                        >
                          <Buttons
                            ref={i === 0 ? firstItemRef : undefined}
                            variant={isActive ? "primary" : "tab"}
                            onClick={() => setActiveTab(tab.id)}
                            aria-current={isActive ? "page" : undefined}
                            className="w-full md:w-auto py-3.5 md:h-[38px] text-left md:px-5 flex items-center justify-center md:justify-start whitespace-nowrap"
                          >
                            <span className="truncate min-w-0">{tab.label}</span>
                          </Buttons>
                        </div>
                      );
                    })}
                    {/* Settings as a glyph in a square box of its own. It is the
                        one item in the row that is an action and not a
                        destination, and as a word it set the row's rhythm and
                        made the four destinations look like equal-weight choices
                        when one of them is not. A boxed gear says the same thing
                        in a fraction of the width, and the row reads as four
                        places plus a control.

                        The box is on this wrapper, not on the button, for the
                        same reason the row's rules are: `tab` and `primary` both
                        set `border-transparent`, and utility order rather than
                        class order decides, so a border colour on the button
                        itself renders invisible. The wrapper has no competing
                        declaration.

                        Sized `w-[38px] h-[38px]` — the same 38px as the cells
                        and as the toggle, so the box is flush with them on all
                        three sides and is genuinely square rather than only
                        roughly so. It carries no horizontal margin: the earlier
                        `md:mx-1` opened a gap that read as an empty column
                        between the gear and the panel's edge, which looked like a
                        fifth, empty item in the row.

                        The wrapper carries the width because the button inside it
                        is `w-full` in the base variant: sizing the button instead
                        would be circular against the wrapper's own auto width,
                        and it collapses to a few pixels. It keeps the same
                        `py-3.5` the text cells have, because on a phone the box
                        is neither square nor sized and without that padding the
                        glyph would be the entire row height. Note the wrapper
                        keeps `border-t` on desktop rather than cancelling it the
                        way the row's rules do: `md:border` here is all four sides
                        at once, and a `md:border-t-0` would win on source order
                        and take the top edge off the box.

                        `aria-label` carries the name, since the visible text is
                        gone; the icon is `aria-hidden`, so the accessible name
                        is the label and not the SVG's contents. */}
                    <div className="border-t border-brand-border md:w-[38px] md:h-[38px] md:border flex items-center justify-center">
                      <Buttons
                        variant="tab"
                        onClick={() => {
                          setMenuOpen(false);
                          setSettingsOpen(true);
                        }}
                        aria-label="Settings"
                        title="Settings"
                        className="w-full h-full py-3.5 md:py-0 flex items-center justify-center"
                      >
                        <SettingsIcon className="w-[18px] h-[18px]" aria-hidden />
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
