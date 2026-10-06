// How fuel-control events read, shared by the page and the machine drawer.
import type { TankEvent, TankEventKind } from './types';
import { fmt, fmtDate, fmtDateTime } from './util';

export const EVENT_LABELS: Record<TankEventKind, string> = {
  drain: 'Odljev iz spremnika',
  cycle_loss: 'Manjak između punjenja',
  slip_mismatch: 'Izdatnica ≠ dolijevanje',
  slip_no_refuel: 'Izdatnica bez dolijevanja',
  refuel_no_slip: 'Dolijevanje bez izdatnice',
  refuel_awaiting_slip: 'Dolijevanje čeka Maris',
};

export function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Time of day in Croatia, e.g. '11:50'. */
export function clock(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' });
}

/** graceDays: how long a refuel waits for its izdatnica, once known. */
export function eventDetail(e: TankEvent, graceDays: number | null): string {
  switch (e.kind) {
    case 'drain': {
      // Part of the drop the reading got back is the sensor wavering, not fuel.
      const returned = e.returnedLitres ?? 0;
      const wavered =
        returned >= 1 ? ` (pad ${fmt(e.litres + returned, 0)} L, od toga ${fmt(returned, 0)} L kolebanje očitanja)` : '';
      return `${fmt(e.litres, 0)} L napustilo spremnik bez potrošnje motora${wavered}`;
    }
    case 'cycle_loss': {
      const change = e.levelChangeLitres ?? 0;
      const gross = (e.tankLitres ?? 0) - change - (e.burnedLitres ?? 0);
      const level =
        Math.abs(change) >= 1 ? `, spremnik na kraju ${fmt(Math.abs(change), 0)} L ${change < 0 ? 'niži' : 'viši'}` : '';
      const extra =
        Math.abs(gross - e.litres) > 1 ? ` (${fmt(e.litres, 0)} L izvan već prikazanih odljeva)` : '';
      return `Od ${fmtDateTime(e.since)}: uliveno ${fmt(e.tankLitres, 0)} L, motor potrošio ${fmt(e.burnedLitres, 0)} L${level} — nedostaje ${fmt(gross, 0)} L${extra}`;
    }
    case 'slip_mismatch':
      return `Maris ${fmt(e.marisLitres, 0)} L · spremnik +${fmt(e.tankLitres, 0)} L (izdatnica ${e.dokBroj})`;
    case 'slip_no_refuel':
      return `Maris ${fmt(e.marisLitres, 0)} L (izdatnica ${e.dokBroj}) · senzor nije vidio dolijevanje`;
    case 'refuel_no_slip':
      return `Spremnik +${fmt(e.tankLitres, 0)} L · nema izdatnice u Marisu`;
    case 'refuel_awaiting_slip': {
      const until = graceDays != null ? ` (čeka se do ${fmtDate(shiftDay(e.day, graceDays))})` : '';
      return `Spremnik +${fmt(e.tankLitres, 0)} L · izdatnica još nije u Marisu${until}`;
    }
  }
}
