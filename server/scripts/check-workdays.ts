import { croatianHolidays, isWorkingDay, lastWorkingDayOfMonth, isLastWorkingDayOfMonth, previousMonthRange, dateKey } from '../src/services/workdays.js';

const D = (s: string) => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
let fails = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} got=${got}  want=${want}`);
};

// --- Easter-derived holidays (published Croatian dates) ---
const h2026 = croatianHolidays(2026);
eq('2026 Uskrs (5 Apr)',            h2026.has('2026-04-05'), true);
eq('2026 Uskrsni ponedjeljak (6 Apr)', h2026.has('2026-04-06'), true);
eq('2026 Tijelovo (4 Jun)',         h2026.has('2026-06-04'), true);
const h2027 = croatianHolidays(2027);
eq('2027 Uskrs (28 Mar)',           h2027.has('2027-03-28'), true);
eq('2027 Tijelovo (27 May)',        h2027.has('2027-05-27'), true);

// --- Fixed holidays ---
eq('2026 Dan državnosti (30 May)',  h2026.has('2026-05-30'), true);
eq('2026 Božić (25 Dec)',           h2026.has('2026-12-25'), true);
eq('2026 non-holiday (31 Dec)',     h2026.has('2026-12-31'), false);

// --- The user's stated example ---
eq("31 Aug 2026 is last working day", isLastWorkingDayOfMonth(D('2026-08-31')), true);
const r = previousMonthRange(D('2026-08-31'));
eq('range from', r.from, '2026-07-01');
eq('range to',   r.to,   '2026-07-31');

// --- Month ends landing on weekends/holidays ---
eq('May 2026 ends Sun 31 -> Fri 29',  dateKey(lastWorkingDayOfMonth(D('2026-05-15'))), '2026-05-29');
eq('Jan 2026 ends Sat 31 -> Fri 30',  dateKey(lastWorkingDayOfMonth(D('2026-01-10'))), '2026-01-30');
eq('Oct 2026 ends Sat 31 -> Fri 30',  dateKey(lastWorkingDayOfMonth(D('2026-10-01'))), '2026-10-30');
eq('Dec 2026 ends Thu 31 (working)',  dateKey(lastWorkingDayOfMonth(D('2026-12-01'))), '2026-12-31');
// Nov 2026: 30th is a Monday and not a holiday
eq('Nov 2026 -> Mon 30',              dateKey(lastWorkingDayOfMonth(D('2026-11-05'))), '2026-11-30');

// --- Weekend / holiday classification ---
eq('Sat is not working',   isWorkingDay(D('2026-08-29')), false);
eq('Sun is not working',   isWorkingDay(D('2026-08-30')), false);
eq('Božić not working',    isWorkingDay(D('2026-12-25')), false);
eq('ordinary Tue working', isWorkingDay(D('2026-08-11')), true);

// --- Year boundary ---
const jan = previousMonthRange(D('2026-01-30'));
eq('Jan run -> previous Dec from', jan.from, '2025-12-01');
eq('Jan run -> previous Dec to',   jan.to,   '2025-12-31');

// --- February / leap year ---
eq('Feb 2028 (leap) last day',  dateKey(lastWorkingDayOfMonth(D('2028-02-10'))), '2028-02-29');
const mar = previousMonthRange(D('2028-03-31'));
eq('leap Feb range to', mar.to, '2028-02-29');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
