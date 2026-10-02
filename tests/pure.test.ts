import { describe, it, expect } from "vitest";
import { mapIgdbGame, getIgdbImageUrl, upgradeIgdbPosterUrl } from "../server/igdb";
import { isNonGameApp } from "../server/steam";
import { normalizePlatformIds, isOwned, platformsSelectable, mergePlatformTags, replayAllowed } from "../src/constants";
import { upgradeIgdbPosterUrl as clientUpgrade } from "../src/utils/image";
import { formatDateShort, toLocalISODate } from "../src/utils/time";

describe("mapIgdbGame", () => {
  it("emits the highest-quality WebP cover preset", () => {
    const mapped = mapIgdbGame({ id: 1, name: "Test", cover: { image_id: "co1q1f" } });
    expect(mapped.poster_url).toBe(
      "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1q1f.webp"
    );
  });

  it("returns null poster without a cover", () => {
    expect(mapIgdbGame({ id: 2, name: "No Art" }).poster_url).toBeNull();
  });

  it("derives the year in UTC", () => {
    // 2024-01-01T00:30:00Z — local-timezone getFullYear could say 2023.
    const mapped = mapIgdbGame({ id: 3, name: "NYE", first_release_date: 1704069000 });
    expect(mapped.year).toBe(2024);
  });
});

describe("getIgdbImageUrl", () => {
  it("defaults to the retina cover preset in WebP", () => {
    expect(getIgdbImageUrl("co1q1f")).toMatch(/t_cover_big_2x\/co1q1f\.webp$/);
  });

  it("returns null for missing ids", () => {
    expect(getIgdbImageUrl(undefined)).toBeNull();
    expect(getIgdbImageUrl(null)).toBeNull();
  });
});

describe.each([
  ["server", upgradeIgdbPosterUrl],
  ["client", clientUpgrade],
] as const)("upgradeIgdbPosterUrl (%s)", (_label, upgrade) => {
  it("upgrades legacy jpg covers to retina WebP", () => {
    expect(
      upgrade("https://images.igdb.com/igdb/image/upload/t_cover_big/co1q1f.jpg")
    ).toBe("https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1q1f.webp");
  });

  it("is idempotent for already-upgraded URLs", () => {
    const url = "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1q1f.webp";
    expect(upgrade(url)).toBe(url);
  });

  it("leaves Steam CDN and local uploads untouched", () => {
    const steam = "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/10/library_600x900.jpg";
    const local = "/posters/123-abc.jpg";
    expect(upgrade(steam)).toBe(steam);
    expect(upgrade(local)).toBe(local);
  });

  it("passes through nullish input", () => {
    expect(upgrade(null)).toBeNull();
    expect(upgrade(undefined)).toBeUndefined();
  });
});

describe("isNonGameApp", () => {
  it("flags known software and benchmarks", () => {
    expect(isNonGameApp(431960, "Wallpaper Engine")).toBe(true);
    expect(isNonGameApp(999999, "3DMark Demo")).toBe(true);
  });

  it("keeps real games", () => {
    expect(isNonGameApp(10, "Counter-Strike")).toBe(false);
  });

  it("flags software-typed store entries", () => {
    expect(isNonGameApp(1, "Some Tool", { type: "tool" })).toBe(true);
    expect(isNonGameApp(2, "Real Game", { type: "game" })).toBe(false);
  });
});

describe("normalizePlatformIds", () => {
  it("canonicalizes aliases and drops unknowns", () => {
    expect(normalizePlatformIds(["Steam", "  PC  ", "bogus-platform"])).toContain("steam");
  });

  it("tolerates nullish input", () => {
    expect(normalizePlatformIds(null)).toEqual([]);
    expect(normalizePlatformIds(undefined)).toEqual([]);
  });
});

describe("ownership predicates", () => {
  it("reads a missing or unrecognised flag as owned", () => {
    // Payloads can predate the flag: a cached analytics response in
    // localStorage, a JSON backup written before the migration. Defaulting those
    // to "not owned" would quietly move part of an existing library into the
    // wrong bucket on read, so absence has to mean the older, wider state.
    expect(isOwned({})).toBe(true);
    expect(isOwned({ ownership_status: null })).toBe(true);
    expect(isOwned({ ownership_status: "owned" })).toBe(true);
    expect(isOwned({ ownership_status: "borrowed" })).toBe(true);
    expect(isOwned({ ownership_status: "not_owned" })).toBe(false);
  });

  it("locks the platform controls for a not-owned game only", () => {
    // A platform is a copy in the user's own collection. Marking a game not
    // owned has to close that control, and only that control — every other part
    // of the record stays editable.
    expect(platformsSelectable("owned")).toBe(true);
    expect(platformsSelectable("not_owned")).toBe(false);
  });
});

// Every date the app shows a person goes through this one function, so the
// format is pinned here rather than trusted to four call sites. The old
// implementation used toLocaleDateString, which made the output depend on the
// machine's locale — the same library read 07/13/26 in one place and 13/07/26 in
// another, and those two are ambiguous against each other.
describe("formatDateShort", () => {
  // Built from local getters, so a local Date avoids any UTC-shifting that
  // would make these assertions depend on the machine's timezone.
  it("prints DD/MM/YY", () => {
    expect(formatDateShort(new Date(2026, 6, 13))).toBe("13/07/26");
  });

  it("zero-pads single digits so a column of dates aligns", () => {
    expect(formatDateShort(new Date(2026, 0, 9))).toBe("09/01/26");
    expect(formatDateShort(new Date(2026, 10, 1))).toBe("01/11/26");
  });

  it("puts the day first, not the month", () => {
    // 03/04 is 3 April in DD/MM and would be 4 March in the US order. The day
    // is 3 and the month is 4, so only one of the two orders can be right.
    expect(formatDateShort(new Date(2026, 3, 3))).toBe("03/04/26");
  });

  it("accepts a timestamp as well as a Date", () => {
    const d = new Date(2026, 6, 13);
    expect(formatDateShort(d.getTime())).toBe("13/07/26");
  });

  it("returns an em dash rather than a wrong date for missing input", () => {
    expect(formatDateShort(null)).toBe("—");
    expect(formatDateShort(undefined)).toBe("—");
    expect(formatDateShort(new Date("not a date"))).toBe("—");
  });

  it("does not roll a pre-2000 year into a two-digit year", () => {
    // %y would render 1999 as "99", which reads as 2099. Anything outside the
    // 2000-2099 window falls back to the full year.
    expect(formatDateShort(new Date(1999, 5, 4))).toBe("04/06/1999");
  });
});

describe("toLocalISODate", () => {
  /* Every user-entered date in this app is stored at LOCAL midnight, so
     formatting one with toISOString() shifts it a day earlier for anyone west of
     Greenwich. That is what the CSV/Markdown exports used to do to every
     completion date they printed. */
  const localMidnight = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

  it("formats a local-midnight timestamp as the same calendar day", () => {
    expect(toLocalISODate(localMidnight(2026, 9, 16))).toBe("2026-09-16");
    expect(toLocalISODate(localMidnight(2026, 1, 1))).toBe("2026-01-01");
    expect(toLocalISODate(localMidnight(2026, 12, 31))).toBe("2026-12-31");
  });

  it("zero-pads rather than emitting a bare month or day", () => {
    expect(toLocalISODate(localMidnight(2026, 3, 7))).toBe("2026-03-07");
  });

  it("agrees with toISOString only when the local offset is not behind UTC", () => {
    // Stated as a property rather than a fixed offset, because the suite must not
    // depend on the machine's timezone: whatever the offset, the LOCAL reading is
    // the one that matches the date the user typed.
    const ms = localMidnight(2026, 9, 16);
    const iso = new Date(ms).toISOString().slice(0, 10);
    const local = toLocalISODate(ms);
    const offsetMinutes = new Date(ms).getTimezoneOffset();
    if (offsetMinutes > 0) {
      // West of UTC: toISOString would have gone back a day.
      expect(iso).not.toBe(local);
    }
    expect(local).toBe("2026-09-16");
  });

  it("returns an empty string for an unparseable value rather than 'Invalid Date'", () => {
    expect(toLocalISODate(Number.NaN)).toBe("");
  });
});

describe("mergePlatformTags", () => {
  /* The Steam sync used to REPLACE this column with its own constant ["steam"],
     which silently dropped every other tag — a PlayStation copy lost its tag, and
     custom tags were destroyed permanently — on an operation the user never
     explicitly ran. This is the additive rule every such writer must use. */
  it("keeps existing tags and adds only what is new", () => {
    expect(mergePlatformTags(["playstation"], ["steam"]).sort())
      .toEqual(["playstation", "steam"]);
  });

  it("does not duplicate a tag present on both sides", () => {
    expect(mergePlatformTags(["steam"], ["steam"])).toEqual(["steam"]);
  });

  it("normalises aliases so 'PC' and 'pc' collapse instead of accumulating", () => {
    expect(mergePlatformTags(["pc"], ["PC"])).toHaveLength(1);
  });

  it("tolerates either side being absent", () => {
    expect(mergePlatformTags(null, ["steam"])).toEqual(["steam"]);
    expect(mergePlatformTags(["steam"], undefined)).toEqual(["steam"]);
    expect(mergePlatformTags(null, undefined)).toEqual([]);
  });
});

describe("replayAllowed", () => {
  /* `endless` is excluded because an endless title is one unbroken stretch of
     playtime, not a set of discrete runs — so "which playthrough was that?" has
     no answer, and splitting it into runs invents detail that then feeds the
     replay badge, the analytics run count and the per-run breakdown. */
  it("refuses endless titles", () => {
    expect(replayAllowed("endless")).toBe(false);
  });

  it("permits every other status", () => {
    for (const status of ["backlog", "playing", "completed"]) {
      expect(replayAllowed(status), status).toBe(true);
    }
  });

  it("treats a missing status as permitted rather than silently blocking", () => {
    // A payload predating the status field should not lose the feature. Every row
    // has had a status since v1, but the reader is shared with partial objects and
    // defaulting to `false` here would hide the control for no stated reason.
    expect(replayAllowed(undefined)).toBe(true);
    expect(replayAllowed(null)).toBe(true);
    expect(replayAllowed("")).toBe(true);
  });

  it("is independent of how many times a game has been played", () => {
    // The rule is about the STATUS, not the count: a title already replayed three
    // times becoming endless is still one continuous run from here on.
    const endless = { status: "endless", times_played: 4 } as const;
    const completed = { status: "completed", times_played: 4 } as const;
    expect(replayAllowed(endless.status)).toBe(false);
    expect(replayAllowed(completed.status)).toBe(true);
  });
});
