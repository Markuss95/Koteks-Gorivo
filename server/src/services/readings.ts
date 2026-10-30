import { isWorkingDay } from './workdays.js';

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

/** 'YYYY-MM-DD' moved by `n` calendar days. */
function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The last whole day a machine was still reporting, when it went quiet before the
 * end of the range: at least one working day after its last reading (up to
 * `toDay`) passed with nothing from it. Null when it didn't — a machine idle over
 * a weekend or holiday at the end of the range is still covered.
 *
 * The cut is the day BEFORE the last reading. Maris slips carry only a date, so on
 * the day it went quiet we can't tell a refuel before the last reading from one
 * after it — 42410 sent its last reading at 06:51 on 28 Sep 2026 and the tanker
 * came later that day.
 */
export function silentCutoffDay(lastReadingIso: string, toDay: string): string | null {
  const lastDay = lastReadingIso.slice(0, 10);
  for (let day = shiftDay(lastDay, 1); day <= toDay; day = shiftDay(day, 1)) {
    const [y, m, d] = day.split('-').map(Number);
    if (isWorkingDay(new Date(y, m - 1, d))) return shiftDay(lastDay, -1);
  }
  return null;
}
