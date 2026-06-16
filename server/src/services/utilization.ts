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
    fuelLitres: number;
    avgHoursPerDay: number; // mean of per-machine hoursPerDay (machines with data)
    avgLitresPerHour: number; // fleet fuel / fleet operating hours
    machinesWithData: number;
    machinesTotal: number;
  };
}

function operatingDelta(serial: string, fromIso: string, toIso: string) {
  const end = db
    .prepare(
      `SELECT hours_cum v FROM lidat_hours_reading
       WHERE serial_number=? AND metric='operating' AND reading_time<=?
       ORDER BY reading_time DESC LIMIT 1`,
    )
    .get(serial, toIso) as { v: number } | undefined;
  if (!end) return { value: null as number | null, partial: false };
  let base = db
    .prepare(
      `SELECT hours_cum v FROM lidat_hours_reading
       WHERE serial_number=? AND metric='operating' AND reading_time<?
       ORDER BY reading_time DESC LIMIT 1`,
    )
    .get(serial, fromIso) as { v: number } | undefined;
  let partial = false;
  if (!base) {
    base = db
      .prepare(
        `SELECT hours_cum v FROM lidat_hours_reading
         WHERE serial_number=? AND metric='operating' AND reading_time>=? AND reading_time<=?
         ORDER BY reading_time ASC LIMIT 1`,
      )
      .get(serial, fromIso, toIso) as { v: number } | undefined;
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
    const op = operatingDelta(m.serialNumber, fromIso, toIso);
    const fuel = fuelDelta(m.serialNumber, fromIso, toIso);
    const days = reportingDays(m.serialNumber, fromIso, toIso);

    const operatingHours = op.value;
    const hoursPerDay =
      operatingHours === null || days === 0 ? null : operatingHours / days;
    const litresPerHour =
      fuel === null || operatingHours === null || operatingHours <= 0 ? null : fuel / operatingHours;

    return {
      serialNumber: m.serialNumber,
      model: m.model,
      equipmentId: m.equipmentId,
      operatingHours: operatingHours === null ? null : round2(operatingHours),
      reportingDays: days,
      hoursPerDay: hoursPerDay === null ? null : round2(hoursPerDay),
      fuelLitres: fuel === null ? null : round2(fuel),
      litresPerHour: litresPerHour === null ? null : round2(litresPerHour),
      partial: op.partial,
    };
  });

  const withData = result.filter((m) => m.operatingHours !== null);
  const totalOperating = withData.reduce((s, m) => s + (m.operatingHours ?? 0), 0);
  const totalFuel = result.reduce((s, m) => s + (m.fuelLitres ?? 0), 0);
  const withHpd = result.filter((m) => m.hoursPerDay !== null);
  const avgHoursPerDay = withHpd.length
    ? withHpd.reduce((s, m) => s + (m.hoursPerDay ?? 0), 0) / withHpd.length
    : 0;
  const avgLitresPerHour = totalOperating > 0 ? totalFuel / totalOperating : 0;

  return {
    from: fromDate,
    to: toDate,
    generatedAt: new Date().toISOString(),
    machines: result,
    totals: {
      operatingHours: round2(totalOperating),
      fuelLitres: round2(totalFuel),
      avgHoursPerDay: round2(avgHoursPerDay),
      avgLitresPerHour: round2(avgLitresPerHour),
      machinesWithData: withData.length,
      machinesTotal: result.length,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
