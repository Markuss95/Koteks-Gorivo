// What people found when they checked a fuel-control event on site: confirmed,
// or a false alarm. Kept per event so the list shows what's been looked at, and
// counted per kind so it's clear how often each kind of finding holds up.
import { db } from '../db/index.js';
import type { ReviewVerdict, TankEventKind, TankReview } from './tank.js';

interface ReviewRow {
  event_key: string;
  serial_number: string;
  kind: TankEventKind;
  verdict: ReviewVerdict;
  note: string;
  username: string;
  updated_at: string;
}

const KINDS: TankEventKind[] = [
  'drain',
  'cycle_loss',
  'slip_mismatch',
  'slip_no_refuel',
  'refuel_no_slip',
  'refuel_awaiting_slip',
];

/** Reviews of these machines' events, by event key. */
export function reviewsOf(serials: string[]): Map<string, TankReview> {
  const out = new Map<string, TankReview>();
  if (serials.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT event_key, verdict, note, username, updated_at FROM tank_event_review
       WHERE serial_number IN (${serials.map(() => '?').join(',')})`,
    )
    .all(...serials) as ReviewRow[];
  for (const r of rows) {
    out.set(r.event_key, { verdict: r.verdict, note: r.note, username: r.username, updatedAt: r.updated_at });
  }
  return out;
}

/** How each kind of finding held up when checked, over these machines. */
export function reviewStats(serials: string[]): Record<TankEventKind, { confirmed: number; falseAlarm: number }> {
  const out = Object.fromEntries(KINDS.map((k) => [k, { confirmed: 0, falseAlarm: 0 }])) as Record<
    TankEventKind,
    { confirmed: number; falseAlarm: number }
  >;
  if (serials.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT kind, verdict, COUNT(*) n FROM tank_event_review
       WHERE serial_number IN (${serials.map(() => '?').join(',')}) GROUP BY kind, verdict`,
    )
    .all(...serials) as Array<{ kind: TankEventKind; verdict: ReviewVerdict; n: number }>;
  for (const r of rows) {
    if (!out[r.kind]) continue;
    if (r.verdict === 'confirmed') out[r.kind].confirmed = r.n;
    else out[r.kind].falseAlarm = r.n;
  }
  return out;
}

/** Record (or with a null verdict, withdraw) what was found for one event. */
export function saveReview(input: {
  key: string;
  serialNumber: string;
  kind: TankEventKind;
  day: string;
  verdict: ReviewVerdict | null;
  note: string;
  userId: number;
  username: string;
}): void {
  if (input.verdict === null) {
    db.prepare('DELETE FROM tank_event_review WHERE event_key = ?').run(input.key);
    return;
  }
  db.prepare(
    `INSERT INTO tank_event_review (event_key, serial_number, kind, event_day, verdict, note, user_id, username, updated_at)
     VALUES (@key, @serial, @kind, @day, @verdict, @note, @userId, @username, @at)
     ON CONFLICT(event_key) DO UPDATE SET
       verdict = excluded.verdict,
       note = excluded.note,
       user_id = excluded.user_id,
       username = excluded.username,
       updated_at = excluded.updated_at`,
  ).run({
    key: input.key,
    serial: input.serialNumber,
    kind: input.kind,
    day: input.day,
    verdict: input.verdict,
    note: input.note,
    userId: input.userId,
    username: input.username,
    at: new Date().toISOString(),
  });
}
