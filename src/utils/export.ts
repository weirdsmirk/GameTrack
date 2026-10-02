import type { Game } from "../types";
import { getOwnershipLabel, isOwned, timesPlayed, replayPlaytime } from "../constants";
import { formatPlaytimePrecise, toLocalISODate } from "./time";

export function csvEscape(value: string): string {
  // Neutralize spreadsheet formula execution (CSV injection): cells whose
  // content starts with = + - @ or a tab are prefixed with an apostrophe so
  // Excel/Sheets render them as text instead of evaluating them.
  if (/^[=+\-@\t]/.test(value)) value = `'${value}`;
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function rowFields(game: Game) {
  // Local-date ISO, NOT toISOString(). date_completed is stored at local midnight,
// so converting to UTC first shifted every exported completion date a day
// earlier for anyone west of Greenwich. See toLocalISODate.
const completed = game.date_completed ? toLocalISODate(game.date_completed) : "";
  const replayHours = replayPlaytime(game);
  return {
    title: game.title || "",
    status: game.status,
    // The machine-readable form of the flag, kept as a bare token rather than
    // the display label: this column round-trips into the JSON import, where
    // "Not Owned" would have to be parsed back into `not_owned`. Spreadsheet
    // readers are perfectly happy with a snake_case value, and `status` beside
    // it already sets that precedent.
    ownership: isOwned(game) ? "owned" : "not_owned",
    platform: (game.owned_platforms || []).join("; "),
    playtime: formatPlaytimePrecise(game.playtime),
    // Blank rather than "0" for a game with no replays, so a spreadsheet can
    // average and sum the column without 39 zeroes dragging the result toward
    // zero — the same choice already made for a missing rating.
    replays: timesPlayed(game) > 1 ? String(timesPlayed(game) - 1) : "",
    replay_playtime: replayHours > 0 ? formatPlaytimePrecise(replayHours) : "",
    rating: game.personal_rating == null ? "" : String(game.personal_rating),
    completion: completed,
  };
}

export function gamesToCsv(games: Game[]): string {
  // `plays` is the total playthrough count and `replays` the count beyond the
  // first; both, because "played 3 times" and "2 replays" are the same fact asked
  // two ways and a spreadsheet user will reach for either. `replay_playtime`
  // stays separate from `playtime` so the two can be summed for an all-runs total
  // without a reader having to know which column means what.
  const header = [
    "title", "status", "ownership", "platform", "playtime",
    "plays", "replays", "replay_playtime", "rating", "completion_date",
  ];
  const lines = [header.join(",")];
  for (const game of games) {
    const f = rowFields(game);
    lines.push(
      [
        f.title, f.status, f.ownership, f.platform, f.playtime,
        String(timesPlayed(game)), f.replays, f.replay_playtime, f.rating, f.completion,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return `\uFEFF${lines.join("\n")}\n`;
}

export function gamesToMarkdown(games: Game[]): string {
  const lines = [
    "# GameTrack Library",
    "",
    `| Title | Status | Ownership | Platform | Playtime | Times Played | Replay Time | Rating | Completed |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const game of games) {
    const f = rowFields(game);
    // The readable label here, unlike the CSV: this table is read by a person,
    // and `status` prints as its raw value beside it already, so the pair
    // reads as the same kind of thing.
    // Times Played is always printed — including the plain "1" — because a
    // column that is blank for most rows invites the reader to assume the blank
    // rows are unknown rather than single-run. Replay Time is the opposite: it
    // is blank unless there is a replay, since "0H" beside a dash reads as
    // something measured.
    const cells = [
      f.title, f.status, getOwnershipLabel(game.ownership_status), f.platform, f.playtime,
      String(timesPlayed(game)), f.replay_playtime || "—",
      f.rating || "—", f.completion || "—",
    ]
      .map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " "));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Hand a Blob to the browser as a file download.
 *
 * Exists because three separate places needed the identical eight lines — create
 * a blob URL, click a synthetic anchor, revoke the URL — and two of them had been
 * copy-pasted into the store while this module's own `downloadTextFile` sat unused
 * beside them. Three copies means a fix to any one of them (a missing
 * `revokeObjectURL` that leaks, the anchor some browsers refuse to click once
 * detached) has to be made three times, and had been missed twice.
 *
 * Takes a Blob rather than a string so the JSON export can pass through the blob
 * `fetch` already produced, instead of reading a whole response into memory
 * purely to hand back the same bytes as a string.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadTextFile(filename: string, contents: string, mime: string): void {
  downloadBlob(filename, new Blob([contents], { type: mime }));
}
