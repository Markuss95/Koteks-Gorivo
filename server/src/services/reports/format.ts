// Formatting helpers for generated reports. Mirrors web/src/util.ts so the
// server-rendered reports read identically to what the app shows on screen.

/** Croatian thousands/decimals, or an em dash for missing values. */
export function fmt(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('hr-HR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * 'YYYY-MM-DD' → 'DD.MM.YYYY.' — formatted from the string parts rather than via
 * Date, so a UTC-midnight value can't slip a day in a negative-offset timezone.
 */
export function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}.` : iso;
}

/** Same as fmtDate but without the trailing dot — for filenames. */
export function fileDate(iso: string): string {
  return fmtDate(iso).replace(/\.$/, '');
}

/**
 * Period line shown inside reports, e.g. '04.06.2026 – 20.07.2026'. Uses the
 * same dot-free form as the filename so a report and its file agree on sight.
 */
export function fmtRange(from: string, to: string): string {
  return `${fileDate(from)} – ${fileDate(to)}`;
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

// LiDAT model is "Class:Series:Type:SpecificType"; drop the leading
// classification so "Wheelloader:Large_size:L576:1333" reads as "L576:1333".
export function shortModel(model: string): string {
  if (!model) return model;
  const parts = model.split(':');
  return parts.length > 2 ? parts.slice(2).join(':') : model;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Days since an ISO timestamp; null if missing/invalid. */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}
