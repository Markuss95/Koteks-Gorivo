import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { db, getJsonSetting, setJsonSetting } from './db/index.js';
import { config } from './config.js';
import { listMachines, listMachinePositions, machineGroupsMap } from './services/machines.js';
import { buildComparison, getFuelArticleCodes } from './services/comparison.js';
import { buildUtilization, buildMachineSeries } from './services/utilization.js';
import { marisFetchItems, toMarisDate } from './maris/client.js';
import { marisHealth } from './maris/client.js';
import { lidatHealth } from './lidat/client.js';
import { runLidatSync, isSyncing } from './sync/lidatSync.js';
import { authenticate, signToken, requireAuth, type AuthedRequest } from './auth.js';
import { listUsers, createUser, updateUser, deleteUser } from './services/users.js';
import {
  MAX_ATTACHMENT_BYTES,
  MailNotConfiguredError,
  isMailConfigured,
  sendMail,
} from './services/mailer.js';
import {
  deleteSubscription,
  listSubscriptions,
  recentReportLog,
  upsertSubscription,
} from './services/subscriptions.js';
import { buildReport, reportTitle } from './services/reports/index.js';
import { expandFormats } from './services/reports/select.js';
import { fmtDate } from './services/reports/format.js';
import { runScheduledReports } from './sync/reportSchedule.js';
import type { MachineGroup } from './services/groups.js';

export const api = Router();

// ---- Auth ----
// Login is public; everything registered after `api.use(requireAuth)` is gated.
const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

api.post('/auth/login', (req, res) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Unesite korisničko ime i lozinku' });
    return;
  }
  const user = authenticate(parse.data.username, parse.data.password);
  if (!user) {
    res.status(401).json({ error: 'Pogrešno korisničko ime ili lozinka' });
    return;
  }
  res.json({ token: signToken(user), user });
});

// Public status root — Render's healthCheckPath (/api) hits this, so it must
// stay reachable without a token. Maps to GET /api via the '/api' mount.
api.get('/', (_req, res) => res.json({ name: 'Koteks Gorivo API', status: 'ok' }));

// Gate everything below: a valid token is required.
api.use(requireAuth);

api.get('/auth/me', (req, res) => {
  res.json({ user: (req as AuthedRequest).user });
});

// Admin-only guard (requireAuth above has already populated req.user).
function adminOnly(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Nemate ovlasti za ovu radnju' });
    return;
  }
  next();
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

// Range with the data-floor enforced: `from` may not predate config.dataMinDate.
const rangeSchema = z
  .object({ from: dateSchema, to: dateSchema })
  .refine((r) => r.from >= config.dataMinDate, {
    message: `Date must not be before ${config.dataMinDate} (no LiDAT history available earlier).`,
    path: ['from'],
  })
  .refine((r) => r.from <= r.to, { message: 'from must be on or before to', path: ['from'] });

// ---- Health ----
api.get('/health', async (_req, res) => {
  const [maris, lidat] = await Promise.all([marisHealth(), lidatHealth()]);
  const readingCount = (db.prepare('SELECT COUNT(*) AS c FROM lidat_fuel_reading').get() as {
    c: number;
  }).c;
  const machineCount = (db.prepare('SELECT COUNT(*) AS c FROM machine').get() as { c: number }).c;
  const lastSync = db
    .prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1')
    .get();
  res.json({
    maris,
    lidat,
    db: { readingCount, machineCount },
    sync: { running: isSyncing(), last: lastSync ?? null, cron: config.sync.cron },
  });
});

// Groups the requesting user may see (admins already carry all three).
function reqGroups(req: AuthedRequest) {
  return req.user?.allowedGroups;
}

// Whether the requesting user is allowed to see a specific machine (by group).
function canAccessSerial(req: AuthedRequest, serial: string): boolean {
  const allowed = reqGroups(req);
  if (!allowed) return true;
  const group = machineGroupsMap().get(serial) ?? 'osijek';
  return allowed.includes(group);
}

// ---- Machines ----
api.get('/machines', (req, res) => {
  res.json({ machines: listMachines(reqGroups(req as AuthedRequest)) });
});

// Machine GPS positions as of a given date (defaults to today). Each machine's
// latest stored daily fix on or before that date.
api.get('/machines/positions', (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Expected date=YYYY-MM-DD' });
    return;
  }
  res.json({ date, positions: listMachinePositions(date, reqGroups(req as AuthedRequest)) });
});

// Per-machine detail: LiDAT cumulative series + Maris issuances in range.
api.get('/machines/:serial/series', async (req, res) => {
  const parse = rangeSchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() });
    return;
  }
  const { from, to } = parse.data;
  const serial = req.params.serial;

  if (!canAccessSerial(req as AuthedRequest, serial)) {
    res.status(404).json({ error: 'Machine not found' });
    return;
  }

  const machine = db
    .prepare('SELECT * FROM machine WHERE serial_number = ?')
    .get(serial) as any;
  if (!machine) {
    res.status(404).json({ error: 'Machine not found' });
    return;
  }

  const readings = db
    .prepare(
      `SELECT reading_time, fuel_consumed_cum, fuel_units FROM lidat_fuel_reading
       WHERE serial_number = ? AND reading_time >= ? AND reading_time <= ?
       ORDER BY reading_time ASC`,
    )
    .all(serial, `${from}T00:00:00Z`, `${to}T23:59:59Z`) as Array<{
    reading_time: string;
    fuel_consumed_cum: number;
    fuel_units: string | null;
  }>;

  const rnalogs = (
    db.prepare('SELECT rnalog FROM machine_rnalog WHERE serial_number = ?').all(serial) as Array<{
      rnalog: string;
    }>
  ).map((r) => r.rnalog);

  // Maris issuances for this machine's work orders.
  const fuelCodes = getFuelArticleCodes();
  const datumOd = toMarisDate(`${from}T00:00:00Z`);
  const datumDo = toMarisDate(`${to}T00:00:00Z`);
  const rnalogSet = new Set(rnalogs.map((r) => r.trim()));
  const marisItems: any[] = [];
  for (const code of fuelCodes) {
    const items = await marisFetchItems({ datumOd, datumDo, artikl: code, rowCount: 0 });
    for (const it of items) {
      if (rnalogSet.has((it.RNALOG ?? '').trim())) {
        marisItems.push({
          datum: it.DATUM,
          rnalog: it.RNALOG,
          sklSifra: it.SKL_SIFRA,
          sklNaziv: it.SKL_NAZIV,
          dokNaziv: it.DOK_NAZIV,
          dokBroj: it.DOK_BROJ,
          artSifra: it.ART_SIFRA,
          artNaziv: it.ART_NAZIV,
          kolicina: it.KOLICINA,
          jmj: it.JMJ,
          vrijednost: it.VRIJEDNOST,
        });
      }
    }
  }
  marisItems.sort((a, b) => a.datum.localeCompare(b.datum));

  res.json({
    machine: {
      serialNumber: machine.serial_number,
      model: machine.model,
      equipmentId: machine.equipment_id,
      rnalogs,
      latitude: machine.latitude ?? null,
      longitude: machine.longitude ?? null,
      locationTime: machine.location_time ?? null,
    },
    lidatReadings: readings.map((r) => ({
      time: r.reading_time,
      fuelConsumedCum: r.fuel_consumed_cum,
      fuelUnits: r.fuel_units,
    })),
    marisItems,
  });
});

// ---- Comparison ----
api.get('/comparison', async (req, res) => {
  const parse = rangeSchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() });
    return;
  }
  try {
    const result = await buildComparison(
      parse.data.from,
      parse.data.to,
      reqGroups(req as AuthedRequest),
    );
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Utilization (operating hours, fuel/h, movement within a range) ----
api.get('/utilization', (req, res) => {
  const parse = rangeSchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() });
    return;
  }
  res.json(buildUtilization(parse.data.from, parse.data.to, reqGroups(req as AuthedRequest)));
});

// Per-machine daily series (operating/idle hours + fuel) for the modal chart.
api.get('/utilization/:serial/series', (req, res) => {
  const parse = rangeSchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() });
    return;
  }
  if (!canAccessSerial(req as AuthedRequest, req.params.serial)) {
    res.status(404).json({ error: 'Machine not found' });
    return;
  }
  res.json(buildMachineSeries(req.params.serial, parse.data.from, parse.data.to));
});

// ---- Sync ----
api.post('/sync', adminOnly, (_req, res) => {
  if (isSyncing()) {
    res.status(409).json({ error: 'Sync already running' });
    return;
  }
  // Fire and forget; client polls /health or /sync/status.
  runLidatSync().catch((err) => console.error('[sync] failed:', err));
  res.status(202).json({ started: true });
});

api.get('/sync/status', (_req, res) => {
  const logs = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 20').all();
  res.json({ running: isSyncing(), logs });
});

// ---- Settings ----
api.get('/settings', (_req, res) => {
  res.json({
    fuelArticleCodes: getFuelArticleCodes(),
    syncCron: config.sync.cron,
    minDate: config.dataMinDate,
    // Prefill + client-side hint for the "send report" dialog; not secrets. The
    // domain restriction is enforced server-side regardless.
    mailTo: config.mail.defaultTo,
    mailConfigured: isMailConfigured(),
    mailAllowedDomains: config.mail.allowedDomains,
  });
});

const settingsSchema = z.object({
  fuelArticleCodes: z.array(z.string().min(1)).min(1),
});

api.put('/settings', (req, res) => {
  const parse = settingsSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() });
    return;
  }
  setJsonSetting('fuelArticleCodes', parse.data.fuelArticleCodes);
  res.json({
    fuelArticleCodes: getFuelArticleCodes(),
    syncCron: config.sync.cron,
    minDate: config.dataMinDate,
  });
});

// ---- Users (admin only) ----
const roleSchema = z.enum(['user', 'admin']);
const groupsSchema = z.array(z.enum(['osijek', 'velicki', 'psunj'])).optional();
const createUserSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(6, 'Lozinka mora imati barem 6 znakova'),
  role: roleSchema,
  allowedGroups: groupsSchema,
});
const updateUserSchema = z.object({
  username: z.string().min(1).optional(),
  password: z.string().min(6, 'Lozinka mora imati barem 6 znakova').optional(),
  role: roleSchema.optional(),
  allowedGroups: groupsSchema,
});

function parseUserId(req: { params: Record<string, string> }): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

api.get('/users', adminOnly, (_req, res) => {
  res.json({ users: listUsers() });
});

api.post('/users', adminOnly, (req, res) => {
  const parse = createUserSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() });
    return;
  }
  try {
    res.status(201).json({ user: createUser(parse.data) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

api.put('/users/:id', adminOnly, (req, res) => {
  const id = parseUserId(req);
  if (id === null) {
    res.status(400).json({ error: 'Neispravan ID' });
    return;
  }
  const parse = updateUserSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() });
    return;
  }
  try {
    res.json({ user: updateUser(id, parse.data) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

api.delete('/users/:id', adminOnly, (req, res) => {
  const id = parseUserId(req);
  if (id === null) {
    res.status(400).json({ error: 'Neispravan ID' });
    return;
  }
  if ((req as AuthedRequest).user?.id === id) {
    res.status(400).json({ error: 'Ne možete obrisati vlastiti račun' });
    return;
  }
  try {
    deleteUser(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Report e-mail ----
// The browser builds the PDF/XLSX (same code as the download button) and posts
// it here as base64; the server attaches it and sends via Microsoft Graph. The
// recipient is fixed in config for now — no address is accepted from the client,
// so this endpoint can't be used to mail arbitrary people.
// The server builds the file itself now — the client sends only the report
// parameters, never an attachment.
const emailReportSchema = z.object({
  type: z.enum(['fuel', 'activity']),
  // 'both' attaches one PDF and one Excel to the same message.
  format: z.enum(['pdf', 'excel', 'both']),
  from: dateSchema,
  to: dateSchema,
  scope: z.enum(['matched', 'all']).optional(),
  groups: z.array(z.enum(['osijek', 'velicki', 'psunj'])).min(1).optional(),
  // Recipient chosen by the admin in the UI. Omitted → the configured default.
  recipient: z.string().email('Neispravna e-mail adresa').max(320).optional(),
});

/**
 * Recipient domain check. The address is taken from the last '@' so that a local
 * part containing '@' can't smuggle a foreign domain past the comparison. An
 * empty allowlist disables the restriction entirely.
 */
function recipientDomainAllowed(address: string): boolean {
  if (config.mail.allowedDomains.length === 0) return true;
  const at = address.lastIndexOf('@');
  if (at === -1) return false;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return config.mail.allowedDomains.includes(domain);
}

// Admin-only: this sends mail as noreply@ to an address the caller supplies, so
// it must not be reachable by ordinary users. Hiding the button in the UI is
// cosmetic — this is the actual gate.
api.post('/reports/email', adminOnly, async (req, res) => {
  const parse = emailReportSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() });
    return;
  }
  const { type, format, from, to, scope, recipient } = parse.data;

  // Recipient is validated before the configuration check: it's a property of
  // the request, so it must answer the same way whether or not mail happens to
  // be configured. Checked on the address actually used, so a misconfigured
  // MAIL_TO can't bypass the allowlist.
  const address = recipient ?? config.mail.defaultTo;
  if (!recipientDomainAllowed(address)) {
    res.status(400).json({
      error: `Slanje je dopušteno samo na domene: ${config.mail.allowedDomains.join(', ')}.`,
    });
    return;
  }

  if (!isMailConfigured()) {
    res.status(503).json({ error: new MailNotConfiguredError().message });
    return;
  }

  const groups = resolveGroups(req as AuthedRequest, parse.data.groups as MachineGroup[] | undefined);
  if (groups.length === 0) {
    res.status(403).json({ error: 'Nemate pristup odabranim grupama' });
    return;
  }

  try {
    const reports = [];
    for (const f of expandFormats(format)) {
      reports.push(await buildReport({ type, format: f, from, to, groups, scope }));
    }

    // Graph caps the whole request, so the check is on the combined size.
    const totalBytes = reports.reduce((sum, r) => sum + r.buffer.length, 0);
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      res.status(413).json({
        error: `Izvještaj je prevelik za slanje e-poštom (${(totalBytes / 1024 / 1024).toFixed(1)} MB, ograničenje ${(MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(1)} MB).`,
      });
      return;
    }

    const title = reportTitle(type);
    // Name the worksite when the report covers exactly one, matching the
    // subjects the monthly schedule sends.
    const site = reports[0].groupLabel;
    const subject = site
      ? `${title} · ${site} · ${fmtDate(from)} – ${fmtDate(to)}`
      : `${title} · ${fmtDate(from)} – ${fmtDate(to)}`;
    await sendMail({
      to: [address],
      subject,
      text: `U prilogu je ${title.toLowerCase()}${site ? ` za ${site}` : ''}, razdoblje ${fmtDate(from)} – ${fmtDate(to)}.`,
      attachments: reports.map((r) => ({
        filename: r.filename,
        contentType: r.contentType,
        contentBase64: r.buffer.toString('base64'),
      })),
    });
    console.log(`[mail] report "${reports.map((r) => r.filename).join(', ')}" sent to ${address} by ${(req as AuthedRequest).user?.username}`);
    res.json({ ok: true, to: address });
  } catch (err) {
    console.error('[mail] send failed:', err);
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Report subscriptions (admin) ----
const subscriptionSchema = z.object({
  userId: z.number().int().positive(),
  reportType: z.enum(['fuel', 'activity']),
  cadence: z.enum(['monthly', 'quarterly']),
  format: z.enum(['pdf', 'excel', 'both']),
  active: z.boolean(),
});

api.get('/report-subscriptions', adminOnly, (_req, res) => {
  res.json({ subscriptions: listSubscriptions(), log: recentReportLog(20) });
});

api.put('/report-subscriptions', adminOnly, (req, res) => {
  const parse = subscriptionSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() });
    return;
  }
  try {
    res.json({ subscription: upsertSubscription(parse.data) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

api.delete('/report-subscriptions/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Neispravan ID' });
    return;
  }
  deleteSubscription(id);
  res.json({ ok: true });
});

/**
 * Manual trigger for a scheduled run, so an admin can verify the whole pipeline
 * without waiting for month end. `dryRun` builds everything and sends nothing;
 * a forced quarterly run uses the last quarter that has fully ended.
 */
const runSchema = z.object({
  dryRun: z.boolean().optional(),
  cadence: z.enum(['monthly', 'quarterly']).optional(),
});

api.post('/report-subscriptions/run', adminOnly, async (req, res) => {
  const parse = runSchema.safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() });
    return;
  }
  const { dryRun = false, cadence = 'monthly' } = parse.data;
  try {
    const result = await runScheduledReports({ force: true, dryRun, cadence });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Server-side report generation ----
// One code path for the download button, the manual e-mail and the monthly
// schedule, so all three produce identical files.
const buildSchema = z.object({
  type: z.enum(['fuel', 'activity']),
  format: z.enum(['pdf', 'excel']),
  from: dateSchema,
  to: dateSchema,
  scope: z.enum(['matched', 'all']).optional(),
  groups: z.array(z.enum(['osijek', 'velicki', 'psunj'])).min(1).optional(),
});

/** Groups the caller may see, intersected with any they explicitly asked for. */
function resolveGroups(req: AuthedRequest, requested?: MachineGroup[]): MachineGroup[] {
  const allowed = req.user?.allowedGroups ?? [];
  if (!requested) return allowed;
  return requested.filter((g) => allowed.includes(g));
}

api.post('/reports/generate', async (req, res) => {
  const parse = buildSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.flatten() });
    return;
  }
  const groups = resolveGroups(req as AuthedRequest, parse.data.groups as MachineGroup[] | undefined);
  if (groups.length === 0) {
    res.status(403).json({ error: 'Nemate pristup odabranim grupama' });
    return;
  }
  try {
    const report = await buildReport({ ...parse.data, groups });
    res.setHeader('Content-Type', report.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    // Lets the browser read the filename despite CORS.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(report.buffer);
  } catch (err) {
    console.error('[reports] generate failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
