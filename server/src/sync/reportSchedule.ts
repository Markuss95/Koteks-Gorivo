// Monthly automatic reports.
//
// A daily cron wakes up and does nothing unless today is the last working day of
// the month. On that day each active subscription gets its report for the *whole
// previous month* — a run on 31 Aug sends 01.07.–31.07.
import { config } from '../config.js';
import { listActiveSubscriptions, logReportRun } from '../services/subscriptions.js';
import { getUserById, userAllowedGroups } from '../services/users.js';
import { buildReport, reportTitle } from '../services/reports/index.js';
import { expandFormats } from '../services/reports/select.js';
import { isMailConfigured, sendMail } from '../services/mailer.js';
import { fmtDate } from '../services/reports/format.js';
import { isLastWorkingDayOfMonth, previousMonthRange } from '../services/workdays.js';
import { GROUP_LABELS, type MachineGroup } from '../services/groups.js';

export interface RunResult {
  ran: boolean;
  reason?: string;
  from?: string;
  to?: string;
  sent: number;
  failed: number;
  skipped: number;
  details: Array<{
    recipient: string;
    type: string;
    format: string;
    group: string;
    status: string;
    message?: string;
  }>;
}

/** Recipient domain check, mirroring the manual-send endpoint. */
function domainAllowed(address: string): boolean {
  if (config.mail.allowedDomains.length === 0) return true;
  const at = address.lastIndexOf('@');
  if (at === -1) return false;
  return config.mail.allowedDomains.includes(address.slice(at + 1).trim().toLowerCase());
}

/**
 * Build and send every active subscription for the previous month.
 *
 * @param opts.force    run regardless of the calendar (manual "run now")
 * @param opts.dryRun   build everything but send nothing — used to verify a run
 *                      without mailing anyone
 * @param opts.now      pretend it is this date (testing)
 */
export async function runMonthlyReports(opts: {
  force?: boolean;
  dryRun?: boolean;
  now?: Date;
} = {}): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const result: RunResult = { ran: false, sent: 0, failed: 0, skipped: 0, details: [] };

  if (!opts.force && !isLastWorkingDayOfMonth(now)) {
    result.reason = 'nije zadnji radni dan u mjesecu';
    return result;
  }
  if (!opts.dryRun && !isMailConfigured()) {
    result.reason = 'e-pošta nije konfigurirana';
    return result;
  }

  const { from, to } = previousMonthRange(now);
  result.ran = true;
  result.from = from;
  result.to = to;

  const subs = listActiveSubscriptions();
  if (subs.length === 0) {
    result.reason = 'nema aktivnih pretplata';
    return result;
  }

  // Reports are identical for any two subscribers with the same type, format and
  // visible groups, so build once and reuse — the fuel report is the slow part.
  const cache = new Map<string, Awaited<ReturnType<typeof buildReport>>>();
  const pushDetail = (d: RunResult['details'][number]) => result.details.push(d);

  for (const sub of subs) {
    const base = { recipient: sub.username, type: sub.reportType, format: sub.format };

    try {
      if (!domainAllowed(sub.username)) {
        pushDetail({ ...base, group: '—', status: 'skipped', message: 'domena primatelja nije dopuštena' });
        result.skipped += 1;
        continue;
      }

      const user = getUserById(sub.userId);
      if (!user) {
        pushDetail({ ...base, group: '—', status: 'skipped', message: 'korisnik više ne postoji' });
        result.skipped += 1;
        continue;
      }

      // Mirrors the app's own visibility rules: admins see every group, others
      // only what they've been granted. A report can't reveal more than the
      // recipient could see by logging in.
      const groups: MachineGroup[] = userAllowedGroups(
        user.id,
        user.role === 'admin' ? 'admin' : 'user',
      );
      if (groups.length === 0) {
        pushDetail({ ...base, group: '—', status: 'skipped', message: 'korisnik nema dodijeljenih grupa' });
        result.skipped += 1;
        continue;
      }

      // One mail per worksite rather than a single combined report: the figures
      // are only meaningful per site, and the subject can then name the site.
      for (const group of groups) {
        const label = GROUP_LABELS[group];

        // 'both' produces one PDF and one Excel, attached to the same message.
        const reports = [];
        for (const f of expandFormats(sub.format)) {
          const key = `${sub.reportType}|${f}|${group}`;
          let report = cache.get(key);
          if (!report) {
            report = await buildReport({
              type: sub.reportType,
              format: f,
              from,
              to,
              groups: [group],
              scope: 'matched',
            });
            cache.set(key, report);
          }
          reports.push(report);
        }

        if (reports.every((r) => r.rowCount === 0)) {
          pushDetail({ ...base, group: label, status: 'skipped', message: 'nema podataka za razdoblje' });
          result.skipped += 1;
          continue;
        }

        const title = reportTitle(sub.reportType);
        const subject = `${title} · ${label} · ${fmtDate(from)} – ${fmtDate(to)}`;
        if (!opts.dryRun) {
          await sendMail({
            to: [sub.username],
            subject,
            text:
              `U prilogu je ${title.toLowerCase()} za ${label}, razdoblje ${fmtDate(from)} – ${fmtDate(to)}.

` +
              'Logirajte se na aplikaciju preko linka https://koteks-gorivo.netlify.app/.\n' +
              'Ako nemate podatke za prijavu javite se Marku 🙂\n\n' +
              'Ovo je automatska poruka iz aplikacije Koteks Gorivo.',
            attachments: reports.map((r) => ({
              filename: r.filename,
              contentType: r.contentType,
              contentBase64: r.buffer.toString('base64'),
            })),
          });
          logReportRun({
            periodFrom: from,
            periodTo: to,
            recipient: sub.username,
            reportType: `${sub.reportType} (${label})`,
            format: sub.format,
            status: 'success',
          });
        }
        result.sent += 1;
        pushDetail({ ...base, group: label, status: opts.dryRun ? 'dry-run' : 'sent' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed += 1;
      pushDetail({ ...base, group: '—', status: 'error', message });
      // One recipient failing must not abort the rest of the run.
      console.error(`[reports] failed for ${sub.username}:`, message);
      if (!opts.dryRun) {
        logReportRun({
          periodFrom: from,
          periodTo: to,
          recipient: sub.username,
          reportType: sub.reportType,
          format: sub.format,
          status: 'error',
          message,
        });
      }
    }
  }

  return result;
}
