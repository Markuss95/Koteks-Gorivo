import { db } from '../db/index.js';
import { getJsonSetting } from '../db/index.js';
import { config } from '../config.js';
import { marisFetchItems, toMarisDate, type MarisItem } from '../maris/client.js';
import { listMachines } from './machines.js';

export interface MachineComparison {
  serialNumber: string;
  model: string;
  equipmentId: string | null;
  group: import('./groups.js').MachineGroup;
  lastReadingTime: string | null;
  rnalogs: string[];
  // Maris (issued from warehouse)
  marisIssuedLitres: number;
  marisIssueCount: number;
  marisValue: number;
  // LiDAT (actually consumed)
  lidatConsumedLitres: number | null;
  lidatBaselineTime: string | null;
  lidatEndTime: string | null;
  lidatReadingsInRange: number;
  lidatPartial: boolean; // true if no baseline before range start (consumption underestimated)
  // Derived
  differenceLitres: number | null; // issued - consumed
  variancePct: number | null; // difference / consumed * 100
}

export interface ComparisonResult {
  from: string;
  to: string;
  fuelArticleCodes: string[];
  generatedAt: string;
  machines: MachineComparison[];
  totals: {
    marisIssuedLitres: number;
    lidatConsumedLitres: number;
    differenceLitres: number;
    machinesWithLidatData: number;
    machinesTotal: number;
  };
}

export function getFuelArticleCodes(): string[] {
  return getJsonSetting<string[]>('fuelArticleCodes', config.defaults.fuelArticleCodes);
}

/** Cumulative reading at or just before a boundary timestamp. */
function cumAtOrBefore(serial: string, boundaryIso: string): number | null {
  const row = db
    .prepare(
      `SELECT fuel_consumed_cum FROM lidat_fuel_reading
       WHERE serial_number = ? AND reading_time <= ?
       ORDER BY reading_time DESC LIMIT 1`,
    )
    .get(serial, boundaryIso) as { fuel_consumed_cum: number } | undefined;
  return row ? row.fuel_consumed_cum : null;
}

function lidatConsumption(
  serial: string,
  fromIso: string,
  toIso: string,
): {
  consumed: number | null;
  baselineTime: string | null;
  endTime: string | null;
  countInRange: number;
  partial: boolean;
} {
  // End value: last cumulative reading at or before `to`.
  const endRow = db
    .prepare(
      `SELECT reading_time, fuel_consumed_cum FROM lidat_fuel_reading
       WHERE serial_number = ? AND reading_time <= ?
       ORDER BY reading_time DESC LIMIT 1`,
    )
    .get(serial, toIso) as { reading_time: string; fuel_consumed_cum: number } | undefined;

  // Baseline: last cumulative reading strictly before `from`.
  const baseRow = db
    .prepare(
      `SELECT reading_time, fuel_consumed_cum FROM lidat_fuel_reading
       WHERE serial_number = ? AND reading_time < ?
       ORDER BY reading_time DESC LIMIT 1`,
    )
    .get(serial, fromIso) as { reading_time: string; fuel_consumed_cum: number } | undefined;

  const countInRange = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM lidat_fuel_reading
         WHERE serial_number = ? AND reading_time >= ? AND reading_time <= ?`,
      )
      .get(serial, fromIso, toIso) as { c: number }
  ).c;

  if (!endRow) {
    return { consumed: null, baselineTime: null, endTime: null, countInRange, partial: false };
  }

  let baseline = baseRow;
  let partial = false;
  if (!baseline) {
    // No reading before the range: use the earliest reading within range as baseline.
    baseline = db
      .prepare(
        `SELECT reading_time, fuel_consumed_cum FROM lidat_fuel_reading
         WHERE serial_number = ? AND reading_time >= ? AND reading_time <= ?
         ORDER BY reading_time ASC LIMIT 1`,
      )
      .get(serial, fromIso, toIso) as
      | { reading_time: string; fuel_consumed_cum: number }
      | undefined;
    partial = true;
  }

  if (!baseline) {
    return {
      consumed: null,
      baselineTime: null,
      endTime: endRow.reading_time,
      countInRange,
      partial: false,
    };
  }

  const consumed = Math.max(0, endRow.fuel_consumed_cum - baseline.fuel_consumed_cum);
  return {
    consumed,
    baselineTime: baseline.reading_time,
    endTime: endRow.reading_time,
    countInRange,
    partial,
  };
}

/**
 * Fetch all fuel issuances from Maris in [from,to] for the configured fuel codes,
 * grouped by RNALOG. One Maris call per fuel code (no rnalog filter) for efficiency.
 */
async function marisFuelByRnalog(
  fromDate: string,
  toDate: string,
  fuelCodes: string[],
): Promise<Map<string, { litres: number; count: number; value: number }>> {
  const datumOd = toMarisDate(`${fromDate}T00:00:00Z`);
  const datumDo = toMarisDate(`${toDate}T00:00:00Z`);
  const byRnalog = new Map<string, { litres: number; count: number; value: number }>();

  const allItems: MarisItem[] = [];
  for (const code of fuelCodes) {
    const items = await marisFetchItems({ datumOd, datumDo, artikl: code, rowCount: 0 });
    allItems.push(...items);
  }

  for (const it of allItems) {
    const rnalog = (it.RNALOG ?? '').trim();
    if (!rnalog) continue;
    const entry = byRnalog.get(rnalog) ?? { litres: 0, count: 0, value: 0 };
    entry.litres += Number(it.KOLICINA) || 0;
    entry.value += Number(it.VRIJEDNOST) || 0;
    entry.count += 1;
    byRnalog.set(rnalog, entry);
  }

  return byRnalog;
}

export async function buildComparison(
  fromDate: string,
  toDate: string,
  allowed?: import('./groups.js').MachineGroup[],
): Promise<ComparisonResult> {
  const fuelCodes = getFuelArticleCodes();
  const fromIso = `${fromDate}T00:00:00Z`;
  const toIso = `${toDate}T23:59:59Z`;

  const machines = listMachines(allowed);
  const marisByRnalog = await marisFuelByRnalog(fromDate, toDate, fuelCodes);

  const result: MachineComparison[] = machines.map((m) => {
    // Aggregate Maris across the machine's work orders.
    let marisIssuedLitres = 0;
    let marisIssueCount = 0;
    let marisValue = 0;
    for (const r of m.rnalogs) {
      const e = marisByRnalog.get(r.trim());
      if (e) {
        marisIssuedLitres += e.litres;
        marisIssueCount += e.count;
        marisValue += e.value;
      }
    }

    const lidat = lidatConsumption(m.serialNumber, fromIso, toIso);
    const difference =
      lidat.consumed === null ? null : marisIssuedLitres - lidat.consumed;
    const variancePct =
      lidat.consumed === null || lidat.consumed === 0
        ? null
        : (difference! / lidat.consumed) * 100;

    return {
      serialNumber: m.serialNumber,
      model: m.model,
      equipmentId: m.equipmentId,
      group: m.group,
      lastReadingTime: m.lastReadingTime,
      rnalogs: m.rnalogs,
      marisIssuedLitres: round2(marisIssuedLitres),
      marisIssueCount,
      marisValue: round2(marisValue),
      lidatConsumedLitres: lidat.consumed === null ? null : round2(lidat.consumed),
      lidatBaselineTime: lidat.baselineTime,
      lidatEndTime: lidat.endTime,
      lidatReadingsInRange: lidat.countInRange,
      lidatPartial: lidat.partial,
      differenceLitres: difference === null ? null : round2(difference),
      variancePct: variancePct === null ? null : round2(variancePct),
    };
  });

  const totals = result.reduce(
    (acc, m) => {
      acc.marisIssuedLitres += m.marisIssuedLitres;
      if (m.lidatConsumedLitres !== null) {
        acc.lidatConsumedLitres += m.lidatConsumedLitres;
        acc.machinesWithLidatData += 1;
      }
      return acc;
    },
    { marisIssuedLitres: 0, lidatConsumedLitres: 0, machinesWithLidatData: 0 },
  );

  return {
    from: fromDate,
    to: toDate,
    fuelArticleCodes: fuelCodes,
    generatedAt: new Date().toISOString(),
    machines: result,
    totals: {
      marisIssuedLitres: round2(totals.marisIssuedLitres),
      lidatConsumedLitres: round2(totals.lidatConsumedLitres),
      differenceLitres: round2(totals.marisIssuedLitres - totals.lidatConsumedLitres),
      machinesWithLidatData: totals.machinesWithLidatData,
      machinesTotal: result.length,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
