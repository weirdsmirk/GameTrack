/**
 * Dates, in one format, everywhere they are shown to a person: DD/MM/YY.
 *
 * Not `toLocaleDateString`. That was the old approach and it had two problems.
 * The format followed the browser's locale, so the same library read
 * "07/13/26" on one machine and "13/07/26" on another — and the two orders are
 * genuinely ambiguous against each other, so a date copied between them is
 * silently wrong. It also spread across four components, each with its own
 * options object, so they had already drifted into printing different lengths
 * of the same date.
 *
 * Built by hand from local getters rather than `Intl`, so the output is fixed
 * and testable instead of environment-dependent. `getDate` and friends are local
 * time, matching the local-midnight convention the stores use for
 * `date_completed` — see the note on `formatDateInputValue`.
 *
 * Two-digit day, month and year, zero-padded: `09/01/26`, not `9/1/26`. In a
 * column of dates the padding is what makes them align, and it removes the
 * question of whether `1/2/26` is February or January.
 */
export const formatDateShort = (value: number | Date | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  // %y is the two-digit year and maps 2000-2099; anything outside that falls
  // back to the full year so a future date cannot read as "21" for 2021.
  const yy = d.getFullYear();
  const year = yy >= 2000 && yy < 2100 ? String(yy % 100).padStart(2, "0") : String(yy);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${year}`;
};

export const formatPlaytime = (hoursDecimal: number | undefined | null): string => {
  if (hoursDecimal === undefined || hoursDecimal === null || isNaN(hoursDecimal) || hoursDecimal < 0) {
    return "0H";
  }
  return `${Math.round(hoursDecimal)}H`;
};

export const formatPlaytimeLong = (hoursDecimal: number | undefined | null): string => {
  if (hoursDecimal === undefined || hoursDecimal === null || isNaN(hoursDecimal) || hoursDecimal < 0) {
    return "0 HOURS";
  }
  return `${Math.round(hoursDecimal)} HOURS`;
};

export const formatPlaytimePrecise = (hoursDecimal: number | undefined | null): string => {
  if (hoursDecimal === undefined || hoursDecimal === null || isNaN(hoursDecimal) || hoursDecimal < 0) {
    return "0H";
  }
  let h = Math.floor(hoursDecimal);
  let m = Math.round((hoursDecimal - h) * 60);
  if (m === 60) {
    h += 1;
    m = 0;
  }
  if (m === 0) {
    return `${h}H`;
  }
  return `${h}H ${m}M`;
};
