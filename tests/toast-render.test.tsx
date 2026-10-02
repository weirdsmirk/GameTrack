// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { Toast } from "../src/components/Toast";
import { useGameTrackStore } from "../src/store";

/**
 * That `fill` overrides only the colour, and never the announcement.
 *
 * The store test proves a filled toast keeps its `type`. This proves the other
 * half: that the component resolves the fill as `fill ?? type`, so a filled toast
 * really does ask for Steam blue, and that the a11y wiring still reads `type` —
 * which is the whole reason the two channels exist. Collapse them into one and a
 * blue Steam failure stops being announced as a failure.
 *
 * Asserted on the class, not on `getComputedStyle`. jsdom does not load the
 * built Tailwind stylesheet, so every background computes to transparent and
 * would happily let a broken class pass. The rendered colour was confirmed
 * against a real browser instead: rgb(26, 159, 255) — Valve's #1A9FFF.
 */

const STEAM_BG = "bg-[#1A9FFF]";

const renderToasts = async () => {
  render(<Toast />);
  await waitFor(() => expect(document.querySelector('[role="status"],[role="alert"]')).toBeTruthy());
  return document.querySelector('[role="status"],[role="alert"]') as HTMLElement;
};

const set = (toast: { type: "success" | "error" | "info" | "warning"; fill?: "steam"; message: string }) =>
  useGameTrackStore.setState({ toasts: [{ id: 1, duration: 4000, ...toast }] } as never);

afterEach(cleanup);

describe("Toast fill rendering", () => {
  it("renders a filled Steam toast with the Steam blue fill and black ink", async () => {
    set({ type: "info", fill: "steam", message: "Steam sync in progress" });
    const el = await renderToasts();

    expect(el.className).toContain(STEAM_BG);
    expect(el.className).toContain("text-black");
  });

  it("still announces a filled Steam failure as an alert, assertively", async () => {
    set({ type: "error", fill: "steam", message: "Steam sync failed" });
    const el = await renderToasts();

    // Blue AND an alert. Both, not either — this is the pairing that makes the
    // split-channel design worth having.
    expect(el.className).toContain(STEAM_BG);
    expect(el.getAttribute("role")).toBe("alert");
    expect(el.getAttribute("aria-live")).toBe("assertive");
  });

  it("does not paint a filled error red", async () => {
    set({ type: "error", fill: "steam", message: "Steam sync failed" });
    const el = await renderToasts();
    expect(el.className).not.toContain("bg-red-600");
  });

  it("falls back to the type's own fill when no fill is set", async () => {
    set({ type: "error", message: "Failed to save updates" });
    const el = await renderToasts();

    expect(el.className).not.toContain(STEAM_BG);
    expect(el.className).toContain("bg-red-600");
    expect(el.getAttribute("role")).toBe("alert");
  });

  it("gives every Steam toast the same fill whatever its severity", async () => {
    const seen: string[] = [];
    for (const type of ["success", "error", "info", "warning"] as const) {
      cleanup();
      set({ type, fill: "steam", message: `Steam ${type}` });
      seen.push((await renderToasts()).className);
    }

    // One fill for the whole Steam surface — the actual requirement. Checked on
    // the background class alone, since the text colour is the same either way
    // and the severity type legitimately differs between them.
    const backgrounds = seen.map((c) => c.match(/bg-\S+/g)?.find((b) => !b.startsWith("bg-opacity")) ?? "");
    expect(new Set(backgrounds).size).toBe(1);
    expect(backgrounds[0]).toBe(STEAM_BG);
  });
});
