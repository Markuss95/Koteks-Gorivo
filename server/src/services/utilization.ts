import { db } from '../db/index.js';
import { listMachines } from './machines.js';

export interface MachineUtilization {
  serialNumber: string;
  model: string;
  equipmentId: string | null;
  // Operating (engine-on) hours within the range = cumulative-counter delta.
  operatingHours: number | null;
  reportingDays: number; // distinct UTC days the machine sent an operating reading
  hoursPerDay: number | null; // operatingHours / reportingDays
  // Idle (engine running, machine not working) hours within the range.
  idleHours: number | null;
  idlePct: number | null; // idle / (operating + idle) * 100
  // Fuel burned within the range (LiDAT cumulative-fuel delta).
  fuelLitres: number | null;
  litresPerHour: number | null; // fuelLitres / operatingHours
  partial: boolean; // no reading before range start → underestimated
}

export interface UtilizationResult {
  from: string;
  to: string;
  generatedAt: string;
  machines: MachineUtilization[];
  totals: {
    operatingHours: number;
    idleHours: number;
    fuelLitres: number;
    avgHoursPerDay: number; // mean of per-machine hoursPerDay (machines with data)
    avgIdlePct: number; // mean of per-machine idlePct (machines with data)
    avgLitresPerHour: number; // fleet fuel / fleet operating hours
    machinesWithData: number;
    machinesTotal: number;
  };
}

// Delta of a cumulative hours counter ('operating' | 'idle') over [from,to],
// same baseline/end/partial rules as the fuel comparison.
function hoursDelta(serial: string, metric: 'operating' | 'idle', fromIso: string, toIso: string) {
  const end = db
    .prepare(
      `SELECT hours_cum v FROM lidat_hours_reading
       WHERE serial_number=? AND metric=? AND reading_time<=?
       ORDER BY reading_time DESC LIMIT 1`,
    )
    .get(serial, metric, toIso) as { v: number } | undefined;
  if (!end) return { value: null as number | null, partial: false };
  let base = db
    .prepare(
      `SELECT hours_cum v FROM lidat_hours_reading
       WHERE serial_number=? AND metric=? AND reading_time<?
       ORDER BY reading_time DESC LIMIT 1`,
    )
    .get(serial, metric, fromIso) as { v: number } | undefined;
  let partial = false;
  if (!base) {
    base = db
      .prepare(
        `SELECT hours_cum v FROM lidat_hours_reading
         WHERE serial_number=? AND metric=? AND reading_time>=? AND reading_time<=?
         ORDER BY reading_time ASC LIMIT 1`,
      )
      .get(serial, metric, fromIso, toIso) as { v: number } | undefined;
    partial = true;
  }
  if (!base) return { value: null as number | null, partial: false };
  return { value: Math.max(0, end.v - base.v), partial };
}

function fuelDelta(serial: string, fromIso: string, toIso: string): number | null {
  const end = db
    .prepare(
      `SELECT fuel_consumed_cum v FROM lidat_fuel_reading
       WHERE serial_number=? AND reading_time<=? ORDER BY reading_time DESC LIMIT 1`,
    )
    .get(serial, toIso) as { v: number } | undefined;
  if (!end) return null;
  let base = db
    .prepare(
      `SELECT fuel_consumed_cum v FROM lidat_fuel_reading
       WHERE serial_number=? AND reading_time<? ORDER BY reading_time DESC LIMIT 1`,
    )
    .get(serial, fromIso) as { v: number } | undefined;
  if (!base) {
    base = db
      .prepare(
        `SELECT fuel_consumed_cum v FROM lidat_fuel_reading
         WHERE serial_number=? AND reading_time>=? AND reading_time<=? ORDER BY reading_time ASC LIMIT 1`,
      )
      .get(serial, fromIso, toIso) as { v: number } | undefined;
  }
  if (!base) return null;
  return Math.max(0, end.v - base.v);
}

function reportingDays(serial: string, fromIso: string, toIso: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(DISTINCT substr(reading_time,1,10)) c FROM lidat_hours_reading
         WHERE serial_number=? AND metric='operating' AND reading_time>=? AND reading_time<=?`,
      )
      .get(serial, fromIso, toIso) as { c: number }
  ).c;
}

export function buildUtilization(fromDate: string, toDate: string): UtilizationResult {
  const fromIso = `${fromDate}T00:00:00Z`;
  const toIso = `${toDate}T23:59:59Z`;
  const machines = listMachines();

  const result: MachineUtilization[] = machines.map((m) => {
    const op = hoursDelta(m.serialNumber, 'operating', fromIso, toIso);
    const idle = hoursDelta(m.serialNumber, 'idle', fromIso, toIso);
    const fuel = fuelDelta(m.serialNumber, fromIso, toIso);
    const days = reportingDays(m.serialNumber, fromIso, toIso);

    const operatingHours = op.value;
    const idleHours = idle.value;
    const hoursPerDay =
      operatingHours === null || days === 0 ? null : operatingHours / days;
    const litresPerHour =
      fuel === null || operatingHours === null || operatingHours <= 0 ? null : fuel / operatingHours;
    // Idle share of total engine-on time (working + idle).
    const idleTotal = (operatingHours ?? 0) + (idleHours ?? 0);
    const idlePct = idleHours === null || idleTotal <= 0 ? null : (idleHours / idleTotal) * 100;

    return {
      serialNumber: m.serialNumber,
      model: m.model,
      equipmentId: m.equipmentId,
      operatingHours: operatingHours === null ? null : round2(operatingHours),
      reportingDays: days,
      hoursPerDay: hoursPerDay === null ? null : round2(hoursPerDay),
      idleHours: idleHours === null ? null : round2(idleHours),
      idlePct: idlePct === null ? null : round2(idlePct),
      fuelLitres: fuel === null ? null : round2(fuel),
      litresPerHour: litresPerHour === null ? null : round2(litresPerHour),
      partial: op.partial || idle.partial,
    };
  });

  const withData = result.filter((m) => m.operatingHours !== null);
  const totalOperating = withData.reduce((s, m) => s + (m.operatingHours ?? 0), 0);
  const totalIdle = result.reduce((s, m) => s + (m.idleHours ?? 0), 0);
  const totalFuel = result.reduce((s, m) => s + (m.fuelLitres ?? 0), 0);
  const withHpd = result.filter((m) => m.hoursPerDay !== null);
  const avgHoursPerDay = withHpd.length
    ? withHpd.reduce((s, m) => s + (m.hoursPerDay ?? 0), 0) / withHpd.length
    : 0;
  const withIdlePct = result.filter((m) => m.idlePct !== null);
  const avgIdlePct = withIdlePct.length
    ? withIdlePct.reduce((s, m) => s + (m.idlePct ?? 0), 0) / withIdlePct.length
    : 0;
  const avgLitresPerHour = totalOperating > 0 ? totalFuel / totalOperating : 0;

  return {
    from: fromDate,
    to: toDate,
    generatedAt: new Date().toISOString(),
    machines: result,
    totals: {
      operatingHours: round2(totalOperating),
      idleHours: round2(totalIdle),
      fuelLitres: round2(totalFuel),
      avgHoursPerDay: round2(avgHoursPerDay),
      avgIdlePct: round2(avgIdlePct),
      avgLitresPerHour: round2(avgLitresPerHour),
      machinesWithData: withData.length,
      machinesTotal: result.length,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface UtilizationSeriesPoint {
  day: string; // YYYY-MM-DD (UTC)
  operatingHours: number | null;
  idleHours: number | null;
  fuelLitres: number | null;
}

/** Last cumulative value strictly before `beforeIso` for an hours metric. */
function hoursCumBefore(serial: string, metric: 'operating' | 'idle', beforeIso: string): number | null {
  const r = db
    .prepare(
      `SELECT hours_cum v FROM lidat_hours_reading
       WHERE serial_number=? AND metric=? AND reading_time<?
       ORDER BY reading_time DESC LIMIT 1`,
    )
    .get(serial, metric, beforeIso) as { v: number } | undefined;
  return r ? r.v : null;
}

/** Per-day last cumulative value for an hours metric within [fromIso, toIso]. */
function hoursCumByDay(serial: string, metric: 'operating' | 'idle', fromIso: string, toIso: string) {
  return db
    .prepare(
      `SELECT substr(reading_time,1,10) day, MAX(hours_cum) cum FROM lidat_hours_reading
       WHERE serial_number=? AND metric=? AND reading_time>=? AND reading_time<=?
       GROUP BY day ORDER BY day`,
    )
    .all(serial, metric, fromIso, toIso) as Array<{ day: string; cum: number }>;
}

/** Turn a per-day cumulative list into per-day deltas, seeded by a pre-range baseline. */
function dailyDeltas(
  byDay: Array<{ day: string; cum: number }>,
  baseline: number | null,
): Map<string, number> {
  const out = new Map<string, number>();
  let prev = baseline;
  for (const row of byDay) {
    // No baseline before the range → first day has no measurable delta (show 0).
    out.set(row.day, prev === null ? 0 : Math.max(0, round2(row.cum - prev)));
    prev = row.cum;
  }
  return out;
}

/**
 * Daily operating-hours, idle-hours and fuel-litres for one machine over the
 * range — each a per-day delta of its cumulative counter. Used by the modal chart.
 */
export function buildMachineSeries(
  serial: string,
  fromDate: string,
  toDate: string,
): { serial: string; from: string; to: string; points: UtilizationSeriesPoint[] } {
  const fromIso = `${fromDate}T00:00:00Z`;
  const toIso = `${toDate}T23:59:59Z`;

  const opDaily = dailyDeltas(
    hoursCumByDay(serial, 'operating', fromIso, toIso),
    hoursCumBefore(serial, 'operating', fromIso),
  );
  const idleDaily = dailyDeltas(
    hoursCumByDay(serial, 'idle', fromIso, toIso),
    hoursCumBefore(serial, 'idle', fromIso),
  );

  const fuelByDay = db
    .prepare(
      `SELECT substr(reading_time,1,10) day, MAX(fuel_consumed_cum) cum FROM lidat_fuel_reading
       WHERE serial_number=? AND reading_time>=? AND reading_time<=?
       GROUP BY day ORDER BY day`,
    )
    .all(serial, fromIso, toIso) as Array<{ day: string; cum: number }>;
  const fuelBaseline = (
    db
      .prepare(
        `SELECT fuel_consumed_cum v FROM lidat_fuel_reading
         WHERE serial_number=? AND reading_time<? ORDER BY reading_time DESC LIMIT 1`,
      )
      .get(serial, fromIso) as { v: number } | undefined
  )?.v ?? null;
  const fuelDaily = dailyDeltas(fuelByDay, fuelBaseline);

  const days = [...new Set([...opDaily.keys(), ...idleDaily.keys(), ...fuelDaily.keys()])].sort();
  const points: UtilizationSeriesPoint[] = days.map((day) => ({
    day,
    operatingHours: opDaily.has(day) ? opDaily.get(day)! : null,
    idleHours: idleDaily.has(day) ? idleDaily.get(day)! : null,
    fuelLitres: fuelDaily.has(day) ? fuelDaily.get(day)! : null,
  }));

  return { serial, from: fromDate, to: toDate, points };
}
