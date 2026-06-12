import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// Ensure the data directory exists.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS machine (
      serial_number TEXT PRIMARY KEY,
      model         TEXT NOT NULL,
      oem_name      TEXT,
      make_code     TEXT,
      equipment_id  TEXT,
      fuel_tank_capacity REAL,
      active        INTEGER NOT NULL DEFAULT 1,
      notes         TEXT,
      latitude      REAL,                       -- last known GPS position (ISO 15143-3 Location)
      longitude     REAL,
      location_time TEXT                         -- ISO 8601 UTC of that fix
    );

    CREATE TABLE IF NOT EXISTS machine_rnalog (
      serial_number TEXT NOT NULL,
      rnalog        TEXT NOT NULL,
      PRIMARY KEY (serial_number, rnalog),
      FOREIGN KEY (serial_number) REFERENCES machine(serial_number) ON DELETE CASCADE
    );

    -- Cumulative fuel-used readings pulled from LiDAT (ISO 15143-3 FuelUsed).
    -- Cumulative since manufacture; period consumption = delta between two readings.
    CREATE TABLE IF NOT EXISTS lidat_fuel_reading (
      serial_number     TEXT NOT NULL,
      reading_time      TEXT NOT NULL,          -- ISO 8601 UTC
      fuel_consumed_cum REAL NOT NULL,          -- cumulative litres
      fuel_units        TEXT,
      fetched_at        TEXT NOT NULL,
      PRIMARY KEY (serial_number, reading_time),
      FOREIGN KEY (serial_number) REFERENCES machine(serial_number) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_lidat_reading_serial_time
      ON lidat_fuel_reading (serial_number, reading_time);

    -- One GPS position per machine per UTC day (ISO 15143-3 Locations), kept as
    -- the latest fix of that day. Backfilled by the sync; accumulates over time
    -- so any past day from the data floor onward can be mapped.
    CREATE TABLE IF NOT EXISTS lidat_location (
      serial_number TEXT NOT NULL,
      day           TEXT NOT NULL,           -- UTC calendar day YYYY-MM-DD
      reading_time  TEXT NOT NULL,           -- exact ISO 8601 UTC time of the fix
      latitude      REAL NOT NULL,
      longitude     REAL NOT NULL,
      fetched_at    TEXT NOT NULL,
      PRIMARY KEY (serial_number, day),
      FOREIGN KEY (serial_number) REFERENCES machine(serial_number) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS setting (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   TEXT NOT NULL,
      finished_at  TEXT,
      status       TEXT NOT NULL,               -- running | success | error
      readings_added INTEGER NOT NULL DEFAULT 0,
      machines_ok    INTEGER NOT NULL DEFAULT 0,
      machines_failed INTEGER NOT NULL DEFAULT 0,
      message      TEXT
    );
  `);

  // Migrate older databases that predate the Location columns on `machine`.
  const machineCols = new Set(
    (db.prepare('PRAGMA table_info(machine)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!machineCols.has('latitude')) db.exec('ALTER TABLE machine ADD COLUMN latitude REAL');
  if (!machineCols.has('longitude')) db.exec('ALTER TABLE machine ADD COLUMN longitude REAL');
  if (!machineCols.has('location_time')) db.exec('ALTER TABLE machine ADD COLUMN location_time TEXT');
}

// ---- Settings helpers ----
export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getJsonSetting<T>(key: string, fallback: T): T {
  const raw = getSetting(key);
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJsonSetting(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
}

// ---- Seed machine mapping from machine-rnalog-mapping.json (repo root) ----
interface MappingFile {
  machines: Array<{
    model: string;
    serialNumber: string;
    rnalogs: string[];
    notes?: string;
  }>;
}

export function seedMachinesFromMapping(): { inserted: number; total: number } {
  const mappingPath = path.resolve(config.serverRoot, '..', 'machine-rnalog-mapping.json');
  if (!fs.existsSync(mappingPath)) {
    return { inserted: 0, total: 0 };
  }
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8')) as MappingFile;

  const upsertMachine = db.prepare(
    `INSERT INTO machine (serial_number, model, notes)
     VALUES (@serialNumber, @model, @notes)
     ON CONFLICT(serial_number) DO UPDATE SET
       model = excluded.model,
       notes = COALESCE(excluded.notes, machine.notes)`,
  );
  const insertRnalog = db.prepare(
    `INSERT OR IGNORE INTO machine_rnalog (serial_number, rnalog) VALUES (?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction((machines: MappingFile['machines']) => {
    for (const m of machines) {
      const res = upsertMachine.run({
        serialNumber: m.serialNumber,
        model: m.model,
        notes: m.notes ?? null,
      });
      if (res.changes > 0) inserted++;
      for (const r of m.rnalogs) insertRnalog.run(m.serialNumber, r);
    }
  });
  tx(mapping.machines);

  return { inserted, total: mapping.machines.length };
}
