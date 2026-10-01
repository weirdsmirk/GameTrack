import type { Game } from "../types";
import { getOwnershipLabel, isOwned } from "../constants";
import { formatPlaytimePrecise } from "./time";

export function csvEscape(value: string): string {
  // Neutralize spreadsheet formula execution (CSV injection): cells whose
  // content starts with = + - @ or a tab are prefixed with an apostrophe so
  // Excel/Sheets render them as text instead of evaluating them.
  if (/^[=+\-@\t]/.test(value)) value = `'${value}`;
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function rowFields(game: Game) {
  const completed = game.date_completed
    ? new Date(game.date_completed).toISOString().slice(0, 10)
    : "";
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
    rating: game.personal_rating == null ? "" : String(game.personal_rating),
    completion: completed,
  };
}

export function gamesToCsv(games: Game[]): string {
  const header = ["title", "status", "ownership", "platform", "playtime", "rating", "completion_date"];
  const lines = [header.join(",")];
  for (const game of games) {
    const f = rowFields(game);
    lines.push(
      [f.title, f.status, f.ownership, f.platform, f.playtime, f.rating, f.completion]
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
    `| Title | Status | Ownership | Platform | Playtime | Rating | Completed |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const game of games) {
    const f = rowFields(game);
    // The readable label here, unlike the CSV: this table is read by a person,
    // and `status` prints as its raw value beside it already, so the pair
    // reads as the same kind of thing.
    const cells = [f.title, f.status, getOwnershipLabel(game.ownership_status), f.platform, f.playtime, f.rating || "—", f.completion || "—"]
      .map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " "));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function downloadTextFile(filename: string, contents: string, mime: string) {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
