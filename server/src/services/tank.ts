// Tank control. The LiDAT tank-level sensor is independent of the engine's fuel
// counter, which lets us check things the fuel comparison can't:
//
//  1. Each Maris issue slip against the rise the tank actually saw (a refuel).
//  2. Level drops the engine didn't burn — fuel leaving the tank some other way.
//  3. Between two fills to a full tank, what the second fill put back is what
//     left the tank; anything the engine didn't burn left another way. This works
//     even on coarse sensors that can't show individual drops.
//
// Every finding is meant to hold up when someone checks it, so wherever the data
// leaves room for doubt (a counter that lags or reset, a reading that comes back,
// a fill too small for the sensor) the analysis says nothing rather than guess.
//
// Only the level history the sync has stored is usable (LiDAT keeps ~14 days),
// so periods before the first sync that collected it have nothing to check.
import { config } from '../config.js';
import { db, getJsonSetting, setJsonSetting } from '../db/index.js';
import { marisFetchItems, toMarisDate } from '../maris/client.js';
import { getFuelArticleCodes } from './comparison.js';
import { listMachines, type Machine } from './machines.js';
import type { MachineGroup } from './groups.js';
import { reviewStats, reviewsOf } from './tankReviews.js';

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

// A drop is flagged when the level fell at least this much more than the engine
// can have burned, whatever the tank size; anything smaller counts as normal use.
// It must also span at least two of the sensor's own steps, or it can't be told
// from noise.
const DRAIN_MIN_LITRES = 15;
const DRAIN_MIN_SENSOR_STEPS = 2;

// A drop must still be there this long afterwards (or just before the next fill,
// if that comes sooner) — sloshing, foam settling or a moment on a slope isn't
// fuel leaving — and a drop at the very end of the data waits until readings
// that late arrive.
const DRAIN_HOLD_HOURS = 2;

// Fuel can't appear from nowhere, nor come back. A drop with a rise of similar
// size that no Maris slip accounts for within this many hours either side — the
// reading coming back, or rising first and falling back, like a machine parked
// on a slope — is the sensor, not fuel leaving: only what stays missing counts.
const PAIR_HOURS = 72;
// Rises from this share of the drop up to this multiple of it are its pair (a
// reading coming back is about the size it went); a larger one is a separate
// event, like a fill not yet booked.
const PAIR_MIN_SHARE = 0.25;
const PAIR_MAX_SHARE = 1.25;
// Smallest rise looked at for that; like a drop, it must clear the sensor's noise
// (DRAIN_MIN_SENSOR_STEPS of its steps).
const PAIR_MIN_LITRES = 7.5;

// A fuel counter that goes back by more than this was reset, and what the engine
// burned across the reset is unknown. Smaller dips are rounding. A counter seen
// resetting can also reset unseen while it's silent (back up past its old value
// by the next reading), so on such a counter a silence longer than this is
// unknown too.
const COUNTER_RESET_LITRES = 1;
const RESETTING_MAX_SILENCE_HOURS = 2;

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

// Slip vs refuel tolerance: the largest of a flat margin, a share of the slip and
// the sensor's own resolution — a rise read off a stepped sensor can be a step
// off at either end.
const SLIP_TOLERANCE_LITRES = 20;
const SLIP_TOLERANCE_FRACTION = 0.15;
const SLIP_TOLERANCE_SENSOR_STEPS = 2;

// Slips are sometimes dated the day before or after the fill.
const SLIP_MATCH_DAYS = 1;

// A fill that leaves the tank reading at least this full can have gone past the
// top of the sensor's range, so the rise it shows is only a lower bound. Above
// the sensor's 100 % the tank (and filler neck) still takes up to this share.
const BRIM_FRACTION = 0.98;
const BRIM_HEADROOM_FRACTION = 0.1;

// A slip no ordinary refuel accounts for is looked for again as a smaller rise:
// at least this share of the slip, and clear of the sensor's noise.
const TARGETED_MIN_SHARE = 0.5;
const TARGETED_MIN_LITRES = 7.5;
const TARGETED_MIN_SENSOR_STEPS = 2;
// A fill shows up to one sensor step short (at least this much), so a slip that
// small can't be checked against the sensor at all.
const SENSOR_READ_ERROR_LITRES = 5;

// Up to this many slips and fills of one day are tried in combination — one
// fill booked on two slips, or one slip for a fill in two goes.
const GROUP_MAX_ITEMS = 6;

// A fill counts as "to full" when the tank reads at least this share afterwards.
const FULL_FRACTION = 0.95;

// A fill-to-fill cycle is flagged when more than this went missing beyond any
// drops already flagged inside it.
const CYCLE_MIN_LITRES = 30;
const CYCLE_MIN_FRACTION = 0.25;

// Each machine is checked against what is metered, over the CALIBRATION_DAYS up
// to the end of the selected range (whatever its length):
//  - Maris: the tank rise against the booked quantity on single fills. Agreeing
//    within MARIS_AGREE says the tank size, and so every litre read off the
//    sensor, is right.
//  - Counter: from one rest to the next (the first readings after the machine
//    stood still, when the level has settled — the sensor lags while it works),
//    with no fill or flagged drop in between, the level falls by what the fuel
//    counter burned. Agreeing within COUNTER_AGREE (plus what the sensor's
//    resolution and parking spots allow) says the two can be compared, which
//    every fill-to-fill balance, and every drop while the engine ran, relies on.
const CALIBRATION_DAYS = 30;
const MARIS_CHECK_MIN_SLIPS = 3;
const MARIS_AGREE = 0.15;
const COUNTER_CHECK_MIN_LITRES = 100;
const COUNTER_AGREE = 0.15;
// No reading for this long and the machine stood still; its next readings are a rest point.
const REST_GAP_HOURS = 3;
// A rest point's level: the median of its first readings within this many minutes.
const REST_READING_MINUTES = 15;
// Rest to rest the machine must have burned at least this much to count.
const REST_MIN_BURN_LITRES = 5;
// What one rest point's level can be off by (parking on uneven ground), at least.
const REST_READ_ERROR_LITRES = 5;

// A finding is "sure" only when every check behind it holds; otherwise it is
// shown as "to check", with what to look at.
const SURE_MARGIN = 1.5; // the amount must clear its threshold by this factor
const SURE_MAX_RETURNED_SHARE = 0.25; // of a drop, at most this much may have come back
// A drop across a longer silence is said to have happened somewhere in it.
const LONG_SILENCE_HOURS = 24;
// The counter barely moving across a drop (this much, or this share of it) means
// the engine burned nothing worth counting, however accurate the counter is.
const IDLE_BURN_LITRES = 2;
const IDLE_BURN_SHARE = 0.1;
// GPS fixes this close to a drop's readings show where it happened; a machine
// that moved less than MOVED_METRES between them stood still.
const FIX_NEAR_HOURS = 3;
const MOVED_METRES = 100;
// The first reading after a silence comes as the engine starts, so a few minutes
// of running between the readings still means it stood still while fuel left.
const ENGINE_OFF_HOURS = 0.1;
// The raw readings behind one event are served for at most this long a window.
const READINGS_MAX_DAYS = 5;

// Extra days of readings (and Maris slips) around the range, so an event early on
// the first day still has context (a weekend or a short holiday), a fill-to-fill
// cycle ending in the range can start before it, and a drop near either end is
// checked for coming back (PAIR_HOURS) the same as one in the middle.
const PAD_BEFORE_DAYS = 4;
const PAD_AFTER_DAYS = 3;

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
  litres: number; // left the tank unburned and stayed missing
  burnedLitres: number; // the most the engine can have burned across the same readings
  returnedLitres: number; // part of the drop the reading got back soon after (or had gained just before)
  levelBefore: number;
  levelAfter: number;
  minLitres: number; // the threshold it had to clear
  engineHours: number | null; // engine running time between the readings either side
  // Where the machine stood when it happened (its GPS fix nearest the drop, or
  // that day's), and how far it moved between the fixes before and after.
  latitude: number | null;
  longitude: number | null;
  locationTime: string | null;
  movedMetres: number | null;
}

/** From one fill to a full tank to the next. */
export interface TankCycle {
  start: string; // the fill that opens the cycle
  end: string; // the next fill to full
  refilledLitres: number; // what the closing fill put back
  refillSource: 'maris' | 'sensor'; // Maris when the slip matched, else the sensor rise
  burnedLitres: number; // the most the engine can have burned in between
  levelChangeLitres: number; // level after the closing fill − after the opening one
  missingLitres: number; // refilled − level change − burned
  drainLitres: number; // drops already flagged inside the cycle
}

// 'too_small': no rise found, but the slip is too small for this sensor to show.
export type SlipStatus = 'ok' | 'mismatch' | 'no_refuel' | 'too_small' | 'no_data';

export interface TankSlipCheck {
  date: string; // slip date YYYY-MM-DD
  dokBroj: number;
  sklSifra: string;
  sklNaziv: string;
  rnalog: string;
  marisLitres: number;
  tankLitres: number | null; // rise of the matched refuel(s)
  refuelTime: string | null;
  differenceLitres: number | null; // Maris − tank (checked together: the slips' total − the fills')
  status: SlipStatus;
  // Checked together with these other slips (one fill booked on several of them),
  // and against this many fills (two for one slip covering a fill in two goes).
  sharedWith: number[];
  fills: number;
  sensorThatDay: boolean; // the tank sensor reported on the slip's date
}

export type CheckStatus = 'ok' | 'off' | 'unknown';

/** The machine against what is metered (see CALIBRATION_DAYS). */
export interface TankCalibration {
  maris: { status: CheckStatus; ratio: number | null; slips: number }; // tank rise ÷ booked
  counter: { status: CheckStatus; ratio: number | null; burnedLitres: number }; // level drop ÷ burned, working
}

export interface EventReason {
  ok: boolean; // false: something to check before acting on the event
  text: string;
}

export type Confidence = 'sure' | 'check';

export type ReviewVerdict = 'confirmed' | 'false_alarm';

export interface TankReview {
  verdict: ReviewVerdict;
  note: string;
  username: string;
  updatedAt: string;
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
  calibration: TankCalibration;
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
  slipUnchecked: number; // no level data around it, or too small for the sensor
  refuelsWithoutSlip: number;
  refuelsAwaitingSlip: number;
  drainCount: number;
  drainLitres: number;
  cycleCount: number;
  cycleRefilledLitres: number;
  cycleMissingLitres: number;
  capacitySuspect: boolean;
  calibration: TankCalibration;
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
  levelChangeLitres: number | null; // cycle_loss: level after the closing fill − after the opening one
  returnedLitres: number | null; // drain: part of the drop the reading got back
  since: string | null; // cycle_loss: the fill that opened the cycle
  dokBroj: number | null;
  key: string; // stable id, for reviews
  confidence: Confidence | null; // null for refuels still waiting for Maris (not a finding)
  reasons: EventReason[];
  review: TankReview | null;
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
  // All reviews so far of the machines shown, by kind: how often each kind held up.
  reviewStats: Record<TankEventKind, { confirmed: number; falseAlarm: number }>;
}

export interface TankDetail extends TankMachineAnalysis {
  from: string;
  to: string;
  marisError: string | null;
  levelSeries: Array<{ t: string; litres: number }>;
  // Newest LiDAT reading of any kind for this machine (fuel or tank level),
  // whatever the selected range: when LiDAT last reported it.
  lastLidatTime: string | null;
  // Where the machine was at the end of the range: its last stored GPS fix up to
  // that day (today's comes from the fleet snapshot).
  location: Pick<TankDrain, 'latitude' | 'longitude' | 'locationTime'>;
  marisGraceDays: number;
  events: TankEvent[]; // this machine's findings, judged on its own data
}

/** The raw readings behind an event, for checking it by hand. */
export interface TankReadings {
  serialNumber: string;
  capacity: number | null;
  levels: Array<{ t: string; litres: number }>;
  counter: Array<{ t: string; litres: number }>; // cumulative, as the counter reports it
  engine: Array<{ t: string; hours: number }>; // cumulative operating hours
  fixes: Array<{ t: string; latitude: number; longitude: number }>;
}

export interface LevelPoint {
  time: string;
  ms: number;
  percent: number;
  litres: number;
}

export interface FuelPoint {
  ms: number;
  cum: number;
}

export interface SlipInput {
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

/** Indices a, a+1, …, b−1. */
function span(a: number, b: number): number[] {
  return Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
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

/** Cumulative engine operating hours, in the same shape as the fuel counter. */
function loadHours(serial: string, fromIso: string, toIso: string): FuelPoint[] {
  const rows = db
    .prepare(
      `SELECT reading_time, hours_cum FROM lidat_hours_reading
       WHERE serial_number = ? AND metric = 'operating' AND reading_time >= ? AND reading_time <= ?
       ORDER BY reading_time`,
    )
    .all(serial, fromIso, toIso) as Array<{ reading_time: string; hours_cum: number }>;
  return rows.map((r) => ({ ms: Date.parse(r.reading_time), cum: r.hours_cum }));
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

/**
 * Engine consumption so far at any instant, from the fuel counter readings. The
 * counter reports on its own schedule, so between two of its readings all we know
 * is that the burn so far lies between them; a level reading after the counter's
 * latest one can't be checked until the counter reports again.
 */
interface BurnIndex {
  /** Best estimate: linear between the counter readings either side (null before the first). */
  at(ms: number): number | null;
  /**
   * What the counter allows the burn so far to be at `ms`: between its readings
   * either side (one value when a reading falls on `ms`). Null when there is no
   * reading on both sides, or the counter was reset in between.
   */
  bounds(ms: number): { lo: number; hi: number } | null;
  /**
   * Whether what the engine burned between the two instants can't be pinned
   * down: the counter was reset in between (or, on a counter that resets, went
   * silent long enough to have reset unseen).
   */
  unknownBetween(fromMs: number, toMs: number): boolean;
}

function burnIndex(fuel: FuelPoint[]): BurnIndex {
  // Sum of the counter's moves: a counter that resets (one machine's does, daily)
  // keeps counting from its new value, and its burn across the reset is unknown.
  const burned: number[] = [];
  const resetAfter: boolean[] = [];
  let total = 0;
  for (let j = 0; j < fuel.length; j++) {
    if (j > 0) {
      const d = fuel[j].cum - fuel[j - 1].cum;
      resetAfter[j - 1] = d < -COUNTER_RESET_LITRES;
      if (d > 0) total += d;
    }
    burned.push(total);
  }
  const resets = resetAfter.some(Boolean);
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
  return {
    at(ms) {
      const j = lastAtOrBefore(ms);
      if (j < 0) return null;
      if (fuel[j].ms === ms || j + 1 >= fuel.length || resetAfter[j]) return burned[j];
      const f = (ms - fuel[j].ms) / (fuel[j + 1].ms - fuel[j].ms);
      return burned[j] + f * (burned[j + 1] - burned[j]);
    },
    bounds(ms) {
      const j = lastAtOrBefore(ms);
      if (j < 0) return null;
      if (fuel[j].ms === ms) return { lo: burned[j], hi: burned[j] };
      if (j + 1 >= fuel.length || resetAfter[j]) return null;
      return { lo: burned[j], hi: burned[j + 1] };
    },
    unknownBetween(fromMs, toMs) {
      for (let j = 0; j + 1 < fuel.length; j++) {
        if (fuel[j].ms >= toMs || fuel[j + 1].ms <= fromMs) continue;
        if (resetAfter[j]) return true;
        if (resets && fuel[j + 1].ms - fuel[j].ms > RESETTING_MAX_SILENCE_HOURS * HOUR_MS) return true;
      }
      return false;
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
 * Persistent upward steps in `values`: one reading jumps more than half the
 * threshold AND the median of the next K readings is at least the full
 * threshold above the median of the previous K. Steps within MERGE_HOURS are one event.
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
    if (after - before < threshold) continue;
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

/** Level rises of at least `threshold` litres, as refuels. */
function risesOf(levels: LevelPoint[], threshold: number): TankRefuel[] {
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

function detectRefuels(levels: LevelPoint[], capacity: number, stepLitres: number): TankRefuel[] {
  return risesOf(
    levels,
    Math.max(REFUEL_MIN_LITRES, REFUEL_MIN_FRACTION * capacity, REFUEL_MIN_SENSOR_STEPS * stepLitres),
  );
}

/** A fill with the Maris quantity booked on it (null when several fills share one total). */
interface MeteredFill {
  time: string;
  maris: number | null;
  tolerance: number;
}

function withinMerge(a: string | number, b: string | number): boolean {
  const ms = (t: string | number) => (typeof t === 'number' ? t : Date.parse(t));
  return Math.abs(ms(a) - ms(b)) <= MERGE_HOURS * HOUR_MS;
}

/**
 * Drops the engine didn't account for. At each level reading, "unexplained" =
 * −(litres in tank + litres burned so far): it stays flat while the engine burns
 * what leaves the tank, falls at a refuel, and rises when fuel leaves unburned.
 *
 * A candidate drop is then held to everything that could explain it away: the
 * most the counter allows the engine to have burned, the reading still being down
 * DRAIN_HOLD_HOURS later, and no unbooked rise of similar size around it. Returns
 * the drains, the unbooked fills that turned out to be the other half of a drop
 * that came back (sensor, not fuel), and for booked fills that read high, how much
 * of the rise fell away again.
 */
function detectDrains(
  levels: LevelPoint[],
  burn: BurnIndex,
  stepLitres: number,
  refuels: TankRefuel[],
  unbookedFills: TankRefuel[],
  metered: MeteredFill[],
): { drains: TankDrain[]; phantomFills: Set<string>; settled: Map<string, number> } {
  const phantomFills = new Set<string>();
  const settled = new Map<string, number>();
  if (levels.length < 2 * K) return { drains: [], phantomFills, settled };
  const ms = levels.map((p) => p.ms);
  const bounds = levels.map((p) => burn.bounds(p.ms));
  const unexplained = levels.map((p) => -(p.litres + (burn.at(p.ms) ?? 0)));
  // The same, taking the counter's extremes: as little / as much unexplained as it allows.
  const least = (i: number) => -(levels[i].litres + bounds[i]!.hi);
  const most = (i: number) => -(levels[i].litres + bounds[i]!.lo);
  const known = (idx: number[]) => idx.every((k) => bounds[k] !== null);
  const usable = (i: number) => known(span(i - K, i + K)) && !burn.unknownBetween(ms[i - K], ms[i + K - 1]);
  const threshold = Math.max(DRAIN_MIN_LITRES, DRAIN_MIN_SENSOR_STEPS * stepLitres);

  interface Candidate {
    s: Step;
    drop: number; // the most that can have left unburned and stayed missing
    seen: number; // the drop right after it happened (≥ drop)
    heldUntil: number; // last reading the hold check used: what came back before it is in drop already
  }
  const candidates: Candidate[] = [];
  for (const s of findSteps(unexplained, ms, threshold, usable)) {
    const before = span(s.start - K, s.start);
    const after = span(s.end, s.end + K);
    // Confirm on the readings DRAIN_HOLD_HOURS later — or, when a fill comes
    // sooner, on the last ones before it (a fill moves the line by what it
    // added, which the sensor only roughly shows).
    const fillAt = refuels
      .map((r) => levels.findIndex((p) => p.time === r.time))
      .filter((i) => i > s.end)
      .sort((a, b) => a - b)[0];
    let h = s.end;
    while (h < levels.length && ms[h] < ms[s.end] + DRAIN_HOLD_HOURS * HOUR_MS) h++;
    let held: number[];
    if (fillAt === undefined) {
      if (h + K > levels.length) continue; // not long enough ago to confirm yet
      held = span(h, h + K);
    } else if (h < fillAt) {
      held = span(h, Math.min(h + K, fillAt)); // never past the fill
    } else {
      held = span(Math.max(s.end, fillAt - K), fillAt);
    }
    const last = held[held.length - 1];
    if (!known([...before, ...after, ...held]) || burn.unknownBetween(ms[s.start - K], ms[last])) continue;
    const base = median(before.map(most));
    const seen = median(after.map(least)) - base;
    const drop = Math.min(seen, median(held.map(least)) - base);
    if (drop >= threshold) candidates.push({ s, drop, seen, heldUntil: ms[last] });
  }
  if (candidates.length === 0) return { drains: [], phantomFills, settled };

  // Rises nothing booked accounts for: a fill's rise beyond its slip (by more than
  // the slip tolerance), or the whole rise when no slip covers it.
  const rises = findSteps(
    unexplained.map((v) => -v),
    ms,
    Math.max(PAIR_MIN_LITRES, DRAIN_MIN_SENSOR_STEPS * stepLitres),
    usable,
  ).map((r) => {
    const size = r.after - r.before;
    const m = metered.find((f) => withinMerge(f.time, ms[r.start]));
    let unbooked = size;
    if (m) unbooked = m.maris !== null && size - m.maris > m.tolerance ? size - m.maris : 0;
    return {
      from: ms[r.start - 1],
      to: ms[r.end],
      unbooked,
      booked: m?.time,
      fill: m ? undefined : unbookedFills.find((f) => withinMerge(f.time, ms[r.start])),
      used: false,
    };
  });

  // A rise between a drop and its hold readings is already in that drop's size.
  for (const c of candidates) {
    for (const r of rises) if (r.from >= ms[c.s.start - 1] && r.from < c.heldUntil) r.used = true;
  }
  // Smaller drops (below the threshold, never reported) are paired too, so a rise
  // that belongs with one of them can't cancel some other drop further away.
  const small: Candidate[] = findSteps(unexplained, ms, Math.max(PAIR_MIN_LITRES, DRAIN_MIN_SENSOR_STEPS * stepLitres), usable)
    .filter((s) => !candidates.some((c) => s.start <= c.s.end && s.end >= c.s.start))
    .map((s) => ({ s, drop: s.after - s.before, seen: s.after - s.before, heldUntil: ms[s.end] }));
  // Every drop and rise that could be a pair, nearest in time first: a rise goes
  // to the drop it's closest to, each at most once.
  const options: Array<{ c: Candidate; r: (typeof rises)[number]; gap: number; fit: number }> = [];
  for (const c of [...candidates, ...small]) {
    const start = ms[c.s.start - 1];
    const end = c.heldUntil;
    for (const r of rises) {
      const gap = r.to <= start ? start - r.to : r.from >= end ? r.from - end : -1;
      if (gap < 0 || gap > PAIR_HOURS * HOUR_MS) continue;
      if (r.unbooked < PAIR_MIN_SHARE * c.drop || r.unbooked > PAIR_MAX_SHARE * c.drop) continue;
      options.push({ c, r, gap, fit: Math.abs(r.unbooked - c.drop) });
    }
  }
  options.sort((a, b) => a.gap - b.gap || a.fit - b.fit);
  const pairOf = new Map<Candidate, (typeof rises)[number]>();
  for (const o of options) {
    if (pairOf.has(o.c) || o.r.used) continue;
    o.r.used = true;
    pairOf.set(o.c, o.r);
  }

  const drains: TankDrain[] = [];
  for (const c of candidates) {
    const pair = pairOf.get(c);
    let litres = c.drop;
    if (pair) {
      if (pair.booked) settled.set(pair.booked, Math.min(pair.unbooked, c.drop));
      litres = Math.max(0, c.drop - pair.unbooked);
      if (litres < threshold) {
        if (pair.fill) phantomFills.add(pair.fill.time);
        continue;
      }
    }
    const before = span(c.s.start - K, c.s.start);
    const after = span(c.s.end, c.s.end + K);
    drains.push({
      time: levels[c.s.start].time,
      prevTime: levels[c.s.start - 1].time,
      litres: round1(litres),
      burnedLitres: round1(median(after.map((i) => bounds[i]!.hi)) - median(before.map((i) => bounds[i]!.lo))),
      returnedLitres: round1(c.seen - litres),
      levelBefore: round1(median(before.map((i) => levels[i].litres))),
      levelAfter: round1(median(after.map((i) => levels[i].litres))),
      minLitres: round1(threshold),
      engineHours: null,
      latitude: null,
      longitude: null,
      locationTime: null,
      movedMetres: null,
    });
  }
  return { drains, phantomFills, settled };
}

/**
 * Fill-to-fill balance. Between two fills that both leave the tank full, what the
 * closing fill put back, plus however much lower than the first it left the tank,
 * is what left the tank; the engine counter says how much of that it can have
 * burned. The Maris quantity is used for the refill when its slip matched the
 * sensor (it's metered, the sensor only approximate).
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
    const atStart = burn.bounds(startMs);
    const atEnd = burn.bounds(endMs);
    if (!atStart || !atEnd || burn.unknownBetween(startMs, endMs)) continue;

    const maris = marisByRefuel.get(close.time);
    const refilled = maris ?? close.litres;
    const burned = atEnd.hi - atStart.lo;
    const levelChange = close.levelAfter - open.levelAfter;
    const drainLitres = drains
      .filter((d) => d.time > open.time && d.time <= close.time)
      .reduce((s, d) => s + d.litres, 0);
    out.push({
      start: open.time,
      end: close.time,
      refilledLitres: round1(refilled),
      refillSource: maris !== undefined ? 'maris' : 'sensor',
      burnedLitres: round1(burned),
      levelChangeLitres: round1(levelChange),
      missingLitres: round1(refilled - levelChange - burned),
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

interface Fix {
  latitude: number;
  longitude: number;
  reading_time: string;
}

function metresBetween(a: Fix, b: Fix): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function fixBefore(serial: string, iso: string): Fix | undefined {
  return db
    .prepare(
      `SELECT latitude, longitude, reading_time FROM lidat_location_fix
       WHERE serial_number = ? AND reading_time <= ? ORDER BY reading_time DESC LIMIT 1`,
    )
    .get(serial, iso) as Fix | undefined;
}

function fixAfter(serial: string, iso: string): Fix | undefined {
  return db
    .prepare(
      `SELECT latitude, longitude, reading_time FROM lidat_location_fix
       WHERE serial_number = ? AND reading_time >= ? ORDER BY reading_time LIMIT 1`,
    )
    .get(serial, iso) as Fix | undefined;
}

/**
 * Where the machine stood when fuel left: its last GPS fix before the drop (or
 * the first after, if none is close before), and how far it moved between the
 * two. History from before every fix was kept falls back to the day's position.
 */
function locateDrop(
  serial: string,
  prevTime: string,
  time: string,
): Pick<TankDrain, 'latitude' | 'longitude' | 'locationTime' | 'movedMetres'> {
  const near = (f: Fix | undefined, iso: string) =>
    f && Math.abs(Date.parse(f.reading_time) - Date.parse(iso)) <= FIX_NEAR_HOURS * HOUR_MS ? f : undefined;
  const before = near(fixBefore(serial, prevTime), prevTime);
  const after = near(fixAfter(serial, time), time);
  const at = before ?? after;
  if (!at) return { ...locateAt(serial, time), movedMetres: null };
  return {
    latitude: at.latitude,
    longitude: at.longitude,
    locationTime: at.reading_time,
    movedMetres: before && after ? Math.round(metresBetween(before, after)) : null,
  };
}

/** The machine's last known position up to the end of `day`: its latest fix, or that day's position. */
function positionUpTo(serial: string, day: string): Pick<TankDrain, 'latitude' | 'longitude' | 'locationTime'> {
  const fix = fixBefore(serial, `${day}T23:59:59Z`);
  const daily = locateAt(serial, day);
  if (fix && (!daily.locationTime || fix.reading_time >= daily.locationTime)) {
    return { latitude: fix.latitude, longitude: fix.longitude, locationTime: fix.reading_time };
  }
  return daily;
}

function slipTolerance(litres: number, stepLitres: number): number {
  return Math.max(
    SLIP_TOLERANCE_LITRES,
    SLIP_TOLERANCE_FRACTION * litres,
    SLIP_TOLERANCE_SENSOR_STEPS * stepLitres,
  );
}

/** Local days a fill can have happened on: from the last reading before it to the first after. */
interface FillWindow {
  from: string;
  to: string;
}

function fillWindow(r: TankRefuel): FillWindow {
  return { from: localDay(r.prevTime), to: localDay(r.time) };
}

/** Days between a slip date and a fill's window (0 when the fill can have happened that day). */
function daysToFill(day: string, w: FillWindow): number {
  if (day < w.from) return dayDiff(w.from, day);
  if (day > w.to) return dayDiff(day, w.to);
  return 0;
}

interface SlipResult {
  checks: TankSlipCheck[];
  unmatched: TankRefuel[]; // fills no slip accounts for
  metered: MeteredFill[]; // fills a slip accounts for, with the booked quantity
  marisByRefuel: Map<string, number>; // refuel time → Maris quantity, where they agree
}

/**
 * Pair each slip with what the sensor saw. A fill made while the machine wasn't
 * reporting shows up at its next reading, so a slip can be dated any day from the
 * last reading before the fill to the first after it (or a day either side).
 *  1. One slip to one fill: same day first, then a day either side, closest volume.
 *  2. Slips and fills of a day that don't pair up one to one are tried together —
 *     one fill booked on two slips, or one slip for a fill in two goes.
 *  3. A slip still unpaired is looked for as a smaller rise than a refuel needs.
 * Leftover fills had no slip. A slip with no rise is a finding only if the sensor
 * was reporting around it and the fill would have been big enough to show.
 */
function checkSlips(
  slips: SlipInput[],
  refuels: TankRefuel[],
  levels: LevelPoint[],
  capacity: number,
  stepLitres: number,
): SlipResult {
  type Fill = { r: TankRefuel; window: FillWindow };
  const pool: Fill[] = refuels.map((r) => ({ r, window: fillWindow(r) }));
  const sorted = [...slips].sort((a, b) => a.date.localeCompare(b.date) || a.dokBroj - b.dokBroj);
  const litresOf = <T>(items: T[], f: (x: T) => number) => items.reduce((s, x) => s + f(x), 0);

  // Booked quantity against what the sensor saw for these fills.
  const judge = (maris: number, fills: TankRefuel[]) => {
    const tank = litresOf(fills, (f) => f.litres);
    const difference = maris - tank;
    const tolerance = slipTolerance(maris, stepLitres);
    let ok = Math.abs(difference) <= tolerance;
    // Filled to the brim the sensor tops out, so more booked than it saw is fine
    // as long as it would still have fitted in the tank.
    if (!ok && difference > 0 && fills.length === 1 && capacity > 0) {
      const f = fills[0];
      const room = capacity - f.levelBefore + Math.max(tolerance, BRIM_HEADROOM_FRACTION * capacity);
      ok = f.levelAfter >= BRIM_FRACTION * capacity && maris <= room;
    }
    return { ok, tank, difference, tolerance };
  };

  // 1. One to one.
  const used = new Set<Fill>();
  const pairOf = new Map<SlipInput, Fill>();
  for (let maxDays = 0; maxDays <= SLIP_MATCH_DAYS; maxDays++) {
    for (const s of sorted) {
      if (pairOf.has(s)) continue;
      let best: Fill | null = null;
      for (const c of pool) {
        if (used.has(c) || daysToFill(s.date, c.window) > maxDays) continue;
        if (!best || Math.abs(c.r.litres - s.litres) < Math.abs(best.r.litres - s.litres)) best = c;
      }
      if (best) {
        used.add(best);
        pairOf.set(s, best);
      }
    }
  }

  // 2. Together. Slips of one date that are unpaired or disagree with their fill,
  // against the free fills in reach (and theirs): the combination that agrees and
  // covers the most of them wins, repeated while one does.
  const grouped = new Map<SlipInput, { slips: SlipInput[]; fills: Fill[] }>();
  const problem = (s: SlipInput) =>
    !grouped.has(s) && (!pairOf.has(s) || !judge(s.litres, [pairOf.get(s)!.r]).ok);
  for (const day of [...new Set(sorted.filter(problem).map((s) => s.date))]) {
    for (;;) {
      const P = sorted.filter((s) => s.date === day && problem(s));
      const theirs = new Set(P.map((s) => pairOf.get(s)));
      const C = pool.filter(
        (c) => daysToFill(day, c.window) <= SLIP_MATCH_DAYS && (!used.has(c) || theirs.has(c)),
      );
      if (!P.length || !C.length || P.length > GROUP_MAX_ITEMS || C.length > GROUP_MAX_ITEMS) break;
      let best: { ps: SlipInput[]; cs: Fill[]; size: number; diff: number } | null = null;
      for (let pm = 1; pm < 1 << P.length; pm++) {
        const ps = P.filter((_, i) => pm & (1 << i));
        for (let cm = 1; cm < 1 << C.length; cm++) {
          const cs = C.filter((_, i) => cm & (1 << i));
          if (ps.length === 1 && cs.length === 1 && pairOf.get(ps[0]) === cs[0]) continue; // judged already
          const j = judge(
            litresOf(ps, (s) => s.litres),
            cs.map((c) => c.r),
          );
          if (!j.ok) continue;
          const size = ps.length + cs.length;
          const diff = Math.abs(j.difference);
          if (!best || size > best.size || (size === best.size && diff < best.diff)) best = { ps, cs, size, diff };
        }
      }
      if (!best) break;
      const g = { slips: best.ps, fills: best.cs };
      for (const s of P) {
        const own = pairOf.get(s);
        if (own && (best.ps.includes(s) || best.cs.includes(own))) {
          if (!best.cs.includes(own)) used.delete(own);
          pairOf.delete(s);
        }
      }
      for (const c of best.cs) used.add(c);
      for (const s of best.ps) grouped.set(s, g);
    }
  }

  // 3. Smaller rises, for slips still unpaired.
  const minRise = Math.max(TARGETED_MIN_LITRES, TARGETED_MIN_SENSOR_STEPS * stepLitres);
  const small: Fill[] = (capacity > 0 ? risesOf(levels, minRise) : [])
    .filter((r) => !pool.some((c) => withinMerge(c.r.time, r.time)))
    .map((r) => ({ r, window: fillWindow(r) }));
  const targeted = new Map<SlipInput, Fill>();
  const usedSmall = new Set<Fill>();
  for (let maxDays = 0; maxDays <= SLIP_MATCH_DAYS; maxDays++) {
    for (const s of sorted) {
      if (pairOf.has(s) || grouped.has(s) || targeted.has(s)) continue;
      let best: Fill | null = null;
      for (const c of small) {
        if (usedSmall.has(c) || daysToFill(s.date, c.window) > maxDays) continue;
        if (c.r.litres < TARGETED_MIN_SHARE * s.litres) continue;
        if (!best || Math.abs(c.r.litres - s.litres) < Math.abs(best.r.litres - s.litres)) best = c;
      }
      if (best) {
        usedSmall.add(best);
        targeted.set(s, best);
      }
    }
  }

  const levelDays = new Set(levels.map((p) => localDay(p.time)));
  const days = [...levelDays];
  const checks = sorted.map((s): TankSlipCheck => {
    const base = {
      date: s.date,
      dokBroj: s.dokBroj,
      sklSifra: s.sklSifra,
      sklNaziv: s.sklNaziv,
      rnalog: s.rnalog,
      marisLitres: s.litres,
    };
    const g = grouped.get(s);
    if (g) {
      const fills = g.fills.map((c) => c.r);
      const j = judge(
        litresOf(g.slips, (x) => x.litres),
        fills,
      );
      return {
        ...base,
        tankLitres: round1(j.tank),
        refuelTime: fills.map((f) => f.time).sort()[0],
        differenceLitres: round1(j.difference),
        status: 'ok',
        sharedWith: g.slips.filter((x) => x !== s).map((x) => x.dokBroj),
        fills: fills.length,
        sensorThatDay: levelDays.has(s.date),
      };
    }
    const f = pairOf.get(s) ?? targeted.get(s);
    if (f) {
      const j = judge(s.litres, [f.r]);
      return {
        ...base,
        tankLitres: f.r.litres,
        refuelTime: f.r.time,
        differenceLitres: round1(j.difference),
        status: j.ok ? 'ok' : 'mismatch',
        sharedWith: [],
        fills: 1,
        sensorThatDay: levelDays.has(s.date),
      };
    }
    // No rise found: only a finding if the sensor was reporting around the slip,
    // and also on some day before and after it — a fill before the first reading
    // (collection just started) or after the latest one isn't visible — and the
    // fill was big enough for this sensor to show.
    const seen =
      [-1, 0, 1].some((d) => levelDays.has(shiftDay(s.date, d))) &&
      days.some((d) => d < s.date) &&
      days.some((d) => d > s.date);
    const visible = s.litres - Math.max(stepLitres, SENSOR_READ_ERROR_LITRES) >= minRise;
    return {
      ...base,
      tankLitres: null,
      refuelTime: null,
      differenceLitres: null,
      status: !seen ? 'no_data' : visible ? 'no_refuel' : 'too_small',
      sharedWith: [],
      fills: 0,
      sensorThatDay: levelDays.has(s.date),
    };
  });

  const metered: MeteredFill[] = [];
  const marisByRefuel = new Map<string, number>();
  for (const [s, f] of [...pairOf, ...targeted]) {
    const j = judge(s.litres, [f.r]);
    metered.push({ time: f.r.time, maris: s.litres, tolerance: j.tolerance });
    if (j.ok && pairOf.has(s)) marisByRefuel.set(f.r.time, s.litres);
  }
  for (const g of new Set(grouped.values())) {
    const total = litresOf(g.slips, (s) => s.litres);
    for (const c of g.fills) {
      metered.push({
        time: c.r.time,
        maris: g.fills.length === 1 ? total : null,
        tolerance: slipTolerance(total, stepLitres),
      });
      if (g.fills.length === 1) marisByRefuel.set(c.r.time, total);
    }
  }

  return {
    checks,
    unmatched: pool.filter((c) => !used.has(c)).map((c) => c.r),
    metered,
    marisByRefuel,
  };
}

/**
 * Fuel issues from Maris for [from, to], grouped by work order. A reversal
 * (storno, a negative quantity) cancels the slip it reverses. A Maris outage is
 * reported rather than thrown: drains don't need Maris.
 */
async function marisSlips(
  from: string,
  to: string,
): Promise<{ byRnalog: Map<string, SlipInput[]>; error: string | null }> {
  const datumOd = toMarisDate(`${from}T00:00:00Z`);
  const datumDo = toMarisDate(`${to}T00:00:00Z`);
  const byRnalog = new Map<string, SlipInput[]>();
  const reversals: SlipInput[] = [];
  try {
    for (const code of getFuelArticleCodes()) {
      const items = await marisFetchItems({ datumOd, datumDo, artikl: code, rowCount: 0 });
      for (const it of items) {
        const rnalog = (it.RNALOG ?? '').trim();
        const litres = Number(it.KOLICINA) || 0;
        if (!rnalog || litres === 0) continue;
        const slip = {
          date: String(it.DATUM).slice(0, 10),
          dokBroj: it.DOK_BROJ,
          sklSifra: it.SKL_SIFRA,
          sklNaziv: it.SKL_NAZIV,
          rnalog,
          litres: Math.abs(litres),
        };
        if (litres < 0) {
          reversals.push(slip);
          continue;
        }
        const list = byRnalog.get(rnalog) ?? [];
        list.push(slip);
        byRnalog.set(rnalog, list);
      }
    }
  } catch (err) {
    return { byRnalog: new Map(), error: err instanceof Error ? err.message : String(err) };
  }
  cancelReversals(byRnalog, reversals);
  return { byRnalog, error: null };
}

/**
 * Drop the slip each storno reverses: same work order and quantity, the latest
 * one dated on or before it (else the first one after). Reversals come in as
 * positive quantities.
 */
export function cancelReversals(byRnalog: Map<string, SlipInput[]>, reversals: SlipInput[]): void {
  for (const rev of reversals) {
    const list = byRnalog.get(rev.rnalog) ?? [];
    const same = list
      .filter((s) => Math.abs(s.litres - rev.litres) < 0.005)
      .sort((a, b) => a.date.localeCompare(b.date));
    const target = same.filter((s) => s.date <= rev.date).at(-1) ?? same[0];
    if (target) list.splice(list.indexOf(target), 1);
  }
}

function slipsFor(m: Machine, byRnalog: Map<string, SlipInput[]>): SlipInput[] {
  return m.rnalogs.flatMap((r) => byRnalog.get(r.trim()) ?? []);
}

/** See CAPACITY_HINT_*: a consistent Maris-to-rise multiple far from 1. */
function capacityHint(checks: TankSlipCheck[], capacity: number | null): CapacityHint | null {
  if (!capacity) return null;
  const ratios = checks
    .filter(
      (c) =>
        c.tankLitres !== null &&
        c.tankLitres >= CAPACITY_HINT_MIN_RISE_LITRES &&
        c.fills === 1 &&
        c.sharedWith.length === 0,
    )
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

/** See CALIBRATION_DAYS: the sensor against Maris slips and against the counter. */
function calibrate(
  levels: LevelPoint[],
  burn: BurnIndex,
  fills: TankRefuel[],
  drains: TankDrain[],
  checks: TankSlipCheck[],
  stepLitres: number,
): TankCalibration {
  // Maris: single fills big enough to give a steady ratio.
  const ratios = checks
    .filter(
      (c) =>
        (c.status === 'ok' || c.status === 'mismatch') &&
        c.fills === 1 &&
        c.sharedWith.length === 0 &&
        c.tankLitres !== null &&
        c.tankLitres >= CAPACITY_HINT_MIN_RISE_LITRES,
    )
    .map((c) => c.tankLitres! / c.marisLitres);
  let maris: TankCalibration['maris'] = { status: 'unknown', ratio: null, slips: ratios.length };
  if (ratios.length >= MARIS_CHECK_MIN_SLIPS) {
    const ratio = median(ratios);
    const agreeing = ratios.filter((r) => Math.abs(r / ratio - 1) <= CAPACITY_HINT_AGREE).length;
    // Ratios all over the place say the sensor is too rough to tell, not that it's off.
    const steady = agreeing >= CAPACITY_HINT_AGREEING_SHARE * ratios.length;
    maris = {
      status: !steady ? 'unknown' : Math.abs(ratio - 1) <= MARIS_AGREE ? 'ok' : 'off',
      ratio: Math.round(ratio * 100) / 100,
      slips: ratios.length,
    };
  }

  // Counter: rest to rest.
  const rests: Array<{ ms: number; litres: number }> = [];
  for (let i = 1; i < levels.length; i++) {
    if (levels[i].ms - levels[i - 1].ms < REST_GAP_HOURS * HOUR_MS || !burn.bounds(levels[i].ms)) continue;
    const first = levels.slice(i, i + K).filter((p) => p.ms - levels[i].ms <= REST_READING_MINUTES * 60_000);
    rests.push({ ms: levels[i].ms, litres: median(first.map((p) => p.litres)) });
  }
  const between = (t: string, a: number, b: number) => Date.parse(t) > a && Date.parse(t) <= b;
  let fell = 0;
  let burned = 0;
  let pairs = 0;
  for (let k = 1; k < rests.length; k++) {
    const [a, b] = [rests[k - 1], rests[k]];
    if (fills.some((f) => between(f.time, a.ms, b.ms)) || drains.some((d) => between(d.time, a.ms, b.ms))) continue;
    if (burn.unknownBetween(a.ms, b.ms)) continue;
    const used = (burn.at(b.ms) ?? 0) - (burn.at(a.ms) ?? 0);
    if (used < REST_MIN_BURN_LITRES) continue;
    fell += a.litres - b.litres;
    burned += used;
    pairs++;
  }
  let counter: TankCalibration['counter'] = { status: 'unknown', ratio: null, burnedLitres: round1(burned) };
  if (burned >= COUNTER_CHECK_MIN_LITRES) {
    const ratio = fell / burned;
    const resolution = (Math.max(stepLitres, REST_READ_ERROR_LITRES) * Math.sqrt(2 * pairs)) / burned;
    counter = {
      status:
        resolution > COUNTER_AGREE ? 'unknown' : Math.abs(ratio - 1) <= COUNTER_AGREE + resolution ? 'ok' : 'off',
      ratio: Math.round(ratio * 100) / 100,
      burnedLitres: round1(burned),
    };
  }
  return { maris, counter };
}

/**
 * The analysis proper, on readings already loaded (no database or Maris), over
 * everything passed in; the caller narrows the results to its range.
 */
export function analyseReadings(input: {
  levels: LevelPoint[];
  fuel: FuelPoint[];
  hours?: FuelPoint[]; // cumulative engine operating hours
  slips: SlipInput[];
  capacity: number | null;
  quality: SensorQuality;
  stepLitres: number;
}): {
  refuels: TankRefuel[];
  drains: TankDrain[];
  cycles: TankCycle[];
  checks: TankSlipCheck[];
  unmatched: TankRefuel[];
  calibration: TankCalibration;
} {
  const { levels, capacity, quality, stepLitres } = input;
  const burn = burnIndex(input.fuel);
  const engine = burnIndex(input.hours ?? []);
  const fills = capacity ? detectRefuels(levels, capacity, stepLitres) : [];
  const slip = checkSlips(input.slips, fills, levels, capacity ?? 0, stepLitres);
  const { drains, phantomFills, settled } =
    capacity && quality === 'fine'
      ? detectDrains(levels, burn, stepLitres, fills, slip.unmatched, slip.metered)
      : { drains: [], phantomFills: new Set<string>(), settled: new Map<string, number>() };
  // A rise that only came back off again wasn't fuel going in, and a booked fill
  // that read high is judged on what stayed in the tank.
  const refuels = fills.filter((r) => !phantomFills.has(r.time));
  for (const c of slip.checks) {
    const gone = c.refuelTime ? settled.get(c.refuelTime) : undefined;
    if (c.status !== 'mismatch' || gone === undefined || c.tankLitres === null || c.fills !== 1) continue;
    const tank = c.tankLitres - gone;
    if (Math.abs(c.marisLitres - tank) > slipTolerance(c.marisLitres, stepLitres)) continue;
    c.status = 'ok';
    c.tankLitres = round1(tank);
    c.differenceLitres = round1(c.marisLitres - tank);
    slip.marisByRefuel.set(c.refuelTime!, c.marisLitres);
  }
  const cycles = capacity ? refillCycles(refuels, burn, capacity, slip.marisByRefuel, drains) : [];
  // How long the engine ran while each drop happened (0: it stood still).
  for (const d of drains) {
    const a = engine.bounds(Date.parse(d.prevTime));
    const b = engine.bounds(Date.parse(d.time));
    d.engineHours = a && b ? Math.round(Math.max(0, b.hi - a.lo) * 100) / 100 : null;
  }
  return {
    refuels,
    drains,
    cycles,
    checks: slip.checks,
    unmatched: slip.unmatched.filter((r) => !phantomFills.has(r.time)),
    calibration: calibrate(levels, burn, refuels, drains, slip.checks, stepLitres),
  };
}

/** First day loaded for a range: its padding, or the calibration lookback if that reaches further back. */
function loadStartDay(from: string, to: string): string {
  const padded = shiftDay(from, -PAD_BEFORE_DAYS);
  const lookback = shiftDay(to, -CALIBRATION_DAYS);
  return padded < lookback ? padded : lookback;
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
  const loadFrom = `${loadStartDay(from, to)}T00:00:00Z`;
  const loadTo = isoAt(Date.parse(`${to}T23:59:59Z`) + PAD_AFTER_DAYS * DAY_MS);

  // Without a capacity the percentages can't be turned into litres.
  const { quality, stepPct } = capacity
    ? classifySensor(m.serialNumber)
    : { quality: 'none' as const, stepPct: null };
  const levels = capacity ? loadLevels(m.serialNumber, loadFrom, loadTo, capacity) : [];
  const stepLitres = stepPct !== null && capacity ? (stepPct / 100) * capacity : 0;

  const { refuels, drains, cycles, checks, unmatched, calibration } = analyseReadings({
    levels,
    fuel: loadFuel(m.serialNumber, loadFrom, loadTo),
    hours: loadHours(m.serialNumber, loadFrom, loadTo),
    slips,
    capacity,
    quality,
    stepLitres,
  });
  // Refuels on or after this day may still get their izdatnica.
  const graceFrom = shiftDay(localDay(new Date().toISOString()), -config.marisGraceDays);

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
      .map((d) => ({ ...d, ...locateDrop(m.serialNumber, d.prevTime, d.time) })),
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
    calibration,
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
    slipUnchecked: count('no_data') + count('too_small'),
    refuelsWithoutSlip: a.refuelsWithoutSlip.length,
    refuelsAwaitingSlip: a.refuelsAwaitingSlip.length,
    drainCount: a.drains.length,
    drainLitres: sum(a.drains, (d) => d.litres),
    cycleCount: a.cycles.length,
    cycleRefilledLitres: sum(a.cycles, (c) => c.refilledLitres),
    cycleMissingLitres: sum(a.cycles, (c) => c.missingLitres),
    capacitySuspect: a.capacityHint !== null,
    calibration: a.calibration,
  };
}

// ---- why each finding is (or isn't) sure ----

const litresText = (n: number) => `${Math.round(n)} L`;
const ratioText = (r: number | null) => (r === null ? '—' : r.toFixed(2).replace('.', ','));
const hoursText = (h: number) => `${h.toFixed(1).replace('.', ',')} h`;
const gapText = (h: number) => (h < 72 ? `${Math.round(h)} h` : `${Math.round(h / 24)} dana`);
const distanceText = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
const okReason = (text: string): EventReason => ({ ok: true, text });
const checkReason = (text: string): EventReason => ({ ok: false, text });

/** Smallest rise this machine's sensor shows as a refuel. */
function refuelThreshold(a: TankMachineAnalysis): number {
  return Math.max(
    REFUEL_MIN_LITRES,
    REFUEL_MIN_FRACTION * (a.tankCapacity ?? 0),
    REFUEL_MIN_SENSOR_STEPS * (a.sensorStepLitres ?? 0),
  );
}

/** Whether the sensor and the counter can be compared — what drains and cycles rest on. */
function counterReason(cal: TankCalibration): EventReason {
  const c = cal.counter;
  if (c.status === 'ok') {
    return okReason(`Senzor razine i brojač potrošnje se slažu dok stroj radi (omjer ${ratioText(c.ratio)})`);
  }
  if (c.status === 'off') {
    return checkReason(
      `Senzor razine i brojač potrošnje se ne slažu dok stroj radi (omjer ${ratioText(c.ratio)}) — provjerite kapacitet spremnika i brojač`,
    );
  }
  return checkReason('Premalo rada u zadnjih 30 dana da bi se senzor razine usporedio s brojačem potrošnje');
}

/** Whether the litres read off the sensor are confirmed — what slip checks rest on. */
function scaleReason(cal: TankCalibration): EventReason {
  if (cal.maris.status === 'ok') {
    return okReason(
      `Izdatnice ovog stroja slažu se sa senzorom (${cal.maris.slips} izdatnica, omjer ${ratioText(cal.maris.ratio)})`,
    );
  }
  if (cal.maris.status === 'off') {
    return checkReason(
      `Izdatnice ovog stroja redom odstupaju od senzora (omjer ${ratioText(cal.maris.ratio)}) — vjerojatno je kapacitet spremnika krivo zadan`,
    );
  }
  if (cal.counter.status === 'ok') {
    return okReason(`Senzor razine slaže se s brojačem potrošnje (omjer ${ratioText(cal.counter.ratio)})`);
  }
  if (cal.counter.status === 'off') {
    return checkReason(
      `Senzor razine i brojač potrošnje se ne slažu (omjer ${ratioText(cal.counter.ratio)}) — provjerite kapacitet spremnika`,
    );
  }
  return checkReason('Litre sa senzora još nisu potvrđene (premalo izdatnica i rada za usporedbu)');
}

/**
 * The sensor's litres contradicted by Maris (or, without Maris, by the counter —
 * unless the counter's verdict is already among the reasons): capacity likely wrong.
 */
function scaleContradiction(cal: TankCalibration, counterShown: boolean): EventReason | null {
  if (cal.maris.status === 'off') {
    return checkReason(
      `Izdatnice ovog stroja redom odstupaju od senzora (omjer ${ratioText(cal.maris.ratio)}) — vjerojatno je kapacitet spremnika krivo zadan, pa i litre`,
    );
  }
  if (!counterShown && cal.maris.status !== 'ok' && cal.counter.status === 'off') {
    return checkReason(
      `Senzor razine i brojač potrošnje se ne slažu (omjer ${ratioText(cal.counter.ratio)}) — provjerite kapacitet spremnika i brojač`,
    );
  }
  return null;
}

function drainReasons(d: TankDrain, cal: TankCalibration): EventReason[] {
  const out: EventReason[] = [];
  // Fuel gone while the counter stood still wasn't burned, whatever the counter's
  // accuracy; a drop while the engine ran rests on sensor and counter agreeing.
  const idle = d.burnedLitres <= Math.max(IDLE_BURN_LITRES, IDLE_BURN_SHARE * d.litres);
  if (idle) {
    out.push(
      d.engineHours !== null && d.engineHours <= ENGINE_OFF_HOURS
        ? okReason('Motor nije radio dok je gorivo nestalo (brojač potrošnje se nije micao)')
        : okReason(`Brojač potrošnje za to vrijeme pokazuje samo ${litresText(d.burnedLitres)}`),
    );
  } else {
    out.push(counterReason(cal));
    out.push(
      okReason(
        d.engineHours !== null
          ? `Motor je u tom razdoblju radio ${hoursText(d.engineHours)} i potrošio ${litresText(d.burnedLitres)}`
          : `Motor je u tom razdoblju potrošio ${litresText(d.burnedLitres)}`,
      ),
    );
  }
  const scale = scaleContradiction(cal, !idle);
  if (scale) out.push(scale);
  out.push(
    d.litres >= SURE_MARGIN * d.minLitres
      ? okReason(`Nestalo ${litresText(d.litres)}, prag ${litresText(d.minLitres)}`)
      : checkReason(`Blizu praga: nestalo ${litresText(d.litres)} uz prag ${litresText(d.minLitres)}`),
  );
  if (d.returnedLitres >= 1) {
    const seen = d.litres + d.returnedLitres;
    out.push(
      d.returnedLitres <= SURE_MAX_RETURNED_SHARE * seen
        ? okReason(`Od pada od ${litresText(seen)} vratilo se ${litresText(d.returnedLitres)}, to se ne računa`)
        : checkReason(
            `Velik dio pada se vratio (${litresText(d.returnedLitres)} od ${litresText(seen)}) — moguće kolebanje senzora`,
          ),
    );
  }
  const gapHours = (Date.parse(d.time) - Date.parse(d.prevTime)) / HOUR_MS;
  if (gapHours > LONG_SILENCE_HOURS) {
    out.push(okReason(`Gorivo je nestalo u ${gapText(gapHours)} dok se stroj nije javljao`));
  }
  if (d.movedMetres !== null) {
    out.push(
      d.movedMetres <= MOVED_METRES
        ? okReason('Stroj se između očitanja nije pomaknuo')
        : okReason(`Stroj se između očitanja pomaknuo ${distanceText(d.movedMetres)}`),
    );
  }
  return out;
}

function cycleReasons(c: TankCycle, beyond: number, cal: TankCalibration): EventReason[] {
  const min = Math.max(CYCLE_MIN_LITRES, CYCLE_MIN_FRACTION * c.refilledLitres);
  const out = [
    c.refillSource === 'maris'
      ? okReason(`Uliveno prema izdatnici iz Marisa (${litresText(c.refilledLitres)})`)
      : checkReason('Uliveno prema senzoru — izdatnica još nije u Marisu ili se ne slaže sa senzorom'),
    counterReason(cal),
    beyond >= SURE_MARGIN * min
      ? okReason(`Nedostaje ${litresText(beyond)}, prag ${litresText(min)}`)
      : checkReason(`Blizu praga: nedostaje ${litresText(beyond)} uz prag ${litresText(min)}`),
  ];
  const scale = scaleContradiction(cal, true);
  if (scale) out.push(scale);
  return out;
}

function mismatchReasons(c: TankSlipCheck, a: TankMachineAnalysis): EventReason[] {
  const tolerance = slipTolerance(c.marisLitres, a.sensorStepLitres ?? 0);
  const difference = c.differenceLitres ?? 0;
  const out = [scaleReason(a.calibration)];
  out.push(
    Math.abs(difference) >= SURE_MARGIN * tolerance
      ? okReason(`Razlika ${litresText(Math.abs(difference))} uz dopušteno ±${litresText(tolerance)}`)
      : checkReason(`Razlika (${litresText(Math.abs(difference))}) je blizu dopuštene (±${litresText(tolerance)})`),
  );
  if (difference < 0) {
    out.push(checkReason('Spremnik je dobio više nego što je izdano — provjerite je li dio punjenja na drugoj izdatnici'));
  }
  return out;
}

function noRefuelReasons(c: TankSlipCheck, a: TankMachineAnalysis): EventReason[] {
  const threshold = refuelThreshold(a);
  return [
    c.sensorThatDay
      ? okReason('Senzor razine javljao se na dan izdatnice')
      : checkReason('Stroj se na dan izdatnice nije javljao'),
    c.marisLitres >= SURE_MARGIN * threshold
      ? okReason(`Punjenje od ${litresText(c.marisLitres)} jasno bi se vidjelo na senzoru (prag ${litresText(threshold)})`)
      : checkReason(`Izdatnica (${litresText(c.marisLitres)}) je malena za ovaj senzor (prag ${litresText(threshold)})`),
  ];
}

function noSlipReasons(r: TankRefuel, a: TankMachineAnalysis): EventReason[] {
  const threshold = refuelThreshold(a);
  return [
    r.litres >= SURE_MARGIN * threshold
      ? okReason(`Porast od ${litresText(r.litres)} jasno je dolijevanje (prag ${litresText(threshold)})`)
      : checkReason(`Porast (${litresText(r.litres)}) je blizu praga za dolijevanje (${litresText(threshold)})`),
  ];
}

function confidenceOf(kind: TankEventKind, reasons: EventReason[]): Confidence | null {
  if (kind === 'refuel_awaiting_slip') return null;
  return reasons.every((r) => r.ok) ? 'sure' : 'check';
}

function eventKey(e: Pick<TankEvent, 'serialNumber' | 'kind' | 'day' | 'time' | 'dokBroj'>): string {
  return [e.serialNumber, e.kind, e.dokBroj !== null ? `${e.day}#${e.dokBroj}` : (e.time ?? e.day)].join('|');
}

function eventsOf(a: TankMachineAnalysis): TankEvent[] {
  const base = {
    serialNumber: a.serialNumber,
    model: a.model,
    group: a.group,
    tankLitres: null,
    marisLitres: null,
    burnedLitres: null,
    levelChangeLitres: null,
    returnedLitres: null,
    since: null,
    dokBroj: null,
  };
  const out: TankEvent[] = [];
  const push = (e: Omit<TankEvent, 'key' | 'confidence' | 'review'>) =>
    out.push({ ...e, key: eventKey(e), confidence: confidenceOf(e.kind, e.reasons), review: null });
  for (const d of a.drains) {
    push({
      ...base,
      kind: 'drain',
      day: localDay(d.time),
      time: d.time,
      litres: d.litres,
      returnedLitres: d.returnedLitres,
      reasons: drainReasons(d, a.calibration),
    });
  }
  for (const c of a.cycles) {
    // Only what the flagged drops inside the cycle don't already account for.
    const beyondDrains = c.missingLitres - c.drainLitres;
    if (beyondDrains < Math.max(CYCLE_MIN_LITRES, CYCLE_MIN_FRACTION * c.refilledLitres)) continue;
    push({
      ...base,
      kind: 'cycle_loss',
      day: localDay(c.end),
      time: c.end,
      litres: round1(beyondDrains),
      tankLitres: c.refilledLitres,
      burnedLitres: c.burnedLitres,
      levelChangeLitres: c.levelChangeLitres,
      since: c.start,
      reasons: cycleReasons(c, beyondDrains, a.calibration),
    });
  }
  for (const c of a.slips) {
    if (c.status !== 'mismatch' && c.status !== 'no_refuel') continue;
    push({
      ...base,
      kind: c.status === 'mismatch' ? 'slip_mismatch' : 'slip_no_refuel',
      day: c.date,
      time: c.refuelTime,
      litres: c.marisLitres,
      tankLitres: c.tankLitres,
      marisLitres: c.marisLitres,
      dokBroj: c.dokBroj,
      reasons: c.status === 'mismatch' ? mismatchReasons(c, a) : noRefuelReasons(c, a),
    });
  }
  for (const [kind, refuels] of [
    ['refuel_no_slip', a.refuelsWithoutSlip],
    ['refuel_awaiting_slip', a.refuelsAwaitingSlip],
  ] as const) {
    for (const r of refuels) {
      push({
        ...base,
        kind,
        day: localDay(r.time),
        time: r.time,
        litres: r.litres,
        tankLitres: r.litres,
        reasons: kind === 'refuel_no_slip' ? noSlipReasons(r, a) : [],
      });
    }
  }
  return out;
}

/**
 * A slip booked on the wrong work order shows up twice: a slip with no fill on
 * one machine and a fill with no slip on another, or a fill with no slip and a
 * slip on a work order that is no machine's. Point each at the other.
 */
function crossCheck(events: TankEvent[], looseSlips: SlipInput[]): void {
  const similar = (litres: number, maris: number) => Math.abs(litres - maris) <= slipTolerance(maris, 0);
  const near = (a: string, b: string) => Math.abs(dayDiff(a, b)) <= SLIP_MATCH_DAYS;
  const slipsWithoutFill = events.filter((e) => e.kind === 'slip_no_refuel');
  for (const e of events) {
    if (e.kind !== 'refuel_no_slip' && e.kind !== 'refuel_awaiting_slip') continue;
    const other = slipsWithoutFill.find(
      (s) => s.serialNumber !== e.serialNumber && near(s.day, e.day) && similar(e.litres, s.marisLitres ?? 0),
    );
    const loose = looseSlips.find((s) => near(s.date, e.day) && similar(e.litres, s.litres));
    if (other) {
      e.reasons.push(
        checkReason(
          `Izdatnica ${other.dokBroj} (${litresText(other.marisLitres ?? 0)}) na stroju ${other.serialNumber} nema dolijevanja — možda je knjižena na krivi stroj`,
        ),
      );
      other.reasons.push(
        checkReason(
          `Stroj ${e.serialNumber} oko tog dana ima dolijevanje bez izdatnice (+${litresText(e.litres)}) — možda je izdatnica knjižena na krivi stroj`,
        ),
      );
      other.confidence = confidenceOf(other.kind, other.reasons);
    } else if (loose) {
      e.reasons.push(
        checkReason(
          `Izdatnica ${loose.dokBroj} od ${litresText(loose.litres)} oko tog dana je na radnom nalogu ${loose.rnalog}, koji nije povezan ni s jednim strojem`,
        ),
      );
    } else if (e.kind === 'refuel_no_slip') {
      e.reasons.push(okReason('Ni na drugim strojevima ni na drugim radnim nalozima nema izdatnice te količine oko tog dana'));
    }
    e.confidence = confidenceOf(e.kind, e.reasons);
  }
}

function attachReviews(events: TankEvent[], serials: string[]): void {
  const reviews = reviewsOf(serials);
  for (const e of events) e.review = reviews.get(e.key) ?? null;
}

/** Maris slips over the days loaded for this range (padding and calibration lookback). */
function marisFor(from: string, to: string) {
  return marisSlips(loadStartDay(from, to), shiftDay(to, PAD_AFTER_DAYS));
}

/** Every machine the caller may see: per-machine summary plus a flat list of findings. */
export async function buildTankOverview(
  from: string,
  to: string,
  allowed?: MachineGroup[],
): Promise<TankOverview> {
  const machines = listMachines(allowed);
  // Slips over the same days as the readings, so fills just outside the range
  // pair with their own slips rather than with one inside it.
  const maris = await marisFor(from, to);
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
  const machineRnalogs = new Set(listMachines().flatMap((m) => m.rnalogs.map((r) => r.trim())));
  crossCheck(
    events,
    [...maris.byRnalog].filter(([r]) => !machineRnalogs.has(r)).flatMap(([, list]) => list),
  );
  const serials = machines.map((m) => m.serialNumber);
  attachReviews(events, serials);
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
    reviewStats: reviewStats(serials),
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
  const maris = await marisFor(from, to);
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

  const events = eventsOf(analysis);
  attachReviews(events, [serial]);
  return {
    ...analysis,
    from,
    to,
    marisError: maris.error,
    levelSeries,
    lastLidatTime,
    location: positionUpTo(serial, to),
    marisGraceDays: config.marisGraceDays,
    events,
  };
}

/** Every raw reading of one machine between two instants (at most READINGS_MAX_DAYS). */
export function buildTankReadings(serial: string, fromIso: string, toIso: string): TankReadings | null {
  const m = listMachines().find((x) => x.serialNumber === serial);
  if (!m) return null;
  const capacity = capacityOverrides()[serial] ?? m.fuelTankCapacity;
  const toMs = Math.min(Date.parse(toIso), Date.parse(fromIso) + READINGS_MAX_DAYS * DAY_MS);
  const [a, b] = [isoAt(Date.parse(fromIso)), isoAt(toMs)];
  const fixes = db
    .prepare(
      `SELECT latitude, longitude, reading_time FROM lidat_location_fix
       WHERE serial_number = ? AND reading_time >= ? AND reading_time <= ? ORDER BY reading_time`,
    )
    .all(serial, a, b) as Fix[];
  return {
    serialNumber: serial,
    capacity,
    levels: capacity
      ? loadLevels(serial, a, b, capacity).map((p) => ({ t: p.time, litres: round1(p.litres) }))
      : [],
    counter: loadFuel(serial, a, b).map((p) => ({ t: isoAt(p.ms), litres: p.cum })),
    engine: loadHours(serial, a, b).map((p) => ({ t: isoAt(p.ms), hours: p.cum })),
    fixes: fixes.map((f) => ({ t: f.reading_time, latitude: f.latitude, longitude: f.longitude })),
  };
}
