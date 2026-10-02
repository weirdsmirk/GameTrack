/**
 * Keyboard shortcuts, as data.
 *
 * The bindings used to be hardcoded into the keydown handler in `App` and spelled
 * out again as a literal list in the cheat sheet. Those two copies could not see
 * each other, so they drifted: the handler's `G` chords and the `/` search were
 * added to one and forgotten in the other. This module is the single place a
 * binding is defined, and both the handler and the modal read it.
 *
 * A binding is a `KeyboardEvent.code`, not a `key` — the physical key, not the
 * character it currently produces. Option rewrites `key` (Option+1 reports `¡`
 * on a US layout, Option+, reports `≤`), so matching on `key` would make the
 * shortcuts depend on the user's keyboard layout. `code` is layout-independent,
 * and reading digits off `code` also covers the numpad without a second rule.
 */

const SHORTCUTS_STORAGE_KEY = "gametrack_shortcut_bindings";

/** The actions a user can rebind. Ids are stable; labels are for display only. */
export type ShortcutActionId =
  | "dashboard"
  | "discover"
  | "library"
  | "analytics"
  | "settings";

export interface ShortcutAction {
  id: ShortcutActionId;
  label: string;
  /** Shown under the row when it has been changed off its default. */
  defaultCode: string;
}

/**
 * The editable set: the four page jumps, in menu order, then settings. The
 * defaults are the Option digits, which is what the handler has always used —
 * the digits follow the menu position, so a page's shortcut cannot drift from
 * its place in the menu.
 */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: "dashboard", label: "CENTRAL", defaultCode: "Digit1" },
  { id: "discover", label: "DISCOVER", defaultCode: "Digit2" },
  { id: "library", label: "LIBRARY", defaultCode: "Digit3" },
  { id: "analytics", label: "ANALYTICS", defaultCode: "Digit4" },
  { id: "settings", label: "SETTINGS", defaultCode: "Comma" },
] as const;

export type ShortcutBindings = Partial<Record<ShortcutActionId, string>>;

/**
 * The fixed shortcuts — real, working keys that are not rebindable.
 *
 * `/` is a bare key with no modifier, and the two `G` chords are two-key
 * sequences typed in order. Both are a different interaction from "hold Option
 * and press a key", so offering them in the same rebind control would mean
 * either supporting sequence capture in one UI or quietly dropping the modifier
 * and the sequence. They are listed as read-only instead, so the sheet still
 * tells the truth about what the app responds to.
 */
export const FIXED_SHORTCUTS: readonly { keys: string[]; label: string }[] = [
  { keys: ["/"], label: "LIBRARY + SEARCH" },
  { keys: ["G", "L"], label: "LIBRARY" },
  { keys: ["G", "D"], label: "CENTRAL" },
] as const;

/**
 * Coerces whatever was in localStorage into a usable binding map. A stored map
 * is untrusted input: it may be from an older version, hand-edited, or from a
 * different set of actions. Unknown ids and non-strings are dropped, and a
 * binding is only accepted if it is a key the browser will actually report —
 * an empty or whitespace value would otherwise become a shortcut that fires on
 * nothing.
 */
export function normaliseBindings(raw: unknown): ShortcutBindings | null {
  if (!raw || typeof raw !== "object") return null;
  const out: ShortcutBindings = {};
  let count = 0;
  for (const action of SHORTCUT_ACTIONS) {
    const value = (raw as Record<string, unknown>)[action.id];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    out[action.id] = trimmed;
    count += 1;
  }
  return count > 0 ? out : null;
}

export function loadBindings(): ShortcutBindings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHORTCUTS_STORAGE_KEY) || "");
    return normaliseBindings(parsed) || {};
  } catch {
    return {};
  }
}

export function saveBindings(bindings: ShortcutBindings): void {
  try {
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // A full or disabled store is not worth failing the interaction over — the
    // binding still applies for this session.
  }
}

/**
 * Turns a `KeyboardEvent.code` into the cap the cheat sheet prints.
 *
 * Only the codes this app can actually bind are handled, plus the handful a
 * user is likely to reach for. Anything else falls through to the code's own
 * last segment with the `Key`/`Digit` prefix stripped, so an unusual key still
 * shows something legible instead of a blank cap — but a modifier key never
 * gets here (see `isBindable`), so there is no risk of printing "SHIFT" as if it
 * were the shortcut.
 */
export function codeToLabel(code: string): string {
  if (code === "Comma") return ",";
  if (code === "Period") return ".";
  if (code === "Slash") return "/";
  if (code === "Backslash") return "\\";
  if (code === "BracketLeft") return "[";
  if (code === "BracketRight") return "]";
  if (code === "Semicolon") return ";";
  if (code === "Quote") return "'";
  if (code === "Backquote") return "`";
  if (code === "Minus") return "-";
  if (code === "Equal") return "=";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return code.slice(6);
  return code;
}

/** The caps to print for a binding: always Option plus the key. */
export function bindingKeys(code: string | undefined, action: ShortcutAction): string[] {
  return ["ALT", codeToLabel(code || action.defaultCode)];
}

/**
 * The action a keypress triggers, or null if it triggers none.
 *
 * Two passes, overrides first. The comment this replaces claimed overrides
 * always win, but the single ordered scan could not deliver that: it resolved
 * `bindings[id] || defaultCode` per action in menu order, so a row earlier in
 * the list won any collision. Binding DISCOVER to Digit1 — CENTRAL's default —
 * meant ALT+1 still went to CENTRAL and the override silently did nothing.
 *
 * The two passes make the documented contract true regardless of menu order:
 * every explicit binding is consulted before any default, and a default only
 * fires for a code nobody has claimed. `setShortcut` in the store already
 * evicts a code from any other row when it is taken, so a collision is not
 * reachable through the UI — but `loadBindings` reads localStorage directly and
 * normalises field-by-field without de-duplicating, so a hand-edited or
 * pre-existing binding map could hold one, and the resolution has to be correct
 * on its own terms.
 */
export function resolveShortcutAction(
  bindings: ShortcutBindings,
  code: string
): ShortcutActionId | null {
  for (const action of SHORTCUT_ACTIONS) {
    if (bindings[action.id] === code) return action.id;
  }
  for (const action of SHORTCUT_ACTIONS) {
    if (bindings[action.id] === undefined && action.defaultCode === code) return action.id;
  }
  return null;
}

/** Whether an action is currently off its default, so the row can say so. */
export function isRebound(
  bindings: ShortcutBindings,
  action: ShortcutAction
): boolean {
  const code = bindings[action.id];
  return code !== undefined && code !== action.defaultCode;
}

/**
 * Whether a keypress can be recorded as a binding.
 *
 * Bare modifiers are rejected: a shortcut is Option plus a key, so capturing
 * Option on its own would produce a binding that fires on every other
 * Option press. Escape is rejected too, because it closes the modal and the
 * user needs a way out of capture mode that is not "bind Escape".
 */
export function isBindable(e: KeyboardEvent): boolean {
  if (["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock", "Escape"].includes(e.code)) {
    return false;
  }
  // A bare Tab would move focus out of the capture control mid-recording, and a
  // bare Space would scroll the sheet.
  if (e.code === "Tab" || e.code === "Space") return false;
  return true;
}
