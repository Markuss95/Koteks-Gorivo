import type { MachineGroup } from './types';

// Global hard floor for the date pickers: data before this is unreliable
// (incomplete early LiDAT history).
export const DATA_FLOOR = '2026-06-04';

// Per-group data floors. Velički Kamen & Kamen Psunj run on a separate LiDAT
// (AEMP) login that was only added on 2026-07-06; LiDAT serves ~14 days of
// history, so nothing reliable exists for those groups before this date.
const GROUP_DATA_FLOOR: Partial<Record<MachineGroup, string>> = {
  velicki: '2026-06-26',
  psunj: '2026-06-26',
};

/**
 * Earliest selectable date for the pickers, given the backend's reported floor
 * and the currently-selected worksite groups. Selecting a group with a later
 * floor (Velički Kamen / Kamen Psunj) greys out the earlier days. ISO
 * 'YYYY-MM-DD' strings compare lexicographically, so max = the strictest floor.
 */
export function effectiveDateFloor(minDate: string, groups: Iterable<MachineGroup>): string {
  let floor = minDate > DATA_FLOOR ? minDate : DATA_FLOOR;
  for (const g of groups) {
    const f = GROUP_DATA_FLOOR[g];
    if (f && f > floor) floor = f;
  }
  return floor;
}

// LiDAT model is "Class:Series:Type:SpecificType" (e.g. "Wheelloader:Large_size:L576:1333").
// Drop the leading classification (Class, Series) and show from the model name onward
// → "L576:1333". Labels without that structure (e.g. "L 576") are returned unchanged.
export function shortModel(model: string): string {
  if (!model) return model;
  const parts = model.split(':');
  return parts.length > 2 ? parts.slice(2).join(':') : model;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}

export function today(): string {
  return isoDate(new Date());
}

export function fmt(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('hr-HR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Days since an ISO timestamp; null if missing/invalid.
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

// A machine is "stale" if it hasn't reported to LiDAT within `days` (or never has).
export function isStale(iso: string | null | undefined, days = 10): boolean {
  const d = daysSince(iso);
  return d === null || d > days;
}

/**
 * 'YYYY-MM-DD' → Croatian 'DD.MM.YYYY.' (trailing dot included).
 * Formatted from the string parts rather than via Date, so a UTC-midnight value
 * can't slip to the previous day in a negative-offset timezone.
 */
export function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}.` : iso;
}

/**
 * Period line shown inside reports, e.g. '04.06.2026 – 20.07.2026'. Uses the
 * same dot-free form as the filename so a report and its file agree on sight.
 * (The e-mail subject keeps fmtDate's trailing dot — see ReportsPage.)
 */
export function fmtRange(from: string, to: string): string {
  const noDot = (iso: string) => fmtDate(iso).replace(/\.$/, '');
  return `${noDot(from)} – ${noDot(to)}`;
}

/** '22.09.2026 u 13:29' in Croatian time — a moment inside a sentence. */
export function fmtDayAtTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('hr-HR', {
    timeZone: 'Europe/Zagreb',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} u ${p.hour}:${p.minute}`;
}

/**
 * Why a machine that went quiet is compared only part of the range: when LiDAT
 * stopped, how much fuel issued from then on is left out, and the days compared.
 * Same wording as the server's report footnote.
 */
export function cutOffNote(
  silentSince: string,
  comparedUntil: string,
  from: string,
  marisAfterLitres: number,
): string {
  const next = new Date(`${comparedUntil}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const firstOut = fmtDate(next.toISOString().slice(0, 10)).replace(/\.$/, '');
  const stopped = `LiDAT je prestao slati podatke ${fmtDayAtTime(silentSince)}`;
  const compared = fmtRange(from, comparedUntil);
  return marisAfterLitres > 0
    ? `${stopped}, pa gorivo izdano od ${firstOut} nadalje (${fmt(marisAfterLitres, 1)} L) ` +
        `nije uključeno — Maris i LiDAT uspoređeni su samo za ${compared}.`
    : `${stopped}, pa su Maris i LiDAT uspoređeni samo za ${compared} (od ${firstOut} nije izdano gorivo).`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('hr-HR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
