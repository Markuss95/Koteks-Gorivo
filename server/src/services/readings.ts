// A reading before the range only counts as its baseline if it is recent. A
// machine that went quiet (or predates our history) leaves one old reading and
// then a long gap, and the counter growth across that gap can't be placed in
// time — e.g. 133080 has a lone Nov 2025 reading followed by history from
// 8 Jun 2026, which pulled ~3,420 L / 591 h from before the range into it.
// 14 days still covers weekends and holiday shutdowns (counter doesn't move).
const MAX_BASELINE_AGE_DAYS = 14;

/** Oldest reading_time still accepted as the baseline for a range starting at `fromIso`. */
export function baselineFloorIso(fromIso: string): string {
  const ms = Date.parse(fromIso) - MAX_BASELINE_AGE_DAYS * 86_400_000;
  // Stored reading_time has no milliseconds; keep the same shape so string comparison holds.
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
