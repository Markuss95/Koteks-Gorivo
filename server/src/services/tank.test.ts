// Scenario tests for the tank analysis: a simulated machine over a few days,
// then what the analysis flags. Each scenario is a real way a reading or a slip
// can mislead — the analysis must not raise a false event, and must still find
// fuel that really left. Run with `npm test` in server/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import type { FuelPoint, LevelPoint, SensorQuality, SlipInput } from './tank.js';

// The analysis needs no database or network, but importing it loads the app
// config; give it a throwaway database and placeholder settings.
process.env.DB_PATH ??= path.join(os.tmpdir(), 'koteks-gorivo-tank-test.db');
for (const name of ['LIDAT_BASE_URL', 'LIDAT_USERNAME', 'LIDAT_PASSWORD', 'MARIS_BASE_URL', 'MARIS_CLIENT_ID', 'MARIS_CLIENT_SECRET']) {
  process.env[name] ??= 'http://placeholder.invalid';
}
const { analyseReadings, cancelReversals } = await import('./tank.js');

const MIN = 60_000;
const HOUR = 60 * MIN;

type Ev =
  | { fill: number; at: string }
  | { drain: number; at: string }
  | { offset: number; from: string; to: string } // reading off by this much (tilt)
  | { offline: true; from: string; to: string } // no readings at all
  | { work: true; from: string; to: string }; // engine working outside the schedule

interface Sim {
  capacity?: number; // nominal: what the sensor's 100 % means
  physical?: number; // what the tank really holds (brim scenarios)
  startLevel?: number;
  start?: string; // a Monday
  days?: number;
  levelEveryMin?: number;
  nightLevelEveryMin?: number; // while not working
  counterEveryMin?: number;
  counterOffsetMin?: number;
  burnPerHour?: number;
  workUtc?: [number, number]; // weekday work hours, UTC
  quantum?: number; // sensor resolution in litres
  resetDaily?: boolean; // counter back to 0 at UTC midnight
  events?: Ev[];
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function simulate(o: Sim): { levels: LevelPoint[]; fuel: FuelPoint[]; hours: FuelPoint[]; capacity: number } {
  const capacity = o.capacity ?? 400;
  const physical = o.physical ?? capacity;
  const start = Date.parse(o.start ?? '2026-09-07T00:00:00Z');
  const end = start + (o.days ?? 5) * 24 * HOUR;
  const levelEvery = o.levelEveryMin ?? 5;
  const nightEvery = o.nightLevelEveryMin ?? levelEvery;
  const counterEvery = o.counterEveryMin ?? levelEvery;
  const counterOffset = o.counterOffsetMin ?? 0;
  const burnPerMin = (o.burnPerHour ?? 6) / 60;
  const [w0, w1] = o.workUtc ?? [5, 13];
  const quantum = o.quantum ?? 1.6;
  const events = o.events ?? [];
  const at = (s: string) => Date.parse(s);
  const working = (t: number) => {
    const d = new Date(t);
    const weekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
    const h = d.getUTCHours() + d.getUTCMinutes() / 60;
    if (events.some((e) => 'work' in e && t >= at(e.from) && t < at(e.to))) return true;
    return weekday && h >= w0 && h < w1;
  };
  const offline = (t: number) => events.some((e) => 'offline' in e && t >= at(e.from) && t < at(e.to));
  const offset = (t: number) =>
    events.reduce((s, e) => s + ('offset' in e && t >= at(e.from) && t < at(e.to) ? e.offset : 0), 0);

  let tank = o.startLevel ?? 300;
  let burned = 0;
  let sinceMidnight = 0;
  let engineHours = 1000;
  const levels: LevelPoint[] = [];
  const fuel: FuelPoint[] = [];
  const hours: FuelPoint[] = [];
  for (let t = start; t < end; t += MIN) {
    if (o.resetDaily && t % (24 * HOUR) === 0) sinceMidnight = 0;
    for (const e of events) {
      if ('fill' in e && at(e.at) === t) tank = Math.min(physical, tank + e.fill);
      if ('drain' in e && at(e.at) === t) tank -= e.drain;
    }
    if (working(t)) {
      tank -= burnPerMin;
      burned += burnPerMin;
      sinceMidnight += burnPerMin;
      engineHours += 1 / 60;
      if (tank < 5) throw new Error(`simulated tank ran dry at ${iso(t)}`);
    }
    if (offline(t)) continue;
    const minute = Math.round((t - start) / MIN);
    const every = working(t) ? levelEvery : nightEvery;
    if (minute % every === 0) {
      const read = Math.max(0, Math.min(capacity, tank + offset(t)));
      const litres = Math.round(read / quantum) * quantum;
      levels.push({ time: iso(t), ms: t, percent: (litres / capacity) * 100, litres });
      hours.push({ ms: t, cum: Math.round(engineHours * 100) / 100 });
    }
    if ((minute - counterOffset) % counterEvery === 0) {
      fuel.push({ ms: t, cum: Math.round((o.resetDaily ? sinceMidnight : burned) * 10) / 10 });
    }
  }
  return { levels, fuel, hours, capacity };
}

let dok = 1000;
function slip(date: string, litres: number, dokBroj = dok++): SlipInput {
  return { date, dokBroj, sklSifra: '1994-G', sklNaziv: 'test', rnalog: 'M/1', litres };
}

function run(o: Sim, slips: SlipInput[] = [], extra: { quality?: SensorQuality; stepLitres?: number } = {}) {
  const { levels, fuel, hours, capacity } = simulate(o);
  return analyseReadings({
    levels,
    fuel,
    hours,
    slips,
    capacity,
    quality: extra.quality ?? 'fine',
    stepLitres: extra.stepLitres ?? 2,
  });
}

function near(a: number, b: number, tol: number, what: string): void {
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} not within ${tol} of ${b}`);
}

// ---------------------------------------------------------------- baseline

test('normal week with one booked fill: nothing flagged', () => {
  const r = run({ events: [{ fill: 150, at: '2026-09-09T14:00:00Z' }] }, [slip('2026-09-09', 150)]);
  assert.equal(r.refuels.length, 1);
  assert.equal(r.drains.length, 0);
  assert.equal(r.checks[0].status, 'ok');
  assert.equal(r.unmatched.length, 0);
});

// ---------------------------------------------------------------- real drains are still found

test('night theft while reporting: one drain of ~40 L', () => {
  const r = run({ nightLevelEveryMin: 30, events: [{ drain: 40, at: '2026-09-08T21:00:00Z' }] });
  assert.equal(r.drains.length, 1, JSON.stringify(r.drains));
  near(r.drains[0].litres, 40, 4, 'drain litres');
});

test('night theft while offline (no readings at night): one drain of ~40 L, engine off', () => {
  const r = run({
    events: [
      { offline: true, from: '2026-09-08T13:30:00Z', to: '2026-09-09T05:00:00Z' },
      { drain: 40, at: '2026-09-08T21:00:00Z' },
    ],
  });
  assert.equal(r.drains.length, 1, JSON.stringify(r.drains));
  near(r.drains[0].litres, 40, 4, 'drain litres');
  assert.ok(r.drains[0].engineHours !== null && r.drains[0].engineHours <= 0.1, String(r.drains[0].engineHours));
});

test('theft the evening after a booked fill: drain kept, slip ok', () => {
  const r = run(
    {
      nightLevelEveryMin: 30,
      events: [
        { fill: 150, at: '2026-09-09T14:00:00Z' },
        { drain: 40, at: '2026-09-09T20:00:00Z' },
      ],
    },
    [slip('2026-09-09', 150)],
  );
  assert.equal(r.drains.length, 1, JSON.stringify(r.drains));
  near(r.drains[0].litres, 40, 4, 'drain litres');
  assert.equal(r.checks[0].status, 'ok');
});

test('theft while the engine runs is still found', () => {
  const r = run(
    {
      days: 2,
      startLevel: 400,
      burnPerHour: 30,
      events: [
        { drain: 35, at: '2026-09-07T09:00:00Z' },
        { fill: 250, at: '2026-09-07T14:00:00Z' },
      ],
    },
    [slip('2026-09-07', 250)],
  );
  assert.equal(r.drains.length, 1, JSON.stringify(r.drains));
  near(r.drains[0].litres, 35, 6, 'drain litres');
});

test('a drop smaller than 15 L is normal use', () => {
  const r = run({ nightLevelEveryMin: 30, events: [{ drain: 12, at: '2026-09-08T21:00:00Z' }] });
  assert.equal(r.drains.length, 0, JSON.stringify(r.drains));
});

test('drop overnight, refuel an hour into the morning: drain kept', () => {
  const r = run({
    days: 3,
    events: [
      { offline: true, from: '2026-09-08T13:30:00Z', to: '2026-09-09T05:00:00Z' },
      { drain: 35, at: '2026-09-08T21:00:00Z' },
      { fill: 100, at: '2026-09-09T06:00:00Z' },
    ],
  });
  assert.equal(r.drains.length, 1, JSON.stringify(r.drains));
  near(r.drains[0].litres, 35, 5, 'drain litres');
});

test('drop, then a fill just after the two-hour mark: confirmed on the readings before the fill', () => {
  const r = run({
    days: 3,
    events: [
      { offline: true, from: '2026-09-08T13:30:00Z', to: '2026-09-09T05:00:00Z' },
      { drain: 35, at: '2026-09-08T21:00:00Z' },
      { fill: 100, at: '2026-09-09T07:10:00Z' },
    ],
  });
  assert.equal(r.drains.length, 1, JSON.stringify(r.drains));
  near(r.drains[0].litres, 35, 5, 'drain litres');
});

test('drop, then a much bigger fill nobody has booked yet: drain kept, fill kept', () => {
  const r = run({
    days: 3,
    startLevel: 380,
    events: [
      { offline: true, from: '2026-09-07T13:30:00Z', to: '2026-09-08T05:00:00Z' },
      { drain: 60, at: '2026-09-07T21:00:00Z' },
      { fill: 100, at: '2026-09-08T09:00:00Z' },
    ],
  });
  assert.equal(r.drains.length, 1, JSON.stringify(r.drains));
  near(r.drains[0].litres, 60, 5, 'drain litres');
  assert.equal(r.unmatched.length, 1);
});

// ---------------------------------------------------------------- readings that come back

test('parked tilted overnight (reading low until it moves): no drain', () => {
  const r = run({
    nightLevelEveryMin: 30,
    events: [{ offset: -30, from: '2026-09-08T13:30:00Z', to: '2026-09-09T05:00:00Z' }],
  });
  assert.equal(r.drains.length, 0, JSON.stringify(r.drains));
  assert.equal(r.unmatched.length, 0, JSON.stringify(r.unmatched));
});

test('parked tilted over the weekend: no drain', () => {
  const r = run({
    days: 9,
    startLevel: 400,
    nightLevelEveryMin: 60,
    events: [{ offset: -35, from: '2026-09-11T13:30:00Z', to: '2026-09-14T05:00:00Z' }],
  });
  assert.equal(r.drains.length, 0, JSON.stringify(r.drains));
  assert.equal(r.unmatched.length, 0, JSON.stringify(r.unmatched));
});

test('parked tilted the other way (reading high, then drops): no drain, no unbooked fill', () => {
  const r = run({
    nightLevelEveryMin: 30,
    events: [{ offset: 30, from: '2026-09-08T13:30:00Z', to: '2026-09-09T05:00:00Z' }],
  });
  assert.equal(r.drains.length, 0, JSON.stringify(r.drains));
  assert.equal(r.unmatched.length, 0, JSON.stringify(r.unmatched));
  assert.equal(r.refuels.length, 0, JSON.stringify(r.refuels));
});

test('sloshing for 20 minutes: no drain', () => {
  const r = run({ events: [{ offset: -25, from: '2026-09-08T09:00:00Z', to: '2026-09-08T09:20:00Z' }] });
  assert.equal(r.drains.length, 0, JSON.stringify(r.drains));
});

test('reading jumps up 27 L with no fill and falls back within the hour: no drain', () => {
  const r = run({ events: [{ offset: 27, from: '2026-09-08T09:00:00Z', to: '2026-09-08T09:50:00Z' }] });
  assert.equal(r.drains.length, 0, JSON.stringify(r.drains));
  assert.equal(r.unmatched.length, 0, JSON.stringify(r.unmatched));
});

test('drop that partly comes back: only what stays missing counts', () => {
  const r = run({
    nightLevelEveryMin: 30,
    events: [
      { drain: 50, at: '2026-09-08T21:00:00Z' },
      { offset: -20, from: '2026-09-08T21:00:00Z', to: '2026-09-09T05:00:00Z' }, // reads 20 lower too
    ],
  });
  assert.equal(r.drains.length, 1, JSON.stringify(r.drains));
  near(r.drains[0].litres, 50, 5, 'drain litres');
  near(r.drains[0].returnedLitres, 20, 5, 'returned');
});

test('a small come-back goes to the nearest drop, not one two days earlier', () => {
  const r = run({
    days: 5,
    startLevel: 380,
    events: [
      { offline: true, from: '2026-09-07T13:30:00Z', to: '2026-09-08T05:00:00Z' },
      { drain: 30, at: '2026-09-07T21:00:00Z' },
      { offline: true, from: '2026-09-09T13:30:00Z', to: '2026-09-10T05:00:00Z' },
      { drain: 40, at: '2026-09-09T21:00:00Z' },
      { offset: -12, from: '2026-09-09T21:00:00Z', to: '2026-09-10T06:00:00Z' },
    ],
  });
  assert.equal(r.drains.length, 2, JSON.stringify(r.drains));
  near(r.drains[0].litres, 30, 4, 'first drain untouched');
  near(r.drains[1].litres, 40, 4, 'second drain net of its own come-back');
});

test('noisy sensor (15 L steps): a one-step wobble does not cancel a three-step drop', () => {
  const r = run(
    {
      quantum: 14.8,
      capacity: 371,
      startLevel: 330,
      days: 4,
      events: [
        { offline: true, from: '2026-09-07T13:30:00Z', to: '2026-09-08T05:00:00Z' },
        { drain: 45, at: '2026-09-07T21:00:00Z' },
        { offset: 15, from: '2026-09-09T08:00:00Z', to: '2026-09-11T00:00:00Z' },
      ],
    },
    [],
    { stepLitres: 14.8 },
  );
  assert.equal(r.drains.length, 1, JSON.stringify(r.drains));
});

test('booked fill read high while tilted at the filling spot: no drain, slip ok', () => {
  const r = run(
    {
      events: [
        { fill: 100, at: '2026-09-09T14:00:00Z' },
        { offset: 40, from: '2026-09-09T13:55:00Z', to: '2026-09-09T16:00:00Z' },
      ],
    },
    [slip('2026-09-09', 100)],
  );
  assert.equal(r.drains.length, 0, JSON.stringify(r.drains));
  assert.equal(r.checks[0].status, 'ok', JSON.stringify(r.checks[0]));
});

test('drop at the very end of the data waits for confirmation', () => {
  const sim: Sim = { days: 3, nightLevelEveryMin: 30, events: [{ drain: 40, at: '2026-09-08T22:30:00Z' }] };
  const { levels, fuel, hours, capacity } = simulate(sim);
  const cut = Date.parse('2026-09-08T23:30:00Z'); // an hour after the drop
  const r = analyseReadings({
    levels: levels.filter((p) => p.ms <= cut),
    fuel: fuel.filter((p) => p.ms <= cut),
    hours: hours.filter((p) => p.ms <= cut),
    slips: [],
    capacity,
    quality: 'fine',
    stepLitres: 2,
  });
  assert.equal(r.drains.length, 0, 'not yet');
  assert.equal(run(sim).drains.length, 1, 'once readings that late exist');
});

// ---------------------------------------------------------------- the fuel counter

test('counter reports every 20 min, level every 5, heavy burn, network gap: no drain', () => {
  const r = run(
    {
      days: 2,
      startLevel: 400,
      burnPerHour: 33,
      counterEveryMin: 20,
      events: [
        { offline: true, from: '2026-09-07T08:00:00Z', to: '2026-09-07T08:45:00Z' },
        { fill: 250, at: '2026-09-07T14:00:00Z' },
      ],
    },
    [slip('2026-09-07', 250)],
  );
  assert.equal(r.drains.length, 0, JSON.stringify(r.drains));
});

test('counter an hour apart from the level readings, heavy burn: no drain', () => {
  const r = run(
    {
      days: 2,
      startLevel: 400,
      burnPerHour: 33,
      counterEveryMin: 60,
      counterOffsetMin: 30,
      events: [{ fill: 250, at: '2026-09-07T14:00:00Z' }],
    },
    [slip('2026-09-07', 250)],
  );
  assert.equal(r.drains.length, 0, JSON.stringify(r.drains));
});

test('counter that resets daily, offline two days while working: no drain', () => {
  const r = run({
    resetDaily: true,
    startLevel: 400,
    days: 4,
    burnPerHour: 3,
    events: [
      { offline: true, from: '2026-09-08T06:00:00Z', to: '2026-09-10T06:00:00Z' },
      { work: true, from: '2026-09-08T00:00:00Z', to: '2026-09-10T06:00:00Z' },
    ],
  });
  assert.equal(r.drains.length, 0, JSON.stringify(r.drains));
});

test('counter that resets daily still shows a theft within a day', () => {
  const r = run({ resetDaily: true, nightLevelEveryMin: 30, events: [{ drain: 40, at: '2026-09-08T19:00:00Z' }] });
  assert.equal(r.drains.length, 1, JSON.stringify(r.drains));
});

test('counter a couple of minutes off the level readings: night theft still found', () => {
  const r = run({ counterOffsetMin: 2, nightLevelEveryMin: 30, events: [{ drain: 40, at: '2026-09-08T21:00:00Z' }] });
  assert.equal(r.drains.length, 1, JSON.stringify(r.drains));
});

// ---------------------------------------------------------------- slips

test('fill on Saturday while the machine was offline, slip dated Saturday: ok', () => {
  const r = run(
    {
      days: 9,
      events: [
        { offline: true, from: '2026-09-11T13:30:00Z', to: '2026-09-14T05:00:00Z' },
        { fill: 150, at: '2026-09-12T10:00:00Z' },
      ],
    },
    [slip('2026-09-12', 150)],
  );
  assert.equal(r.checks[0].status, 'ok', JSON.stringify(r.checks[0]));
  assert.equal(r.unmatched.length, 0);
});

test('small slip on a coarse sensor: too small to check, not a finding', () => {
  const r = run({ quantum: 40, events: [{ fill: 30, at: '2026-09-09T14:00:00Z' }] }, [slip('2026-09-09', 30)], {
    quality: 'coarse',
    stepLitres: 40,
  });
  assert.ok(['too_small', 'ok'].includes(r.checks[0].status), r.checks[0].status);
});

test('big slip on a coarse sensor with no fill at all: still a finding', () => {
  const r = run({ quantum: 40 }, [slip('2026-09-09', 200)], { quality: 'coarse', stepLitres: 40 });
  assert.equal(r.checks[0].status, 'no_refuel');
});

test('small top-up on a big tank (below the refuel threshold): matched, ok', () => {
  const r = run(
    { capacity: 800, startLevel: 500, quantum: 3.2, events: [{ fill: 35, at: '2026-09-09T14:00:00Z' }] },
    [slip('2026-09-09', 35)],
  );
  assert.equal(r.checks[0].status, 'ok', JSON.stringify(r.checks[0]));
});

test('visible slip with no rise on a fine sensor: still a finding', () => {
  const r = run({}, [slip('2026-09-09', 60)]);
  assert.equal(r.checks[0].status, 'no_refuel');
});

test('one fill booked on two slips: both ok, together', () => {
  const r = run({ events: [{ fill: 150, at: '2026-09-09T14:00:00Z' }] }, [
    slip('2026-09-09', 100, 11),
    slip('2026-09-09', 50, 12),
  ]);
  assert.deepEqual(
    r.checks.map((c) => c.status),
    ['ok', 'ok'],
  );
  assert.deepEqual(r.checks[0].sharedWith, [12]);
  assert.equal(r.unmatched.length, 0);
});

test('one slip for a fill in two goes: ok, no unbooked fill', () => {
  const r = run(
    {
      events: [
        { fill: 100, at: '2026-09-09T06:00:00Z' },
        { fill: 50, at: '2026-09-09T11:00:00Z' },
      ],
    },
    [slip('2026-09-09', 150)],
  );
  assert.equal(r.checks[0].status, 'ok', JSON.stringify(r.checks));
  assert.equal(r.checks[0].fills, 2);
  assert.equal(r.unmatched.length, 0, JSON.stringify(r.unmatched));
});

test('two separate fills, two slips: each matched on its own', () => {
  const r = run(
    {
      events: [
        { fill: 60, at: '2026-09-08T14:00:00Z' },
        { fill: 120, at: '2026-09-10T14:00:00Z' },
      ],
    },
    [slip('2026-09-08', 60), slip('2026-09-10', 120)],
  );
  assert.deepEqual(
    r.checks.map((c) => [c.status, c.fills, c.sharedWith.length]),
    [
      ['ok', 1, 0],
      ['ok', 1, 0],
    ],
  );
});

test('booked far more than the tank saw: still a mismatch', () => {
  const r = run({ events: [{ fill: 60, at: '2026-09-09T14:00:00Z' }] }, [slip('2026-09-09', 150)]);
  assert.equal(r.checks[0].status, 'mismatch');
});

test('filled past the top of the sensor: booked quantity fits, ok', () => {
  // The sensor reads 100 % at 400 L, the tank takes 440 L.
  const r = run({ physical: 440, startLevel: 330, events: [{ fill: 150, at: '2026-09-09T14:00:00Z' }] }, [
    slip('2026-09-09', 150),
  ]);
  assert.equal(r.checks[0].status, 'ok', JSON.stringify(r.checks[0]));
});

test('booked more than the tank could ever take: mismatch even at the brim', () => {
  const r = run({ physical: 440, startLevel: 330, events: [{ fill: 150, at: '2026-09-09T14:00:00Z' }] }, [
    slip('2026-09-09', 260),
  ]);
  assert.equal(r.checks[0].status, 'mismatch', JSON.stringify(r.checks[0]));
});

// ---------------------------------------------------------------- fill-to-fill cycles

test('fill-to-fill cycle ending lower than it started: level difference counted', () => {
  const notFull = run({
    startLevel: 250,
    burnPerHour: 10,
    events: [
      { fill: 150, at: '2026-09-07T14:00:00Z' }, // 170 → 320, not full
      { fill: 140, at: '2026-09-10T14:00:00Z' },
    ],
  });
  assert.equal(notFull.cycles.length, 0);
  const r = run(
    {
      startLevel: 330,
      burnPerHour: 10,
      events: [
        { fill: 150, at: '2026-09-07T14:00:00Z' }, // 250 → 400
        { fill: 225, at: '2026-09-10T14:00:00Z' }, // 160 → 385 (96 %)
      ],
    },
    [slip('2026-09-07', 150), slip('2026-09-10', 225)],
  );
  assert.equal(r.cycles.length, 1, JSON.stringify(r.cycles));
  near(r.cycles[0].levelChangeLitres, -15, 3, 'level change');
  near(r.cycles[0].missingLitres, 0, 6, 'missing');
});

// ---------------------------------------------------------------- calibration

// Machines go quiet overnight; the first readings each morning are the rest points.
const QUIET_NIGHTS = 100_000;

test('sensor and counter agree from rest to rest: counter check ok', () => {
  const r = run({ days: 5, burnPerHour: 8, startLevel: 390, nightLevelEveryMin: QUIET_NIGHTS });
  assert.equal(r.calibration.counter.status, 'ok', JSON.stringify(r.calibration));
  near(r.calibration.counter.ratio!, 1, 0.1, 'ratio');
});

test('counter reading 30 % low: counter check off', () => {
  const { levels, fuel, hours, capacity } = simulate({
    days: 5,
    burnPerHour: 8,
    startLevel: 390,
    nightLevelEveryMin: QUIET_NIGHTS,
  });
  const r = analyseReadings({
    levels,
    fuel: fuel.map((f) => ({ ms: f.ms, cum: Math.round(f.cum * 0.7 * 10) / 10 })),
    hours,
    slips: [],
    capacity,
    quality: 'fine',
    stepLitres: 2,
  });
  assert.equal(r.calibration.counter.status, 'off', JSON.stringify(r.calibration));
});

test('slips agree with the sensor: Maris check ok', () => {
  const r = run(
    {
      days: 9,
      startLevel: 250,
      burnPerHour: 8,
      events: [
        { fill: 100, at: '2026-09-07T14:00:00Z' },
        { fill: 120, at: '2026-09-09T14:00:00Z' },
        { fill: 130, at: '2026-09-11T14:00:00Z' },
        { fill: 110, at: '2026-09-15T14:00:00Z' },
      ],
    },
    [slip('2026-09-07', 102), slip('2026-09-09', 118), slip('2026-09-11', 133), slip('2026-09-15', 110)],
  );
  assert.equal(r.calibration.maris.status, 'ok', JSON.stringify(r.calibration));
});

// ---------------------------------------------------------------- storno

test('storno cancels the slip it reverses', () => {
  const by = new Map([['M/1', [slip('2026-09-08', 100, 1), slip('2026-09-08', 150, 2), slip('2026-09-12', 100, 3)]]]);
  cancelReversals(by, [slip('2026-09-09', 100, 9)]);
  assert.deepEqual(
    by.get('M/1')!.map((s) => s.dokBroj),
    [2, 3],
  );
});

test('storno with no matching slip changes nothing', () => {
  const by = new Map([['M/1', [slip('2026-09-08', 100, 1)]]]);
  cancelReversals(by, [slip('2026-09-09', 52.48, 9)]);
  assert.equal(by.get('M/1')!.length, 1);
});

test('a small blip and its come-back do not cancel a real drop two days later', () => {
  const r = run({
    days: 4,
    startLevel: 380,
    events: [
      { offline: true, from: '2026-09-07T13:30:00Z', to: '2026-09-08T05:00:00Z' },
      { offset: 14, from: '2026-09-08T05:00:00Z', to: '2026-09-08T05:40:00Z' }, // reads high at start-up
      { offline: true, from: '2026-09-09T13:30:00Z', to: '2026-09-10T05:00:00Z' },
      { drain: 24, at: '2026-09-09T21:00:00Z' },
    ],
  });
  assert.equal(r.drains.length, 1, JSON.stringify(r.drains));
  near(r.drains[0].litres, 24, 4, 'drain litres');
});
