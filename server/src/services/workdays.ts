// Croatian public holidays and the "last working day of the month" rule used by
// the monthly report scheduler.
//
// Holidays are computed, not listed year by year, so this needs no annual
// maintenance. Company-specific days off (collective shutdowns and the like) can
// be added via REPORT_EXTRA_HOLIDAYS in .env.
import { config } from '../config.js';

/** Local-date key 'YYYY-MM-DD' (no UTC conversion — these are calendar dates). */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Easter Sunday for a given year (Meeus/Jones/Butcher, Gregorian calendar).
 * Needed because three Croatian holidays move with it.
 */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/**
 * Croatian public holidays (neradni dani) for a year, as 'YYYY-MM-DD' keys.
 * Fixed dates per the Zakon o blagdanima, plus the three Easter-relative ones.
 */
export function croatianHolidays(year: number): Set<string> {
  const easter = easterSunday(year);
  const days: Date[] = [
    new Date(year, 0, 1), // Nova godina
    new Date(year, 0, 6), // Bogojavljenje
    easter, // Uskrs
    addDays(easter, 1), // Uskrsni ponedjeljak
    addDays(easter, 60), // Tijelovo
    new Date(year, 4, 1), // Praznik rada
    new Date(year, 4, 30), // Dan državnosti
    new Date(year, 5, 22), // Dan antifašističke borbe
    new Date(year, 7, 5), // Dan pobjede i domovinske zahvalnosti
    new Date(year, 7, 15), // Velika Gospa
    new Date(year, 10, 1), // Svi sveti
    new Date(year, 10, 18), // Dan sjećanja na žrtve Domovinskog rata
    new Date(year, 11, 25), // Božić
    new Date(year, 11, 26), // Sveti Stjepan
  ];
  const set = new Set(days.map(dateKey));
  for (const extra of config.reports.extraHolidays) set.add(extra);
  return set;
}

/** Mon–Fri and not a public holiday. */
export function isWorkingDay(d: Date): boolean {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  return !croatianHolidays(d.getFullYear()).has(dateKey(d));
}

/**
 * The last working day of the month `d` falls in. Walks back from the final
 * calendar day until it finds one — so a month ending on a weekend or a holiday
 * resolves to the preceding working day.
 */
export function lastWorkingDayOfMonth(d: Date): Date {
  const cursor = new Date(d.getFullYear(), d.getMonth() + 1, 0); // day 0 of next month = last of this
  while (!isWorkingDay(cursor)) cursor.setDate(cursor.getDate() - 1);
  return cursor;
}

export function isLastWorkingDayOfMonth(d: Date): boolean {
  return dateKey(d) === dateKey(lastWorkingDayOfMonth(d));
}

/**
 * First and last day of the month before `d`, as 'YYYY-MM-DD'.
 * A run on 31 Aug 2026 yields 2026-07-01 … 2026-07-31.
 */
export function previousMonthRange(d: Date): { from: string; to: string } {
  const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const last = new Date(d.getFullYear(), d.getMonth(), 0);
  return { from: dateKey(first), to: dateKey(last) };
}
