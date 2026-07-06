import type { MachineGroup } from './types';

// Global hard floor for the date pickers: data before this is unreliable
// (incomplete early LiDAT history).
export const DATA_FLOOR = '2026-06-04';

// Per-group data floors. Velički Kamen & Kamen Psunj run on a separate LiDAT
// (AEMP) login that was only added on 2026-07-06; LiDAT serves ~14 days of
// history, so nothing reliable exists for those groups before this date.
const GROUP_DATA_FLOOR: Partial<Record<MachineGroup, string>> = {
  velicki: '2026-06-25',
  psunj: '2026-06-25',
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
