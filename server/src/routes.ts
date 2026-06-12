import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { db, getJsonSetting, setJsonSetting } from './db/index.js';
import { config } from './config.js';
import { listMachines, listMachinePositions } from './services/machines.js';
import { buildComparison, getFuelArticleCodes } from './services/comparison.js';
import { marisFetchItems, toMarisDate } from './maris/client.js';
import { marisHealth } from './maris/client.js';
import { lidatHealth } from './lidat/client.js';
import { runLidatSync, isSyncing } from './sync/lidatSync.js';
import { authenticate, signToken, requireAuth, type AuthedRequest } from './auth.js';
import { listUsers, createUser, updateUser, deleteUser } from './services/users.js';

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

// ---- Machines ----
api.get('/machines', (_req, res) => {
  res.json({ machines: listMachines() });
});

// Machine GPS positions as of a given date (defaults to today). Each machine's
// latest stored daily fix on or before that date.
api.get('/machines/positions', (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Expected date=YYYY-MM-DD' });
    return;
  }
  res.json({ date, positions: listMachinePositions(date) });
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
    const result = await buildComparison(parse.data.from, parse.data.to);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Sync ----
api.post('/sync', (_req, res) => {
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
const createUserSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(6, 'Lozinka mora imati barem 6 znakova'),
  role: roleSchema,
});
const updateUserSchema = z.object({
  username: z.string().min(1).optional(),
  password: z.string().min(6, 'Lozinka mora imati barem 6 znakova').optional(),
  role: roleSchema.optional(),
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
