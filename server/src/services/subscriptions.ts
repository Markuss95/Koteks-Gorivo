// Who receives which report automatically, and how often.
//
// Recipients are app users rather than free-typed addresses: usernames are
// already e-mail addresses, so a subscription can't outlive the account it
// belongs to (the FK cascades on delete).
import { db } from '../db/index.js';
import type { FormatChoice, ReportCadence, ReportType } from './reports/select.js';

export interface ReportSubscription {
  id: number;
  userId: number;
  username: string;
  reportType: ReportType;
  cadence: ReportCadence;
  format: FormatChoice;
  active: boolean;
  createdAt: string;
}

interface Row {
  id: number;
  user_id: number;
  username: string;
  report_type: string;
  cadence: string;
  format: string;
  active: number;
  created_at: string;
}

function toSubscription(r: Row): ReportSubscription {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    reportType: r.report_type === 'activity' ? 'activity' : 'fuel',
    cadence: r.cadence === 'quarterly' ? 'quarterly' : 'monthly',
    format: r.format === 'excel' ? 'excel' : r.format === 'both' ? 'both' : 'pdf',
    active: r.active === 1,
    createdAt: r.created_at,
  };
}

const SELECT = `
  SELECT s.id, s.user_id, u.username, s.report_type, s.cadence, s.format, s.active, s.created_at
  FROM report_subscription s
  JOIN user u ON u.id = s.user_id
`;

const ORDER = 'ORDER BY u.username, s.cadence, s.report_type';

export function listSubscriptions(): ReportSubscription[] {
  const rows = db.prepare(`${SELECT} ${ORDER}`).all() as Row[];
  return rows.map(toSubscription);
}

/**
 * Active subscriptions for one cadence — what a scheduled run actually sends.
 * A monthly run must not pick up quarterly rows, and vice versa.
 */
export function listActiveSubscriptions(cadence: ReportCadence): ReportSubscription[] {
  const rows = db
    .prepare(`${SELECT} WHERE s.active = 1 AND s.cadence = ? ${ORDER}`)
    .all(cadence) as Row[];
  return rows.map(toSubscription);
}

/**
 * Create or update one user's subscription to one report kind at one cadence.
 * The UNIQUE (user_id, report_type, cadence) constraint makes this an upsert, so
 * the admin UI can just send the desired state without tracking whether a row
 * exists.
 */
export function upsertSubscription(input: {
  userId: number;
  reportType: ReportType;
  cadence: ReportCadence;
  format: FormatChoice;
  active: boolean;
}): ReportSubscription {
  const user = db.prepare('SELECT id FROM user WHERE id = ?').get(input.userId);
  if (!user) throw new Error('Korisnik ne postoji');

  db.prepare(
    `INSERT INTO report_subscription (user_id, report_type, cadence, format, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, report_type, cadence)
     DO UPDATE SET format = excluded.format, active = excluded.active`,
  ).run(
    input.userId,
    input.reportType,
    input.cadence,
    input.format,
    input.active ? 1 : 0,
    new Date().toISOString(),
  );

  const row = db
    .prepare(`${SELECT} WHERE s.user_id = ? AND s.report_type = ? AND s.cadence = ?`)
    .get(input.userId, input.reportType, input.cadence) as Row;
  return toSubscription(row);
}

export function deleteSubscription(id: number): void {
  db.prepare('DELETE FROM report_subscription WHERE id = ?').run(id);
}

// ---- Run log ----

export interface ReportLogEntry {
  id: number;
  ran_at: string;
  period_from: string;
  period_to: string;
  recipient: string;
  report_type: string;
  cadence: string;
  format: string;
  status: string;
  message: string | null;
}

export function logReportRun(entry: {
  periodFrom: string;
  periodTo: string;
  recipient: string;
  reportType: string;
  cadence: ReportCadence;
  format: string;
  status: 'success' | 'error';
  message?: string | null;
}): void {
  db.prepare(
    `INSERT INTO report_log (ran_at, period_from, period_to, recipient, report_type, cadence, format, status, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    entry.periodFrom,
    entry.periodTo,
    entry.recipient,
    entry.reportType,
    entry.cadence,
    entry.format,
    entry.status,
    entry.message ?? null,
  );
}

export function recentReportLog(limit = 50): ReportLogEntry[] {
  return db
    .prepare('SELECT * FROM report_log ORDER BY id DESC LIMIT ?')
    .all(limit) as ReportLogEntry[];
}
