// A LiDAT counter delta is only trustworthy if we have readings close to both ends
// of the range. A machine that went quiet (or predates our history) leaves an old
// reading and then a long gap, and the counter growth across that gap can't be
// placed in time — e.g. 133080 has a lone Nov 2025 reading followed by history
// from 8 Jun 2026, which pulled ~3,420 L from before the range into it; 159238
// stops reporting on 1 Jul, so a Jun–Aug range only sees a month of its burn.
// 14 days still covers weekends and holiday shutdowns.
const MAX_BOUNDARY_GAP_DAYS = 14;

// A counter that moved at most this much across a silent gap means the machine
// was parked (a brief engine start still ticks a few litres), so the gap hides
// no real consumption and the boundary is still covered.
const PARKED_MAX_LITRES = 5;

/** Oldest reading_time that still counts as "at" a range boundary. */
export function boundaryFloorIso(boundaryIso: string): string {
  const ms = Date.parse(boundaryIso) - MAX_BOUNDARY_GAP_DAYS * 86_400_000;
  // Stored reading_time has no milliseconds; keep the same shape so string comparison holds.
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** True when the fuel counter barely moved between two readings (machine parked). */
export function parkedBetween(earlierCum: number, laterCum: number): boolean {
  return Math.abs(laterCum - earlierCum) <= PARKED_MAX_LITRES;
}
