// Who receives which report automatically each month.
//
// Recipients are app users rather than free-typed addresses: usernames are
// already e-mail addresses, so a subscription can't outlive the account it
// belongs to (the FK cascades on delete).
import { db } from '../db/index.js';
import type { FormatChoice, ReportType } from './reports/select.js';

export interface ReportSubscription {
  id: number;
  userId: number;
  username: string;
  reportType: ReportType;
  format: FormatChoice;
  active: boolean;
  createdAt: string;
}

interface Row {
  id: number;
  user_id: number;
  username: string;
  report_type: string;
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
    format: r.format === 'excel' ? 'excel' : r.format === 'both' ? 'both' : 'pdf',
    active: r.active === 1,
    createdAt: r.created_at,
  };
}

const SELECT = `
  SELECT s.id, s.user_id, u.username, s.report_type, s.format, s.active, s.created_at
  FROM report_subscription s
  JOIN user u ON u.id = s.user_id
`;

export function listSubscriptions(): ReportSubscription[] {
  const rows = db.prepare(`${SELECT} ORDER BY u.username, s.report_type`).all() as Row[];
  return rows.map(toSubscription);
}

/** Active subscriptions only — what the scheduler actually sends. */
export function listActiveSubscriptions(): ReportSubscription[] {
  const rows = db
    .prepare(`${SELECT} WHERE s.active = 1 ORDER BY u.username, s.report_type`)
    .all() as Row[];
  return rows.map(toSubscription);
}

/**
 * Create or update one user's subscription to one report kind. The UNIQUE
 * (user_id, report_type) constraint makes this an upsert, so the admin UI can
 * just send the desired state without tracking whether a row exists.
 */
export function upsertSubscription(input: {
  userId: number;
  reportType: ReportType;
  format: FormatChoice;
  active: boolean;
}): ReportSubscription {
  const user = db.prepare('SELECT id FROM user WHERE id = ?').get(input.userId);
  if (!user) throw new Error('Korisnik ne postoji');

  db.prepare(
    `INSERT INTO report_subscription (user_id, report_type, format, active, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, report_type)
     DO UPDATE SET format = excluded.format, active = excluded.active`,
  ).run(
    input.userId,
    input.reportType,
    input.format,
    input.active ? 1 : 0,
    new Date().toISOString(),
  );

  const row = db
    .prepare(`${SELECT} WHERE s.user_id = ? AND s.report_type = ?`)
    .get(input.userId, input.reportType) as Row;
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
  format: string;
  status: string;
  message: string | null;
}

export function logReportRun(entry: {
  periodFrom: string;
  periodTo: string;
  recipient: string;
  reportType: string;
  format: string;
  status: 'success' | 'error';
  message?: string | null;
}): void {
  db.prepare(
    `INSERT INTO report_log (ran_at, period_from, period_to, recipient, report_type, format, status, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    entry.periodFrom,
    entry.periodTo,
    entry.recipient,
    entry.reportType,
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
