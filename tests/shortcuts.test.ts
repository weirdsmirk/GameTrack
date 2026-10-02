/**
 * Pure-function tests for the client helpers the README advertises but nothing
 * covered: CSV/Markdown export and shortcut binding resolution.
 *
 * `csvEscape` in particular is the only place in the app that guards against
 * spreadsheet formula injection, and a bug there silently corrupts a user's
 * exported data file — which they would not discover until opening it in Excel.
 */
import { describe, it, expect } from "vitest";
import { csvEscape, gamesToCsv, gamesToMarkdown } from "../src/utils/export";
import {
  normaliseBindings,
  codeToLabel,
  resolveShortcutAction,
  isRebound,
  bindingKeys,
} from "../src/shortcuts";
import { SHORTCUT_ACTIONS } from "../src/shortcuts";
import type { Game } from "../src/types";

const game = (over: Partial<Game> = {}): Game => ({
  id: 1, title: "Untitled", status: "backlog", playtime: 0, hide_playtime: 0,
  date_added: 0, date_completed: null, created_at: 0, updated_at: 0,
  genres: [], igdb_id: null, year: null, synopsis: "", poster_url: "",
  critic_score: null, owned_platforms: [], personal_rating: null,
  ownership_status: "owned",
  ...over,
});

describe("csvEscape", () => {
  it("neutralizes formula injection at the start of a cell", () => {
    // A title like "=CMD()" would otherwise be evaluated when the exported file
    // is opened in Excel or Sheets.
    expect(csvEscape("=1+1")).toBe("'=1+1");
    expect(csvEscape("+cmd")).toBe("'+cmd");
    expect(csvEscape("-2+3")).toBe("'-2+3");
    expect(csvEscape("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvEscape("\tlead")).toBe("'\tlead");
  });

  it("does not mangle ordinary text that merely contains those characters", () => {
    // The guard is anchored — "Half-Life" must not become "'Half-Life".
    expect(csvEscape("Half-Life")).toBe("Half-Life");
    expect(csvEscape("A+B")).toBe("A+B");
    expect(csvEscape("user@example.com")).toBe("user@example.com");
  });

  it("quotes and doubles embedded quotes", () => {
    expect(csvEscape('Say "hi"')).toBe('"Say ""hi"""');
  });

  it("quotes cells containing a comma, newline or carriage return", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
});

describe("gamesToCsv", () => {
  it("writes a header and one row per game", () => {
    const csv = gamesToCsv([
      game({ title: "Portal", status: "completed", owned_platforms: ["pc"], playtime: 12 }),
      game({ title: "Hades", status: "playing", owned_platforms: ["steam", "switch"] }),
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "title,status,ownership,platform,playtime,plays,replays,replay_playtime,rating,completion_date"
    );
    expect(lines[1]).toContain("Portal,completed,owned,pc");
    // Multi-platform tags are joined into one cell with a semicolon, not
    // repeated into extra columns. The separator is not the CSV comma, so
    // csvEscape does not need to quote it.
    expect(lines[2]).toContain("Hades,playing,owned,steam; switch");
  });

  it("carries the ownership flag as a distinct column", () => {
    // A game played at a friend's house exports as not_owned, so a spreadsheet
    // can tell it apart from a copy on the shelf — and the raw token round-trips
    // straight back into POST /api/import without a label-to-value mapping.
    const csv = gamesToCsv([
      game({ title: "Borrowed", status: "completed", ownership_status: "not_owned", owned_platforms: ["playstation"], playtime: 6 }),
    ]);
    expect(csv).toContain("Borrowed,completed,not_owned,playstation");
  });

  it("defaults a row with no flag to owned", () => {
    // A payload predating the flag has no ownership_status at all. It must
    // export as owned rather than as a blank cell, because every row in such a
    // payload was owned by definition.
    const legacy = { ...game({ title: "Legacy Row" }) } as Partial<Game> as Game;
    delete (legacy as { ownership_status?: string }).ownership_status;
    expect(gamesToCsv([legacy])).toContain("Legacy Row,backlog,owned,");
  });

  it("starts with a BOM so Excel opens UTF-8 correctly", () => {
    expect(gamesToCsv([game()]).charCodeAt(0)).toBe(0xfeff);
  });

  it("neutralizes a formula title", () => {
    // The leading apostrophe is the whole defence: a cell with no comma, quote
    // or newline needs no wrapping, so the guard's output is emitted verbatim.
    const csv = gamesToCsv([game({ title: "=cmd|'/c calc'!A0", status: "backlog" })]);
    expect(csv).toContain("'=cmd|'/c calc'!A0");
  });

  it("combines the formula guard with quoting when the value also needs it", () => {
    // A title that both starts with = and contains a comma: the guard runs
    // first, then the quoting pass, so the cell is wrapped *and* defused.
    const csv = gamesToCsv([game({ title: "=SUM(A1,B1), x", status: "backlog" })]);
    expect(csv).toContain("\"'=SUM(A1,B1), x\"");
  });
});

describe("gamesToMarkdown", () => {
  it("emits a table with escaped pipes", () => {
    const md = gamesToMarkdown([game({ title: "Super | Game", status: "completed", year: 2018 })]);
    expect(md).toContain("| Title | Status | Ownership | Platform | Playtime | Times Played | Replay Time | Rating | Completed |");
    // A raw pipe would end the cell early and shift every column after it.
    expect(md).toContain("Super \\| Game");
  });

  it("prints ownership as a readable label", () => {
    // The markdown table is read by a person, so it gets the display label
    // rather than the CSV's machine token — the same distinction `status`
    // already makes in both formats.
    const md = gamesToMarkdown([
      game({ title: "Mine", status: "completed" }),
      game({ title: "Played Only", status: "completed", ownership_status: "not_owned" }),
    ]);
    expect(md).toContain("| Mine | completed | Owned |");
    expect(md).toContain("| Played Only | completed | Not Owned |");
  });

  it("uses an em dash for a missing rating and completion date", () => {
    const md = gamesToMarkdown([game({ title: "Nothing Recorded", status: "backlog" })]);
    expect(md).toContain("| — | — |");
  });
});

describe("normaliseBindings", () => {
  it("rejects anything that is not an object", () => {
    expect(normaliseBindings(null)).toBeNull();
    expect(normaliseBindings("KeyQ")).toBeNull();
    expect(normaliseBindings(42)).toBeNull();
    expect(normaliseBindings([])).toBeNull();
  });

  it("keeps only known action ids", () => {
    const result = normaliseBindings({ "dashboard": "KeyQ", "not-a-real-action": "KeyW" });
    expect(result).not.toBeNull();
    expect(Object.keys(result!)).toEqual(["dashboard"]);
  });

  it("trims values and drops empty or non-string ones", () => {
    // A whitespace-only binding would otherwise become a shortcut that fires on
    // nothing but still occupies the row in the cheat sheet.
    const result = normaliseBindings({ "dashboard": "  KeyQ  ", "library": "   ", "discover": 7 });
    expect(result).toEqual({ "dashboard": "KeyQ" });
  });

  it("returns null when nothing survives validation", () => {
    expect(normaliseBindings({ "library": "  ", unknown: "KeyQ" })).toBeNull();
  });
});

describe("codeToLabel", () => {
  it("maps the punctuation codes the app can bind", () => {
    expect(codeToLabel("Comma")).toBe(",");
    expect(codeToLabel("Slash")).toBe("/");
    expect(codeToLabel("Quote")).toBe("'");
  });

  it("strips the Key/Digit/Numpad prefixes", () => {
    expect(codeToLabel("KeyQ")).toBe("Q");
    expect(codeToLabel("Digit4")).toBe("4");
    expect(codeToLabel("Numpad7")).toBe("7");
  });

  it("falls back to the code itself for anything unrecognised", () => {
    expect(codeToLabel("F13")).toBe("F13");
  });
});

describe("resolveShortcutAction", () => {
  it("resolves a default binding", () => {
    const action = SHORTCUT_ACTIONS[0]!;
    expect(resolveShortcutAction({}, action.defaultCode)).toBe(action.id);
  });

  it("lets an override win over a default bound to the same key", () => {
    const target = SHORTCUT_ACTIONS[0]!;
    // Bind the first action's default key to a different action.
    const other = SHORTCUT_ACTIONS[1]!;
    const result = resolveShortcutAction({ [other.id]: target.defaultCode }, target.defaultCode);
    expect(result).toBe(other.id);
  });

  it("returns null for a key nothing is bound to", () => {
    expect(resolveShortcutAction({}, "KeyF13")).toBeNull();
  });
});

describe("isRebound", () => {
  it("is false on a default and true on anything else", () => {
    const action = SHORTCUT_ACTIONS[0]!;
    expect(isRebound({}, action)).toBe(false);
    expect(isRebound({ [action.id]: action.defaultCode }, action)).toBe(false);
    expect(isRebound({ [action.id]: "KeyF9" }, action)).toBe(true);
  });
});

describe("bindingKeys", () => {
  it("always leads with ALT, as the app's shortcuts are all Option-based", () => {
    const action = SHORTCUT_ACTIONS[0]!;
    expect(bindingKeys(undefined, action)).toEqual(["ALT", codeToLabel(action.defaultCode)]);
    expect(bindingKeys("KeyJ", action)).toEqual(["ALT", "J"]);
  });
});
