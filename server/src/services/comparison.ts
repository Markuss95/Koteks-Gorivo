import { db } from '../db/index.js';
import { getJsonSetting } from '../db/index.js';
import { config } from '../config.js';
import { marisFetchItems, toMarisDate, type MarisItem } from '../maris/client.js';
import { listMachines } from './machines.js';
import { boundaryFloorIso, parkedBetween, silentCutoffDay } from './readings.js';

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
  lidatPartial: boolean; // readings don't cover the whole range (quiet at the start or end) → not comparable
  // Set when the machine stopped reporting a few working days before the end of
  // the range: both sides are then compared only up to this day ('YYYY-MM-DD').
  comparedUntil: string | null;
  lidatSilentSince: string | null; // its last LiDAT reading in the range
  marisAfterCutoffLitres: number; // issued after comparedUntil — not in marisIssuedLitres
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

export function lidatConsumption(
  serial: string,
  fromIso: string,
  toIso: string,
): {
  consumed: number | null;
  baselineCum: number | null;
  baselineTime: string | null;
  endTime: string | null;
  countInRange: number;
  partial: boolean;
  comparedUntil: string | null;
  silentSince: string | null;
} {
  // End value: last cumulative reading at or before `to`.
  const endRow = fuelRow(serial, 'reading_time <= ? ORDER BY reading_time DESC', toIso);
  // Neighbours at each boundary: last reading before the range, first inside it,
  // and first after it.
  const prevRow = fuelRow(serial, 'reading_time < ? ORDER BY reading_time DESC', fromIso);
  const firstRow = fuelRow(
    serial,
    'reading_time >= ? AND reading_time <= ? ORDER BY reading_time ASC',
    fromIso,
    toIso,
  );

  const countInRange = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM lidat_fuel_reading
         WHERE serial_number = ? AND reading_time >= ? AND reading_time <= ?`,
      )
      .get(serial, fromIso, toIso) as { c: number }
  ).c;

  const notCut = { comparedUntil: null, silentSince: null };
  if (!endRow) {
    return { consumed: null, baselineCum: null, baselineTime: null, endTime: null, countInRange, partial: false, ...notCut };
  }

  if (!firstRow) {
    // Nothing inside the range: the machine was silent throughout, so the end
    // reading (an older one) is its own baseline → 0. Not flagged partial — a zero
    // already counts as "no LiDAT data" wherever totals are built.
    return {
      consumed: 0,
      baselineCum: endRow.fuel_consumed_cum,
      baselineTime: endRow.reading_time,
      endTime: endRow.reading_time,
      countInRange,
      partial: false,
      ...notCut,
    };
  }

  // Start is covered when the last reading before the range is recent, or the
  // counter didn't move between it and the first reading inside (parked).
  const startCovered =
    !!prevRow &&
    (prevRow.reading_time >= boundaryFloorIso(fromIso) ||
      parkedBetween(prevRow.fuel_consumed_cum, firstRow.fuel_consumed_cum));
  const baseline = startCovered ? prevRow! : firstRow;

  // End is covered the same way: the last reading in the range is recent, or the
  // next reading after the range shows the counter didn't move.
  const nextRow = fuelRow(serial, 'reading_time > ? ORDER BY reading_time ASC', toIso);
  const parkedAfter =
    !!nextRow && parkedBetween(endRow.fuel_consumed_cum, nextRow.fuel_consumed_cum);
  const endCovered = endRow.reading_time >= boundaryFloorIso(toIso) || parkedAfter;

  // "Recent" still allows a machine that stopped reporting days before the end —
  // 42196 went quiet on 22 Sep 2026 and kept getting fuel booked. Such a machine is
  // compared only up to the last whole day it reported; the caller cuts Maris at
  // the same day. A cut before the range even starts leaves nothing to compare;
  // a machine already partial at the start stays as it was.
  let comparedUntil =
    startCovered && endCovered && !parkedAfter
      ? silentCutoffDay(endRow.reading_time, toIso.slice(0, 10))
      : null;
  const cutTooEarly = comparedUntil !== null && comparedUntil < fromIso.slice(0, 10);
  if (cutTooEarly) comparedUntil = null;
  const end = comparedUntil
    ? (fuelRow(serial, 'reading_time <= ? ORDER BY reading_time DESC', `${comparedUntil}T23:59:59Z`) ??
      baseline)
    : endRow;

  const consumed = Math.max(0, end.fuel_consumed_cum - baseline.fuel_consumed_cum);
  return {
    consumed,
    baselineCum: baseline.fuel_consumed_cum,
    baselineTime: baseline.reading_time,
    endTime: end.reading_time,
    countInRange,
    partial: !startCovered || !endCovered || cutTooEarly,
    comparedUntil,
    silentSince: comparedUntil ? endRow.reading_time : null,
  };
}

type FuelRow = { reading_time: string; fuel_consumed_cum: number };

/** First fuel reading for `serial` matching `where` (which carries its own ORDER BY). */
function fuelRow(serial: string, where: string, ...params: string[]): FuelRow | undefined {
  return db
    .prepare(
      `SELECT reading_time, fuel_consumed_cum FROM lidat_fuel_reading
       WHERE serial_number = ? AND ${where} LIMIT 1`,
    )
    .get(serial, ...params) as FuelRow | undefined;
}

/** One Maris issuance line, reduced to what the comparison sums. */
interface MarisIssue {
  day: string; // 'YYYY-MM-DD'
  litres: number;
  value: number;
}

/**
 * Fetch all fuel issuances from Maris in [from,to] for the configured fuel codes,
 * grouped by RNALOG. One Maris call per fuel code (no rnalog filter) for efficiency.
 * Lines keep their date so a machine that went quiet can be cut off at a day.
 */
async function marisFuelByRnalog(
  fromDate: string,
  toDate: string,
  fuelCodes: string[],
): Promise<Map<string, MarisIssue[]>> {
  const datumOd = toMarisDate(`${fromDate}T00:00:00Z`);
  const datumDo = toMarisDate(`${toDate}T00:00:00Z`);
  const byRnalog = new Map<string, MarisIssue[]>();

  const allItems: MarisItem[] = [];
  for (const code of fuelCodes) {
    const items = await marisFetchItems({ datumOd, datumDo, artikl: code, rowCount: 0 });
    allItems.push(...items);
  }

  for (const it of allItems) {
    const rnalog = (it.RNALOG ?? '').trim();
    if (!rnalog) continue;
    const list = byRnalog.get(rnalog) ?? [];
    list.push({
      day: (it.DATUM ?? '').slice(0, 10),
      litres: Number(it.KOLICINA) || 0,
      value: Number(it.VRIJEDNOST) || 0,
    });
    byRnalog.set(rnalog, list);
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
    const lidat = lidatConsumption(m.serialNumber, fromIso, toIso);

    // Aggregate Maris across the machine's work orders, up to the same day LiDAT
    // is compared to when the machine went quiet before the end.
    let marisIssuedLitres = 0;
    let marisIssueCount = 0;
    let marisValue = 0;
    let marisAfterCutoffLitres = 0;
    for (const r of m.rnalogs) {
      for (const it of marisByRnalog.get(r.trim()) ?? []) {
        if (lidat.comparedUntil && it.day > lidat.comparedUntil) {
          marisAfterCutoffLitres += it.litres;
          continue;
        }
        marisIssuedLitres += it.litres;
        marisIssueCount += 1;
        marisValue += it.value;
      }
    }

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
      comparedUntil: lidat.comparedUntil,
      lidatSilentSince: lidat.silentSince,
      marisAfterCutoffLitres: round2(marisAfterCutoffLitres),
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
