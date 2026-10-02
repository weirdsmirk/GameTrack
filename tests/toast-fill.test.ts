// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useGameTrackStore } from "../src/store";

/**
 * Every Steam toast wears Valve's brand blue, whatever else it is.
 *
 * The point being protected is that colour and severity are *separate channels*.
 * `type` picks the lifetime and decides whether a screen reader is interrupted
 * (`role="alert"`, assertive) or merely informed; `fill` only paints the box. If
 * Steam blue had been added to `type`, then either a failed Steam sync would go
 * back to red — losing the "all Steam activity looks the same" request — or it
 * would be declared `steam` and silently stop being announced as a failure at
 * all. The second is the one that bites.
 */

const toasts = () => useGameTrackStore.getState().toasts;
const show = (...args: Parameters<ReturnType<typeof useGameTrackStore.getState>["showToast"]>) =>
  useGameTrackStore.getState().showToast(...args);

beforeEach(() => {
  useGameTrackStore.setState({ toasts: [] } as never);
});

describe("toast fills", () => {
  it("leaves ordinary toasts unfilled, so `type` still decides their colour", () => {
    show("Game updated", "success", "All changes saved");
    expect(toasts().map((t) => t.fill)).toEqual([undefined]);
  });

  it("paints a Steam toast blue while keeping it informational", () => {
    show("Steam sync in progress", "info", undefined, 5000, undefined, "steam");
    expect(toasts().map((t) => [t.type, t.fill])).toEqual([["info", "steam"]]);
  });

  it("keeps a failed Steam sync an error even though it is blue", () => {
    // The assertion that matters: `type` survives the fill override. If this ever
    // reads "steam", the toast stops being announced with role="alert" and
    // aria-live="assertive", and a blind user is no longer told their sync failed.
    show("Steam sync failed", "error", undefined, undefined, undefined, "steam");

    const t = toasts();
    expect(t.map((x) => x.type)).toEqual(["error"]);
    expect(t.map((x) => x.fill)).toEqual(["steam"]);
  });

  it("still gives a blue Steam error the error lifetime, not a shorter one", () => {
    show("Steam sync failed", "error", undefined, undefined, undefined, "steam");
    show("Steam sync in progress", "info", undefined, undefined, undefined, "steam");

    const [err, info] = toasts();
    expect(err?.duration).toBe(6000);
    expect(info?.duration).toBe(3500);
  });

  it("lets an explicit duration win over the type default on a Steam toast", () => {
    show("Steam sync in progress", "info", undefined, 5000, undefined, "steam");
    expect(toasts()[0]?.duration).toBe(5000);
  });

  it("keeps action buttons working on a filled toast", () => {
    const onClick = vi.fn();
    show("Steam sync complete", "success", "3 updated", undefined, [{ label: "View", onClick }], "steam");
    expect(toasts()[0]?.actions?.map((a) => a.label)).toEqual(["View"]);
  });

  it("still folds description into the one-line message on a filled toast", () => {
    show("Steam sync complete", "success", "3 imported · 1 updated", undefined, undefined, "steam");
    expect(toasts()[0]?.message).toBe("Steam sync complete — 3 imported · 1 updated");
  });
});
