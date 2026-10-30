// How much of a range a machine's LiDAT counter can be compared over. Each
// scenario is a way a machine can stop reporting near the end of a range; the
// comparison must cut off one that went quiet while it kept working, and leave
// alone one that was just parked or idle over a weekend. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// lidatConsumption reads the readings table, so give it a fresh throwaway
// database and placeholder settings.
const dbPath = path.join(os.tmpdir(), `koteks-gorivo-comparison-test-${process.pid}.db`);
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
process.env.DB_PATH = dbPath;
for (const name of ['LIDAT_BASE_URL', 'LIDAT_USERNAME', 'LIDAT_PASSWORD', 'MARIS_BASE_URL', 'MARIS_CLIENT_ID', 'MARIS_CLIENT_SECRET']) {
  process.env[name] ??= 'http://placeholder.invalid';
}
const { db, initSchema } = await import('../db/index.js');
const { lidatConsumption } = await import('./comparison.js');
const { silentCutoffDay } = await import('./readings.js');
initSchema();

let serialSeq = 0;

/** A machine with one reading per working day at 10:00 UTC, 20 L a day. */
function machine(days: string[], extra: Array<[string, number]> = []): string {
  const serial = `T${++serialSeq}`;
  db.prepare('INSERT INTO machine (serial_number, model) VALUES (?, ?)').run(serial, 'Test:Test:R 924:1');
  const insert = db.prepare(
    `INSERT INTO lidat_fuel_reading (serial_number, reading_time, fuel_consumed_cum, fuel_units, fetched_at)
     VALUES (?, ?, ?, 'litre', '2026-10-30T00:00:00Z')`,
  );
  days.forEach((day, i) => insert.run(serial, `${day}T10:00:00Z`, 1000 + 20 * i));
  for (const [time, cum] of extra) insert.run(serial, time, cum);
  return serial;
}

/** Every Mon–Fri from `from` to `to` inclusive (no holidays in these ranges). */
function workdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const FROM = '2026-09-01T00:00:00Z';
const TO = '2026-09-30T23:59:59Z';

test('silentCutoffDay: quiet for working days → the day before the last reading', () => {
  // 42196: last reading Tue 22 Sep 2026, range to Wed 30 Sep.
  assert.equal(silentCutoffDay('2026-09-22T11:29:07Z', '2026-09-30'), '2026-09-21');
  // 42410: last reading early Mon 28 Sep; Tue 29 passed with nothing.
  assert.equal(silentCutoffDay('2026-09-28T04:51:01Z', '2026-09-30'), '2026-09-27');
});

test('silentCutoffDay: last reading on the last day → not quiet', () => {
  assert.equal(silentCutoffDay('2026-09-30T14:00:00Z', '2026-09-30'), null);
});

test('silentCutoffDay: only a weekend or holidays after the last reading → not quiet', () => {
  // Fri 30 Oct 2026, range to Sat 31 Oct.
  assert.equal(silentCutoffDay('2026-10-30T13:00:00Z', '2026-10-31'), null);
  // Thu 24 Dec 2026, then Božić, Sveti Stjepan (Sat) and a Sunday.
  assert.equal(silentCutoffDay('2026-12-24T12:00:00Z', '2026-12-27'), null);
});

test('machine that went quiet a week early is compared up to the day before', () => {
  // Reports every working day 31 Aug – 22 Sep, then nothing (like 42196).
  const days = workdays('2026-08-31', '2026-09-22');
  const serial = machine(days);
  const r = lidatConsumption(serial, FROM, TO);
  assert.equal(r.partial, false);
  assert.equal(r.comparedUntil, '2026-09-21');
  assert.equal(r.silentSince, '2026-09-22T10:00:00Z');
  assert.equal(r.endTime, '2026-09-21T10:00:00Z');
  // Baseline is 31 Aug (index 0); 21 Sep is the 16th working day after it.
  assert.equal(r.consumed, 20 * days.indexOf('2026-09-21'));
});

test('machine that went quiet but was parked (counter flat on return) is not cut', () => {
  const days = workdays('2026-08-31', '2026-09-22');
  const lastCum = 1000 + 20 * (days.length - 1);
  const serial = machine(days, [['2026-10-05T07:00:00Z', lastCum + 3]]);
  const r = lidatConsumption(serial, FROM, TO);
  assert.equal(r.partial, false);
  assert.equal(r.comparedUntil, null);
  assert.equal(r.endTime, '2026-09-22T10:00:00Z');
});

test('machine that went quiet and worked unseen (counter jumped on return) is cut', () => {
  const days = workdays('2026-08-31', '2026-09-22');
  const lastCum = 1000 + 20 * (days.length - 1);
  const serial = machine(days, [['2026-10-05T07:00:00Z', lastCum + 150]]);
  const r = lidatConsumption(serial, FROM, TO);
  assert.equal(r.partial, false);
  assert.equal(r.comparedUntil, '2026-09-21');
});

test('machine reporting to the last day is not cut', () => {
  const serial = machine(workdays('2026-08-31', '2026-09-30'));
  const r = lidatConsumption(serial, FROM, TO);
  assert.equal(r.partial, false);
  assert.equal(r.comparedUntil, null);
  assert.equal(r.silentSince, null);
});

test('machine quiet for more than 14 days before the end stays partial', () => {
  const serial = machine(workdays('2026-08-31', '2026-09-14'));
  const r = lidatConsumption(serial, FROM, TO);
  assert.equal(r.partial, true);
  assert.equal(r.comparedUntil, null);
});

test('machine whose cut would fall before the range starts is partial', () => {
  // Range 1–10 Sep; last reading 1 Sep → cut 31 Aug, before the range.
  const serial = machine(workdays('2026-08-31', '2026-09-01'));
  const r = lidatConsumption(serial, FROM, '2026-09-10T23:59:59Z');
  assert.equal(r.partial, true);
  assert.equal(r.comparedUntil, null);
});

test.after(() => {
  db.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
});
