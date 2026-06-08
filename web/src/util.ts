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
