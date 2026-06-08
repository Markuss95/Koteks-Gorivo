import { db } from '../db/index.js';
import { fetchFleetSnapshot, fetchCumulativeFuelUsed } from '../lidat/client.js';

let syncing = false;

export function isSyncing(): boolean {
  return syncing;
}

interface MachineRow {
  serial_number: string;
  oem_name: string | null;
  model: string | null;
}

/**
 * Pull the LiDAT fleet snapshot + the last 14 days of cumulative fuel for every
 * mapped machine, and upsert readings. Idempotent — safe to run repeatedly.
 */
export async function runLidatSync(): Promise<{
  readingsAdded: number;
  machinesOk: number;
  machinesFailed: number;
  message: string;
}> {
  if (syncing) {
    return { readingsAdded: 0, machinesOk: 0, machinesFailed: 0, message: 'Sync already running' };
  }
  syncing = true;

  const updateIdentity = db.prepare(
    `UPDATE machine SET
       oem_name = COALESCE(@oemName, oem_name),
       make_code = COALESCE(@makeCode, make_code),
       model = COALESCE(NULLIF(@lidatModel, ''), model),
       equipment_id = COALESCE(@equipmentId, equipment_id),
       fuel_tank_capacity = COALESCE(@fuelTankCapacity, fuel_tank_capacity)
     WHERE serial_number = @serialNumber`,
  );

  const upsertReading = db.prepare(
    `INSERT INTO lidat_fuel_reading (serial_number, reading_time, fuel_consumed_cum, fuel_units, fetched_at)
     VALUES (@serial, @time, @cum, @units, @fetchedAt)
     ON CONFLICT(serial_number, reading_time) DO UPDATE SET
       fuel_consumed_cum = excluded.fuel_consumed_cum,
       fuel_units = excluded.fuel_units,
       fetched_at = excluded.fetched_at`,
  );

  const startedAt = new Date().toISOString();
  const logRes = db
    .prepare(`INSERT INTO sync_log (started_at, status) VALUES (?, 'running')`)
    .run(startedAt);
  const logId = Number(logRes.lastInsertRowid);

  let readingsAdded = 0;
  let machinesOk = 0;
  let machinesFailed = 0;
  const errors: string[] = [];

  try {
    // Set of serials we care about (from the mapping).
    const known = db.prepare('SELECT serial_number FROM machine').all() as Array<{
      serial_number: string;
    }>;
    const knownSerials = new Set(known.map((k) => k.serial_number));

    // 1) Fleet snapshot: discover LiDAT identity + a current cumulative reading.
    const fetchedAt = new Date().toISOString();
    const snapshot = await fetchFleetSnapshot();
    const upsertSnapshot = db.transaction(() => {
      for (const eq of snapshot) {
        if (!knownSerials.has(eq.serialNumber)) continue;
        updateIdentity.run({
          serialNumber: eq.serialNumber,
          oemName: eq.oemName || null,
          makeCode: eq.oemName || null,
          lidatModel: eq.model || '',
          equipmentId: eq.equipmentId || null,
          fuelTankCapacity: eq.fuelTankCapacity ?? null,
        });
        if (eq.fuelConsumedCum !== undefined && eq.fuelDateTime) {
          const r = upsertReading.run({
            serial: eq.serialNumber,
            time: eq.fuelDateTime,
            cum: eq.fuelConsumedCum,
            units: eq.fuelUnits ?? null,
            fetchedAt,
          });
          readingsAdded += r.changes;
        }
      }
    });
    upsertSnapshot();

    // 2) Per-machine 14-day backfill of the cumulative fuel time series.
    const machines = db
      .prepare(
        `SELECT serial_number, oem_name, model FROM machine
         WHERE model IS NOT NULL AND model <> '' AND oem_name IS NOT NULL`,
      )
      .all() as MachineRow[];

    const end = new Date();
    // LiDAT requires the start date to be strictly within the last 14 days,
    // so we use a 13-day window for safe margin against the boundary.
    const start = new Date(end.getTime() - 13 * 24 * 60 * 60 * 1000);
    const startUtc = start.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const endUtc = end.toISOString().replace(/\.\d{3}Z$/, 'Z');

    for (const m of machines) {
      try {
        const readings = await fetchCumulativeFuelUsed(
          { oemName: m.oem_name!, model: m.model!, serialNumber: m.serial_number },
          startUtc,
          endUtc,
        );
        const tx = db.transaction(() => {
          for (const r of readings) {
            const res = upsertReading.run({
              serial: m.serial_number,
              time: r.dateTime,
              cum: r.fuelConsumedCum,
              units: r.fuelUnits ?? null,
              fetchedAt,
            });
            readingsAdded += res.changes;
          }
        });
        tx();
        machinesOk++;
      } catch (err) {
        machinesFailed++;
        errors.push(`${m.serial_number}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const message =
      errors.length > 0 ? `Completed with ${errors.length} error(s): ${errors[0]}` : 'OK';
    db.prepare(
      `UPDATE sync_log SET finished_at = ?, status = 'success', readings_added = ?,
        machines_ok = ?, machines_failed = ?, message = ? WHERE id = ?`,
    ).run(new Date().toISOString(), readingsAdded, machinesOk, machinesFailed, message, logId);

    return { readingsAdded, machinesOk, machinesFailed, message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE sync_log SET finished_at = ?, status = 'error', readings_added = ?,
        machines_ok = ?, machines_failed = ?, message = ? WHERE id = ?`,
    ).run(new Date().toISOString(), readingsAdded, machinesOk, machinesFailed, message, logId);
    throw err;
  } finally {
    syncing = false;
  }
}
