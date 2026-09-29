import { describe, it, expect } from "vitest";
import { mapIgdbGame, getIgdbImageUrl, upgradeIgdbPosterUrl } from "../server/igdb";
import { isNonGameApp } from "../server/steam";
import { normalizePlatformIds } from "../src/constants";
import { upgradeIgdbPosterUrl as clientUpgrade } from "../src/utils/image";
import { formatDateShort } from "../src/utils/time";

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
