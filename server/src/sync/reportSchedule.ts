// Automatic report runs — monthly and quarterly.
//
// A daily cron wakes up and does nothing unless today is the last working day of
// the month. On that day every active monthly subscription gets its report for
// the *whole previous month* — a run on 31 Aug sends 01.07.–31.07.
//
// Quarterly subscriptions follow the same one-month lag, so they only go out
// four times a year: Q1 (Jan–Mar) at the end of April, Q2 at the end of July,
// Q3 at the end of October and Q4 at the end of January.
import { config } from '../config.js';
import { listActiveSubscriptions, logReportRun } from '../services/subscriptions.js';
import { getUserById, userAllowedGroups } from '../services/users.js';
import { buildReport, reportTitle } from '../services/reports/index.js';
import { expandFormats, type ReportCadence } from '../services/reports/select.js';
import { isMailConfigured, sendMail } from '../services/mailer.js';
import { fmtDate } from '../services/reports/format.js';
import { isLastWorkingDayOfMonth, periodForCadence } from '../services/workdays.js';
import { GROUP_LABELS, type MachineGroup } from '../services/groups.js';

export interface RunResult {
  ran: boolean;
  cadence: ReportCadence;
  reason?: string;
  from?: string;
  to?: string;
  /** 'Q1 2026' on a quarterly run; absent for monthly, where the dates say it all. */
  periodLabel?: string;
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
 * Build and send every active subscription of one cadence, for the period that
 * cadence has just completed.
 *
 * @param opts.cadence  'monthly' (previous month) or 'quarterly' (previous quarter)
 * @param opts.force    run regardless of the calendar (manual "run now")
 * @param opts.dryRun   build everything but send nothing — used to verify a run
 *                      without mailing anyone
 * @param opts.now      pretend it is this date (testing)
 */
export async function runScheduledReports(opts: {
  cadence?: ReportCadence;
  force?: boolean;
  dryRun?: boolean;
  now?: Date;
} = {}): Promise<RunResult> {
  const cadence = opts.cadence ?? 'monthly';
  const now = opts.now ?? new Date();
  const result: RunResult = { ran: false, cadence, sent: 0, failed: 0, skipped: 0, details: [] };

  if (!opts.force && !isLastWorkingDayOfMonth(now)) {
    result.reason = 'nije zadnji radni dan u mjesecu';
    return result;
  }

  // A forced quarterly run falls back to the last quarter that has fully ended,
  // so an admin can test it on any day of the year; a scheduled one only
  // proceeds in the month right after a quarter closes.
  const period = periodForCadence(now, cadence, opts.force === true);
  if (!period) {
    result.reason = 'prethodni mjesec nije kraj kvartala';
    return result;
  }
  if (!opts.dryRun && !isMailConfigured()) {
    result.reason = 'e-pošta nije konfigurirana';
    return result;
  }

  const { from, to } = period;
  result.ran = true;
  result.from = from;
  result.to = to;
  if (period.label) result.periodLabel = period.label;

  const subs = listActiveSubscriptions(cadence);
  if (subs.length === 0) {
    result.reason = 'nema aktivnih pretplata';
    return result;
  }

  // How the period is named in the subject and in the body. A quarter carries
  // its label ("Q1 2026") as well as the dates; a month is only ever the dates.
  const periodText = period.label
    ? `${period.label} (${fmtDate(from)} – ${fmtDate(to)})`
    : `${fmtDate(from)} – ${fmtDate(to)}`;
  const periodPhrase = period.label
    ? `kvartal ${period.label} (${fmtDate(from)} – ${fmtDate(to)})`
    : `razdoblje ${fmtDate(from)} – ${fmtDate(to)}`;

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
        const subject = `${title} · ${label} · ${periodText}`;
        if (!opts.dryRun) {
          await sendMail({
            to: [sub.username],
            subject,
            text:
              `U prilogu je ${title.toLowerCase()} za ${label}, ${periodPhrase}.\n\n` +
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
            cadence,
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
          cadence,
          format: sub.format,
          status: 'error',
          message,
        });
      }
    }
  }

  return result;
}

/**
 * The daily job. Runs both cadences and lets each decide whether it is due:
 * monthly on the last working day of every month, quarterly only when the month
 * that just ended also closed a quarter.
 */
export async function runDueReports(now?: Date): Promise<RunResult[]> {
  const cadences: ReportCadence[] = ['monthly', 'quarterly'];
  const results: RunResult[] = [];
  for (const cadence of cadences) {
    results.push(await runScheduledReports({ cadence, now }));
  }
  return results;
}
