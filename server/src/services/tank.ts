// Tank control. The LiDAT tank-level sensor is independent of the engine's fuel
// counter, which lets us check things the fuel comparison can't:
//
//  1. Each Maris issue slip against the rise the tank actually saw (a refuel).
//  2. Level drops the engine didn't burn — fuel leaving the tank some other way.
//  3. Between two fills to a full tank, what the second fill put back is what
//     left the tank; anything the engine didn't burn left another way. This works
//     even on coarse sensors that can't show individual drops.
//
// Only the level history the sync has stored is usable (LiDAT keeps ~14 days),
// so periods before the first sync that collected it have nothing to check.
import { config } from '../config.js';
import { db, getJsonSetting, setJsonSetting } from '../db/index.js';
import { marisFetchItems, toMarisDate } from '../maris/client.js';
import { getFuelArticleCodes } from './comparison.js';
import { listMachines, type Machine } from './machines.js';
import type { MachineGroup } from './groups.js';

// Readings on each side of a candidate step whose medians must differ. Requiring
// the change to persist rejects single-reading spikes from a machine standing on
// a slope or fuel sloshing.
const K = 3;

// A rise counts as a refuel when it exceeds all of these. On a coarse sensor a
// single step up that holds for a few readings is noise, so a refuel must span
// more than one of the sensor's steps.
const REFUEL_MIN_LITRES = 15;
const REFUEL_MIN_FRACTION = 0.06;
const REFUEL_MIN_SENSOR_STEPS = 1.5;

// Tank-size hint. A wrong capacity in LiDAT scales every rise the sensor shows,
// so the matched slips all come out the same multiple of their rise (91991: ~1.85×
// with 201 L; all matched at 360 L). Hint when enough slips agree on a multiple
// that far from 1.
const CAPACITY_HINT_MIN_SLIPS = 3;
const CAPACITY_HINT_MIN_RISE_LITRES = 30; // small top-ups give noisy ratios
const CAPACITY_HINT_AGREE = 0.15; // a ratio "agrees" within ±15 % of the median
const CAPACITY_HINT_AGREEING_SHARE = 2 / 3;
const CAPACITY_HINT_LOW = 0.8;
const CAPACITY_HINT_HIGH = 1.25;

// A drop is flagged when the level fell this much more than the engine burned.
// Below one jerry can, well above the noise of a precise sensor. It must also
// span at least two of the sensor's own steps.
const DRAIN_MIN_LITRES = 15;
const DRAIN_MIN_FRACTION = 0.04;
const DRAIN_MIN_SENSOR_STEPS = 2;

// Steps closer together than this are one event (a fill in two goes).
const MERGE_HOURS = 3;

// Sensor resolution is judged on the machine's recent readings (not just the
// selected range), from the 75th percentile of its non-zero moves: precise
// sensors move 1–3 % at a time, coarse ones 5–15 %. A coarse sensor holds its
// value while the engine burns, then drops a whole step at once — which would
// read as fuel vanishing — so drops are only checked on precise sensors.
const SENSOR_SAMPLE = 2000;
const COARSE_STEP_PCT = 4;
// Fewer moves than this and the resolution can't be judged.
const MIN_SENSOR_MOVES = 10;

// The fuel counter must have reported within this many hours of a level reading
// (they normally arrive in the same message), or a drop can't be checked against
// consumption — e.g. a machine whose counter went silent while its tank sensor
// kept reporting. A counter that lags would otherwise read as fuel vanishing.
const FUEL_COVERAGE_HOURS = 1;

// Slip vs refuel tolerance: the largest of a flat margin, a share of the slip and
// the sensor's own resolution — a rise read off a stepped sensor can be a step
// off at either end (and a brim-full tank reads 100 % a little early).
const SLIP_TOLERANCE_LITRES = 20;
const SLIP_TOLERANCE_FRACTION = 0.15;
const SLIP_TOLERANCE_SENSOR_STEPS = 2;

// Slips are sometimes dated the day before or after the fill.
const SLIP_MATCH_DAYS = 1;

// A fill counts as "to full" when the tank reads at least this share afterwards.
const FULL_FRACTION = 0.95;

// A fill-to-fill cycle is flagged when more than this went missing beyond any
// drops already flagged inside it.
const CYCLE_MIN_LITRES = 30;
const CYCLE_MIN_FRACTION = 0.25;

// Extra days of readings around the range, so an event early on the first day
// still has context (covers a weekend or a short holiday), and a fill-to-fill
// cycle ending in the range can start before it.
const PAD_BEFORE_DAYS = 4;
const PAD_AFTER_DAYS = 1;

// Cap on chart points sent to the browser.
const MAX_SERIES_POINTS = 2000;

// The first sync that collects tank levels backfills LiDAT's ~14 days. A level
// older than that is a stale snapshot value from a machine that went quiet long
// ago, not history — it must not make collection look older than it is.
const BACKFILL_DAYS = 14;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// LiDAT reports some tank sizes wrongly, which scales every litre read off the
// sensor. An admin can correct a machine's capacity; the sync keeps refreshing
// machine.fuel_tank_capacity from LiDAT, so corrections live in settings.
const CAPACITY_OVERRIDES_KEY = 'tankCapacityOverrides';

/** 'unknown' = too few level changes to judge; treated like coarse. */
export type SensorQuality = 'fine' | 'coarse' | 'unknown' | 'none';

export interface TankRefuel {
  time: string; // first reading at the higher level (UTC)
  prevTime: string; // last reading before the fill
  litres: number; // rise seen by the tank sensor
  levelBefore: number;
  levelAfter: number;
}

export interface TankDrain {
  time: string;
  prevTime: string;
  litres: number; // drop the engine didn't burn
  burnedLitres: number; // engine consumption across the same readings
  levelBefore: number;
  levelAfter: number;
  // Where the machine was that day (its stored daily GPS fix), if known.
  latitude: number | null;
  longitude: number | null;
  locationTime: string | null;
}

/** From one fill to a full tank to the next. */
export interface TankCycle {
  start: string; // the fill that opens the cycle
  end: string; // the next fill to full
  refilledLitres: number; // what the closing fill put back = what left the tank
  refillSource: 'maris' | 'sensor'; // Maris when the slip matched, else the sensor rise
  burnedLitres: number; // what the engine burned in between
  missingLitres: number; // refilled − burned
  drainLitres: number; // drops already flagged inside the cycle
}

export type SlipStatus = 'ok' | 'mismatch' | 'no_refuel' | 'no_data';

export interface TankSlipCheck {
  date: string; // slip date YYYY-MM-DD
  dokBroj: number;
  sklSifra: string;
  sklNaziv: string;
  rnalog: string;
  marisLitres: number;
  tankLitres: number | null; // rise of the matched refuel
  refuelTime: string | null;
  differenceLitres: number | null; // Maris − tank
  status: SlipStatus;
}

export interface TankMachineAnalysis {
  serialNumber: string;
  model: string;
  equipmentId: string | null;
  group: MachineGroup;
  tankCapacity: number | null; // the one used: correction if set, else LiDAT's
  lidatTankCapacity: number | null;
  capacityCorrected: boolean;
  sensor: SensorQuality;
  sensorStepLitres: number | null;
  levelReadings: number; // readings inside the range
  firstLevelTime: string | null; // earliest collected level reading for this machine
  refuels: TankRefuel[];
  drains: TankDrain[]; // only for precise sensors with a working fuel counter
  cycles: TankCycle[];
  slips: TankSlipCheck[];
  refuelsWithoutSlip: TankRefuel[]; // no izdatnica even after the Maris grace period
  refuelsAwaitingSlip: TankRefuel[]; // no izdatnica yet, still inside the grace period
  // Slips consistently a multiple of the tank rise: the capacity is likely wrong.
  capacityHint: CapacityHint | null;
}

export interface CapacityHint {
  ratio: number; // median Maris / tank rise
  agreeing: number; // slips within ±15 % of that ratio
  slips: number; // slips considered
  suggestedLitres: number; // current capacity × ratio
}

export interface TankMachineSummary {
  serialNumber: string;
  model: string;
  equipmentId: string | null;
  group: MachineGroup;
  tankCapacity: number | null;
  capacityCorrected: boolean;
  sensor: SensorQuality;
  sensorStepLitres: number | null;
  levelReadings: number;
  refuelCount: number;
  refuelLitres: number;
  slipCount: number;
  slipOk: number;
  slipMismatch: number;
  slipNoRefuel: number;
  slipNoData: number;
  refuelsWithoutSlip: number;
  refuelsAwaitingSlip: number;
  drainCount: number;
  drainLitres: number;
  cycleCount: number;
  cycleRefilledLitres: number;
  cycleMissingLitres: number;
  capacitySuspect: boolean;
}

export type TankEventKind =
  | 'drain'
  | 'cycle_loss'
  | 'slip_mismatch'
  | 'slip_no_refuel'
  | 'refuel_no_slip'
  | 'refuel_awaiting_slip';

export interface TankEvent {
  kind: TankEventKind;
  serialNumber: string;
  model: string;
  group: MachineGroup;
  day: string; // local (Zagreb) calendar day
  time: string | null; // when the sensor saw it; null for a slip with no refuel
  // drain: unburned litres; cycle_loss: missing beyond flagged drains;
  // slip events: Maris litres; refuel_no_slip: tank litres
  litres: number;
  tankLitres: number | null;
  marisLitres: number | null;
  burnedLitres: number | null; // cycle_loss: what the engine burned in the cycle
  since: string | null; // cycle_loss: the fill that opened the cycle
  dokBroj: number | null;
}

export interface TankOverview {
  from: string;
  to: string;
  generatedAt: string;
  levelHistoryFrom: string | null; // earliest collected level reading, any machine
  // Set when Maris couldn't be reached: drains are still reported, slip checks aren't.
  marisError: string | null;
  marisGraceDays: number;
  machines: TankMachineSummary[];
  events: TankEvent[];
}

export interface TankDetail extends TankMachineAnalysis {
  from: string;
  to: string;
  marisError: string | null;
  levelSeries: Array<{ t: string; litres: number }>;
  // Newest LiDAT reading of any kind for this machine (fuel or tank level),
  // whatever the selected range: when LiDAT last reported it.
  lastLidatTime: string | null;
  marisGraceDays: number;
}

interface LevelPoint {
  time: string;
  ms: number;
  percent: number;
  litres: number;
}

interface FuelPoint {
  ms: number;
  cum: number;
}

interface SlipInput {
  date: string;
  dokBroj: number;
  sklSifra: string;
  sklNaziv: string;
  rnalog: string;
  litres: number;
}

// ---- helpers ----

const zagrebDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zagreb',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar day in Croatia (Maris slips carry local dates, sensors UTC times). */
function localDay(iso: string): string {
  return zagrebDay.format(new Date(iso));
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
}

function quantile(values: number[], q: number): number {
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function median(values: number[]): number {
  return quantile(values, 0.5);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Stored reading_time has no milliseconds; keep that shape so string comparison holds. */
function isoAt(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function loadLevels(serial: string, fromIso: string, toIso: string, capacity: number): LevelPoint[] {
  const rows = db
    .prepare(
      `SELECT reading_time, percent FROM lidat_fuel_level
       WHERE serial_number = ? AND reading_time >= ? AND reading_time <= ?
       ORDER BY reading_time`,
    )
    .all(serial, fromIso, toIso) as Array<{ reading_time: string; percent: number }>;
  return rows.map((r) => ({
    time: r.reading_time,
    ms: Date.parse(r.reading_time),
    percent: r.percent,
    litres: (r.percent / 100) * capacity,
  }));
}

function loadFuel(serial: string, fromIso: string, toIso: string): FuelPoint[] {
  const rows = db
    .prepare(
      `SELECT reading_time, fuel_consumed_cum FROM lidat_fuel_reading
       WHERE serial_number = ? AND reading_time >= ? AND reading_time <= ?
       ORDER BY reading_time`,
    )
    .all(serial, fromIso, toIso) as Array<{ reading_time: string; fuel_consumed_cum: number }>;
  return rows.map((r) => ({ ms: Date.parse(r.reading_time), cum: r.fuel_consumed_cum }));
}

/** Resolution of a machine's tank sensor, judged on its recent readings. */
function classifySensor(serial: string): { quality: SensorQuality; stepPct: number | null } {
  const rows = db
    .prepare(
      `SELECT percent FROM lidat_fuel_level WHERE serial_number = ?
       ORDER BY reading_time DESC LIMIT ?`,
    )
    .all(serial, SENSOR_SAMPLE) as Array<{ percent: number }>;
  if (rows.length === 0) return { quality: 'none', stepPct: null };
  const moves: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const d = Math.abs(rows[i].percent - rows[i - 1].percent);
    if (d > 0) moves.push(d);
  }
  if (moves.length < MIN_SENSOR_MOVES) {
    return { quality: 'unknown', stepPct: moves.length ? quantile(moves, 0.75) : null };
  }
  const step = quantile(moves, 0.75);
  return { quality: step > COARSE_STEP_PCT ? 'coarse' : 'fine', stepPct: step };
}

/** Engine consumption so far at any instant, from the fuel counter readings. */
interface BurnIndex {
  /** Litres burned up to the last counter reading at or before `ms` (null before the first). */
  at(ms: number): number | null;
  /** Whether the counter reported close enough to `ms` to be trusted there. */
  covered(ms: number): boolean;
}

function burnIndex(fuel: FuelPoint[]): BurnIndex {
  // Sum only increases: a counter that resets (one machine's does, daily) then
  // keeps counting from its new value.
  const burned: number[] = [];
  let total = 0;
  for (let j = 0; j < fuel.length; j++) {
    if (j > 0) total += Math.max(0, fuel[j].cum - fuel[j - 1].cum);
    burned.push(total);
  }
  const lastAtOrBefore = (ms: number): number => {
    let lo = 0;
    let hi = fuel.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fuel[mid].ms <= ms) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };
  const coverMs = FUEL_COVERAGE_HOURS * HOUR_MS;
  return {
    at(ms) {
      const j = lastAtOrBefore(ms);
      return j < 0 ? null : burned[j];
    },
    covered(ms) {
      const j = lastAtOrBefore(ms);
      if (j < 0) return false;
      const next = j + 1 < fuel.length ? fuel[j + 1].ms - ms : Infinity;
      return Math.min(ms - fuel[j].ms, next) <= coverMs;
    },
  };
}

interface Step {
  start: number; // first index at the new level
  end: number; // last index of a merged step
  before: number;
  after: number;
}

/**
 * Persistent upward steps in `values`: one reading jumps at least half the
 * threshold AND the median of the next K readings clears the median of the
 * previous K by the full threshold. Steps within MERGE_HOURS are one event.
 */
function findSteps(
  values: number[],
  ms: number[],
  threshold: number,
  usable: (i: number) => boolean = () => true,
): Step[] {
  const out: Step[] = [];
  for (let i = K; i + K <= values.length; i++) {
    if (!usable(i)) continue;
    if (values[i] - values[i - 1] <= threshold / 2) continue;
    const before = median(values.slice(i - K, i));
    const after = median(values.slice(i, i + K));
    if (after - before <= threshold) continue;
    const last = out[out.length - 1];
    if (last && ms[i] - ms[last.end] < MERGE_HOURS * HOUR_MS) {
      last.end = i;
      last.after = Math.max(last.after, after);
      continue;
    }
    out.push({ start: i, end: i, before, after });
  }
  return out;
}

function detectRefuels(levels: LevelPoint[], capacity: number, stepLitres: number): TankRefuel[] {
  const threshold = Math.max(
    REFUEL_MIN_LITRES,
    REFUEL_MIN_FRACTION * capacity,
    REFUEL_MIN_SENSOR_STEPS * stepLitres,
  );
  return findSteps(
    levels.map((p) => p.litres),
    levels.map((p) => p.ms),
    threshold,
  ).map((s) => ({
    time: levels[s.start].time,
    prevTime: levels[s.start - 1].time,
    litres: round1(s.after - s.before),
    levelBefore: round1(s.before),
    levelAfter: round1(s.after),
  }));
}

/**
 * Drops the engine didn't account for. At each level reading, "unexplained" =
 * −(litres in tank + litres burned so far): it stays flat while the engine burns
 * what leaves the tank, falls at a refuel, and rises when fuel leaves unburned.
 */
function detectDrains(
  levels: LevelPoint[],
  burn: BurnIndex,
  capacity: number,
  stepLitres: number,
): TankDrain[] {
  if (levels.length === 0) return [];
  const burnedAt = levels.map((p) => burn.at(p.ms) ?? 0);
  const covered = levels.map((p) => burn.covered(p.ms));
  const unexplained = levels.map((p, i) => -(p.litres + burnedAt[i]));
  const usable = (i: number) => {
    for (let k = i - K; k < i + K; k++) if (!covered[k]) return false;
    return true;
  };
  const threshold = Math.max(
    DRAIN_MIN_LITRES,
    DRAIN_MIN_FRACTION * capacity,
    DRAIN_MIN_SENSOR_STEPS * stepLitres,
  );

  return findSteps(
    unexplained,
    levels.map((p) => p.ms),
    threshold,
    usable,
  ).map((s) => ({
    time: levels[s.start].time,
    prevTime: levels[s.start - 1].time,
    litres: round1(s.after - s.before),
    burnedLitres: round1(burnedAt[s.end] - burnedAt[s.start - 1]),
    levelBefore: round1(median(levels.slice(s.start - K, s.start).map((p) => p.litres))),
    levelAfter: round1(median(levels.slice(s.end, s.end + K).map((p) => p.litres))),
    latitude: null,
    longitude: null,
    locationTime: null,
  }));
}

/**
 * Fill-to-fill balance. Between two fills that both leave the tank full, the
 * closing fill puts back exactly what left the tank; the engine counter says how
 * much of that it burned. The Maris quantity is used for the refill when its slip
 * matched the sensor (it's metered, the sensor only approximate).
 */
function refillCycles(
  refuels: TankRefuel[],
  burn: BurnIndex,
  capacity: number,
  marisByRefuel: Map<string, number>,
  drains: TankDrain[],
): TankCycle[] {
  const full = (r: TankRefuel) => r.levelAfter >= FULL_FRACTION * capacity;
  const out: TankCycle[] = [];
  for (let i = 1; i < refuels.length; i++) {
    const open = refuels[i - 1];
    const close = refuels[i];
    if (!full(open) || !full(close)) continue;
    const startMs = Date.parse(open.time);
    const endMs = Date.parse(close.prevTime);
    if (!burn.covered(startMs) || !burn.covered(endMs)) continue;
    const burnedStart = burn.at(startMs);
    const burnedEnd = burn.at(endMs);
    if (burnedStart === null || burnedEnd === null) continue;

    const maris = marisByRefuel.get(close.time);
    const refilled = maris ?? close.litres;
    const burned = burnedEnd - burnedStart;
    const drainLitres = drains
      .filter((d) => d.time > open.time && d.time <= close.time)
      .reduce((s, d) => s + d.litres, 0);
    out.push({
      start: open.time,
      end: close.time,
      refilledLitres: round1(refilled),
      refillSource: maris !== undefined ? 'maris' : 'sensor',
      burnedLitres: round1(burned),
      missingLitres: round1(refilled - burned),
      drainLitres: round1(drainLitres),
    });
  }
  return out;
}

/** The machine's stored daily GPS fix for the day of `iso` (or the last one before it). */
function locateAt(
  serial: string,
  iso: string,
): Pick<TankDrain, 'latitude' | 'longitude' | 'locationTime'> {
  const row = db
    .prepare(
      `SELECT latitude, longitude, reading_time FROM lidat_location
       WHERE serial_number = ? AND day <= ? ORDER BY day DESC LIMIT 1`,
    )
    .get(serial, iso.slice(0, 10)) as
    | { latitude: number; longitude: number; reading_time: string }
    | undefined;
  return row
    ? { latitude: row.latitude, longitude: row.longitude, locationTime: row.reading_time }
    : { latitude: null, longitude: null, locationTime: null };
}

/**
 * Pair each slip with a refuel the sensor saw: same local day first, then a day
 * either side, preferring the closest volume. Leftover refuels had no slip.
 */
function checkSlips(
  slips: SlipInput[],
  refuels: TankRefuel[],
  levelDays: Set<string>,
  stepLitres: number,
): { checks: TankSlipCheck[]; unmatched: TankRefuel[] } {
  const pool = refuels.map((r) => ({ r, day: localDay(r.time), used: false }));
  const sorted = [...slips].sort((a, b) => a.date.localeCompare(b.date) || a.dokBroj - b.dokBroj);
  const match = new Map<SlipInput, (typeof pool)[number]>();

  for (let maxDays = 0; maxDays <= SLIP_MATCH_DAYS; maxDays++) {
    for (const s of sorted) {
      if (match.has(s)) continue;
      let best: (typeof pool)[number] | null = null;
      for (const c of pool) {
        if (c.used || Math.abs(dayDiff(c.day, s.date)) > maxDays) continue;
        if (!best || Math.abs(c.r.litres - s.litres) < Math.abs(best.r.litres - s.litres)) best = c;
      }
      if (best) {
        best.used = true;
        match.set(s, best);
      }
    }
  }

  const checks = sorted.map((s): TankSlipCheck => {
    const base = {
      date: s.date,
      dokBroj: s.dokBroj,
      sklSifra: s.sklSifra,
      sklNaziv: s.sklNaziv,
      rnalog: s.rnalog,
      marisLitres: s.litres,
    };
    const m = match.get(s);
    if (m) {
      const difference = s.litres - m.r.litres;
      const tolerance = Math.max(
        SLIP_TOLERANCE_LITRES,
        SLIP_TOLERANCE_FRACTION * s.litres,
        SLIP_TOLERANCE_SENSOR_STEPS * stepLitres,
      );
      return {
        ...base,
        tankLitres: m.r.litres,
        refuelTime: m.r.time,
        differenceLitres: round1(difference),
        status: Math.abs(difference) <= tolerance ? 'ok' : 'mismatch',
      };
    }
    // No rise found: only a finding if the sensor was reporting around the slip,
    // and also on some day before and after it — a fill before the first reading
    // (collection just started) or after the latest one isn't visible.
    const days = [...levelDays];
    const seen =
      [-1, 0, 1].some((d) => levelDays.has(shiftDay(s.date, d))) &&
      days.some((d) => d < s.date) &&
      days.some((d) => d > s.date);
    return {
      ...base,
      tankLitres: null,
      refuelTime: null,
      differenceLitres: null,
      status: seen ? 'no_refuel' : 'no_data',
    };
  });

  return { checks, unmatched: pool.filter((c) => !c.used).map((c) => c.r) };
}

/**
 * Positive fuel issues from Maris for [from, to], grouped by work order. A Maris
 * outage is reported rather than thrown: drains don't need Maris.
 */
async function marisSlips(
  from: string,
  to: string,
): Promise<{ byRnalog: Map<string, SlipInput[]>; error: string | null }> {
  const datumOd = toMarisDate(`${from}T00:00:00Z`);
  const datumDo = toMarisDate(`${to}T00:00:00Z`);
  const byRnalog = new Map<string, SlipInput[]>();
  try {
    for (const code of getFuelArticleCodes()) {
      const items = await marisFetchItems({ datumOd, datumDo, artikl: code, rowCount: 0 });
      for (const it of items) {
        const rnalog = (it.RNALOG ?? '').trim();
        const litres = Number(it.KOLICINA) || 0;
        // A reversal (storno) is negative and has no fill of its own to match.
        if (!rnalog || litres <= 0) continue;
        const list = byRnalog.get(rnalog) ?? [];
        list.push({
          date: String(it.DATUM).slice(0, 10),
          dokBroj: it.DOK_BROJ,
          sklSifra: it.SKL_SIFRA,
          sklNaziv: it.SKL_NAZIV,
          rnalog,
          litres,
        });
        byRnalog.set(rnalog, list);
      }
    }
  } catch (err) {
    return { byRnalog: new Map(), error: err instanceof Error ? err.message : String(err) };
  }
  return { byRnalog, error: null };
}

function slipsFor(m: Machine, byRnalog: Map<string, SlipInput[]>): SlipInput[] {
  return m.rnalogs.flatMap((r) => byRnalog.get(r.trim()) ?? []);
}

/** See CAPACITY_HINT_*: a consistent Maris-to-rise multiple far from 1. */
function capacityHint(checks: TankSlipCheck[], capacity: number | null): CapacityHint | null {
  if (!capacity) return null;
  const ratios = checks
    .filter((c) => c.tankLitres !== null && c.tankLitres >= CAPACITY_HINT_MIN_RISE_LITRES)
    .map((c) => c.marisLitres / c.tankLitres!);
  if (ratios.length < CAPACITY_HINT_MIN_SLIPS) return null;
  const ratio = median(ratios);
  if (ratio >= CAPACITY_HINT_LOW && ratio <= CAPACITY_HINT_HIGH) return null;
  const agreeing = ratios.filter((r) => Math.abs(r / ratio - 1) <= CAPACITY_HINT_AGREE).length;
  if (agreeing < CAPACITY_HINT_AGREEING_SHARE * ratios.length) return null;
  return {
    ratio: Math.round(ratio * 100) / 100,
    agreeing,
    slips: ratios.length,
    suggestedLitres: Math.round((capacity * ratio) / 5) * 5,
  };
}

function capacityOverrides(): Record<string, number> {
  return getJsonSetting<Record<string, number>>(CAPACITY_OVERRIDES_KEY, {});
}

/** Set (or with null, clear) an admin correction of a machine's tank size. */
export function setTankCapacityOverride(serial: string, litres: number | null): void {
  const all = capacityOverrides();
  if (litres === null) delete all[serial];
  else all[serial] = litres;
  setJsonSetting(CAPACITY_OVERRIDES_KEY, all);
}

/** Earliest reading_time that belongs to collected history (see BACKFILL_DAYS). */
function collectionFloor(): string | null {
  const first = (
    db.prepare('SELECT MIN(fetched_at) t FROM lidat_fuel_level').get() as { t: string | null }
  ).t;
  return first ? isoAt(Date.parse(first) - BACKFILL_DAYS * DAY_MS) : null;
}

/** First collected level reading, for one machine or (no serial) the whole fleet. */
function firstLevelSince(floor: string | null, serial?: string): string | null {
  if (!floor) return null;
  const row = (
    serial
      ? db
          .prepare(
            'SELECT MIN(reading_time) t FROM lidat_fuel_level WHERE serial_number = ? AND reading_time >= ?',
          )
          .get(serial, floor)
      : db.prepare('SELECT MIN(reading_time) t FROM lidat_fuel_level WHERE reading_time >= ?').get(floor)
  ) as { t: string | null };
  return row.t ?? null;
}

function analyseMachine(
  m: Machine,
  from: string,
  to: string,
  slips: SlipInput[],
  marisOk: boolean,
  floor: string | null,
  overrides: Record<string, number>,
): { analysis: TankMachineAnalysis; levels: LevelPoint[] } {
  const inRange = (day: string) => day >= from && day <= to;
  const corrected = overrides[m.serialNumber];
  const capacity = corrected ?? m.fuelTankCapacity;
  const loadFrom = isoAt(Date.parse(`${from}T00:00:00Z`) - PAD_BEFORE_DAYS * DAY_MS);
  const loadTo = isoAt(Date.parse(`${to}T23:59:59Z`) + PAD_AFTER_DAYS * DAY_MS);

  // Without a capacity the percentages can't be turned into litres.
  const { quality, stepPct } = capacity
    ? classifySensor(m.serialNumber)
    : { quality: 'none' as const, stepPct: null };
  const levels = capacity ? loadLevels(m.serialNumber, loadFrom, loadTo, capacity) : [];
  const stepLitres = stepPct !== null && capacity ? (stepPct / 100) * capacity : 0;
  const burn = burnIndex(loadFuel(m.serialNumber, loadFrom, loadTo));

  const refuels = capacity ? detectRefuels(levels, capacity, stepLitres) : [];
  const drains =
    capacity && quality === 'fine' ? detectDrains(levels, burn, capacity, stepLitres) : [];
  const levelDays = new Set(levels.map((p) => localDay(p.time)));
  const { checks, unmatched } = checkSlips(slips, refuels, levelDays, stepLitres);
  // Refuels on or after this day may still get their izdatnica.
  const graceFrom = shiftDay(localDay(new Date().toISOString()), -config.marisGraceDays);

  // A matched slip that agreed with the sensor gives the metered refill volume.
  const marisByRefuel = new Map<string, number>();
  for (const c of checks) {
    if (c.status === 'ok' && c.refuelTime) marisByRefuel.set(c.refuelTime, c.marisLitres);
  }
  const cycles = capacity ? refillCycles(refuels, burn, capacity, marisByRefuel, drains) : [];

  const analysis: TankMachineAnalysis = {
    serialNumber: m.serialNumber,
    model: m.model,
    equipmentId: m.equipmentId,
    group: m.group,
    tankCapacity: capacity,
    lidatTankCapacity: m.fuelTankCapacity,
    capacityCorrected: corrected !== undefined,
    sensor: quality,
    sensorStepLitres: stepPct !== null && capacity ? round1(stepLitres) : null,
    levelReadings: levels.filter((p) => inRange(localDay(p.time))).length,
    firstLevelTime: firstLevelSince(floor, m.serialNumber),
    refuels: refuels.filter((r) => inRange(localDay(r.time))),
    drains: drains
      .filter((d) => inRange(localDay(d.time)))
      .map((d) => ({ ...d, ...locateAt(m.serialNumber, d.time) })),
    cycles: cycles.filter((c) => inRange(localDay(c.end))),
    slips: checks.filter((c) => inRange(c.date)),
    // Without Maris every refuel would look slip-less — say nothing instead.
    // Maris is entered late but dated the day of the fill, so a recent refuel
    // without one is waiting for Maris, not yet a finding.
    refuelsWithoutSlip: marisOk
      ? unmatched.filter((r) => inRange(localDay(r.time)) && localDay(r.time) < graceFrom)
      : [],
    refuelsAwaitingSlip: marisOk
      ? unmatched.filter((r) => inRange(localDay(r.time)) && localDay(r.time) >= graceFrom)
      : [],
    capacityHint: capacityHint(
      checks.filter((c) => inRange(c.date)),
      capacity,
    ),
  };
  return { analysis, levels: levels.filter((p) => inRange(localDay(p.time))) };
}

function summarise(a: TankMachineAnalysis): TankMachineSummary {
  const count = (s: SlipStatus) => a.slips.filter((c) => c.status === s).length;
  const sum = <T>(items: T[], f: (x: T) => number) => round1(items.reduce((s, x) => s + f(x), 0));
  return {
    serialNumber: a.serialNumber,
    model: a.model,
    equipmentId: a.equipmentId,
    group: a.group,
    tankCapacity: a.tankCapacity,
    capacityCorrected: a.capacityCorrected,
    sensor: a.sensor,
    sensorStepLitres: a.sensorStepLitres,
    levelReadings: a.levelReadings,
    refuelCount: a.refuels.length,
    refuelLitres: sum(a.refuels, (r) => r.litres),
    slipCount: a.slips.length,
    slipOk: count('ok'),
    slipMismatch: count('mismatch'),
    slipNoRefuel: count('no_refuel'),
    slipNoData: count('no_data'),
    refuelsWithoutSlip: a.refuelsWithoutSlip.length,
    refuelsAwaitingSlip: a.refuelsAwaitingSlip.length,
    drainCount: a.drains.length,
    drainLitres: sum(a.drains, (d) => d.litres),
    cycleCount: a.cycles.length,
    cycleRefilledLitres: sum(a.cycles, (c) => c.refilledLitres),
    cycleMissingLitres: sum(a.cycles, (c) => c.missingLitres),
    capacitySuspect: a.capacityHint !== null,
  };
}

function eventsOf(a: TankMachineAnalysis): TankEvent[] {
  const base = {
    serialNumber: a.serialNumber,
    model: a.model,
    group: a.group,
    tankLitres: null,
    marisLitres: null,
    burnedLitres: null,
    since: null,
    dokBroj: null,
  };
  const out: TankEvent[] = [];
  for (const d of a.drains) {
    out.push({ ...base, kind: 'drain', day: localDay(d.time), time: d.time, litres: d.litres });
  }
  for (const c of a.cycles) {
    // Only what the flagged drops inside the cycle don't already account for.
    const beyondDrains = c.missingLitres - c.drainLitres;
    if (beyondDrains < Math.max(CYCLE_MIN_LITRES, CYCLE_MIN_FRACTION * c.refilledLitres)) continue;
    out.push({
      ...base,
      kind: 'cycle_loss',
      day: localDay(c.end),
      time: c.end,
      litres: round1(beyondDrains),
      tankLitres: c.refilledLitres,
      burnedLitres: c.burnedLitres,
      since: c.start,
    });
  }
  for (const c of a.slips) {
    if (c.status !== 'mismatch' && c.status !== 'no_refuel') continue;
    out.push({
      ...base,
      kind: c.status === 'mismatch' ? 'slip_mismatch' : 'slip_no_refuel',
      day: c.date,
      time: c.refuelTime,
      litres: c.marisLitres,
      tankLitres: c.tankLitres,
      marisLitres: c.marisLitres,
      dokBroj: c.dokBroj,
    });
  }
  for (const [kind, refuels] of [
    ['refuel_no_slip', a.refuelsWithoutSlip],
    ['refuel_awaiting_slip', a.refuelsAwaitingSlip],
  ] as const) {
    for (const r of refuels) {
      out.push({ ...base, kind, day: localDay(r.time), time: r.time, litres: r.litres, tankLitres: r.litres });
    }
  }
  return out;
}

/** Every machine the caller may see: per-machine summary plus a flat list of findings. */
export async function buildTankOverview(
  from: string,
  to: string,
  allowed?: MachineGroup[],
): Promise<TankOverview> {
  const machines = listMachines(allowed);
  // Pad by the match window so a slip dated just outside the range still pairs
  // with a refuel just inside it (and vice versa).
  const maris = await marisSlips(shiftDay(from, -SLIP_MATCH_DAYS), shiftDay(to, SLIP_MATCH_DAYS));
  const floor = collectionFloor();
  const overrides = capacityOverrides();

  const summaries: TankMachineSummary[] = [];
  const events: TankEvent[] = [];
  for (const m of machines) {
    const { analysis } = analyseMachine(
      m,
      from,
      to,
      slipsFor(m, maris.byRnalog),
      !maris.error,
      floor,
      overrides,
    );
    summaries.push(summarise(analysis));
    events.push(...eventsOf(analysis));
  }
  events.sort(
    (a, b) => b.day.localeCompare(a.day) || (b.time ?? '').localeCompare(a.time ?? ''),
  );

  return {
    from,
    to,
    generatedAt: new Date().toISOString(),
    levelHistoryFrom: firstLevelSince(floor),
    marisError: maris.error,
    marisGraceDays: config.marisGraceDays,
    machines: summaries,
    events,
  };
}

/** One machine: the full analysis plus its tank-level series for the chart. */
export async function buildTankDetail(
  serial: string,
  from: string,
  to: string,
): Promise<TankDetail | null> {
  const m = listMachines().find((x) => x.serialNumber === serial);
  if (!m) return null;
  const maris = await marisSlips(shiftDay(from, -SLIP_MATCH_DAYS), shiftDay(to, SLIP_MATCH_DAYS));
  const { analysis, levels } = analyseMachine(
    m,
    from,
    to,
    slipsFor(m, maris.byRnalog),
    !maris.error,
    collectionFloor(),
    capacityOverrides(),
  );

  // Thin long ranges for the chart, but always keep the readings either side of
  // an event so its step stays visible.
  const keep = new Set<string>();
  for (const e of [...analysis.refuels, ...analysis.drains]) {
    keep.add(e.time);
    keep.add(e.prevTime);
  }
  const stride = Math.max(1, Math.ceil(levels.length / MAX_SERIES_POINTS));
  const levelSeries = levels
    .filter((p, i) => i % stride === 0 || i === levels.length - 1 || keep.has(p.time))
    .map((p) => ({ t: p.time, litres: round1(p.litres) }));

  // Both tables store ISO 8601 UTC, so the later string is the later time.
  const lastLevel = (
    db.prepare('SELECT MAX(reading_time) t FROM lidat_fuel_level WHERE serial_number = ?').get(serial) as {
      t: string | null;
    }
  ).t;
  const lastLidatTime =
    [m.lastReadingTime, lastLevel].filter((t): t is string => !!t).sort().at(-1) ?? null;

  return {
    ...analysis,
    from,
    to,
    marisError: maris.error,
    levelSeries,
    lastLidatTime,
    marisGraceDays: config.marisGraceDays,
  };
}
