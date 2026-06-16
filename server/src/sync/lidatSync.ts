import { db } from '../db/index.js';
import {
  fetchFleetSnapshot,
  fetchCumulativeFuelUsed,
  fetchCumulativeHours,
  fetchLocationHistory,
  type LidatLocationReading,
} from '../lidat/client.js';

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
       fuel_tank_capacity = COALESCE(@fuelTankCapacity, fuel_tank_capacity),
       latitude = COALESCE(@latitude, latitude),
       longitude = COALESCE(@longitude, longitude),
       location_time = COALESCE(@locationTime, location_time),
       operating_hours = COALESCE(@operatingHours, operating_hours),
       idle_hours = COALESCE(@idleHours, idle_hours),
       hours_time = COALESCE(@hoursTime, hours_time)
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

  const upsertHourReading = db.prepare(
    `INSERT INTO lidat_hours_reading (serial_number, metric, reading_time, hours_cum, fetched_at)
     VALUES (@serial, @metric, @time, @cum, @fetchedAt)
     ON CONFLICT(serial_number, metric, reading_time) DO UPDATE SET
       hours_cum = excluded.hours_cum,
       fetched_at = excluded.fetched_at`,
  );

  // Keep the latest fix per (machine, UTC day); only overwrite with a newer one.
  const upsertLocation = db.prepare(
    `INSERT INTO lidat_location (serial_number, day, reading_time, latitude, longitude, fetched_at)
     VALUES (@serial, @day, @time, @lat, @lng, @fetchedAt)
     ON CONFLICT(serial_number, day) DO UPDATE SET
       reading_time = excluded.reading_time,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       fetched_at = excluded.fetched_at
     WHERE excluded.reading_time > lidat_location.reading_time`,
  );

  // Reduce a location time series to the latest fix per UTC day and upsert them.
  const storeDailyLocations = (serial: string, readings: LidatLocationReading[], fetchedAt: string) => {
    const latestPerDay = new Map<string, LidatLocationReading>();
    for (const r of readings) {
      const day = r.dateTime.slice(0, 10);
      const prev = latestPerDay.get(day);
      if (!prev || r.dateTime > prev.dateTime) latestPerDay.set(day, r);
    }
    const tx = db.transaction(() => {
      for (const [day, r] of latestPerDay) {
        upsertLocation.run({
          serial,
          day,
          time: r.dateTime,
          lat: r.latitude,
          lng: r.longitude,
          fetchedAt,
        });
      }
    });
    tx();
  };

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
          latitude: eq.latitude ?? null,
          longitude: eq.longitude ?? null,
          locationTime: eq.locationTime ?? null,
          operatingHours: eq.operatingHours ?? null,
          idleHours: eq.idleHours ?? null,
          hoursTime: eq.hoursTime ?? null,
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
        // Current cumulative operating hours from the snapshot (extra point on top
        // of the time-series backfill below). Idle has no usable history (no AEMP2
        // time-series), so we only track operating for the utilization view.
        if (eq.hoursTime && eq.operatingHours !== undefined) {
          upsertHourReading.run({
            serial: eq.serialNumber,
            metric: 'operating',
            time: eq.hoursTime,
            cum: eq.operatingHours,
            fetchedAt,
          });
        }
        // Current snapshot position → today's location row (so the map works
        // even before the per-machine history backfill below has run).
        if (eq.latitude !== undefined && eq.longitude !== undefined && eq.locationTime) {
          upsertLocation.run({
            serial: eq.serialNumber,
            day: eq.locationTime.slice(0, 10),
            time: eq.locationTime,
            lat: eq.latitude,
            lng: eq.longitude,
            fetchedAt,
          });
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

      // Operating-hours time series (best-effort, own try/catch). LiDAT only
      // serves a time series for CumulativeOperatingHours — there is NO idle
      // time-series endpoint (it 404s), so idle history is built solely from the
      // per-sync Fleet snapshot counter stored above. The Ler page diffs both.
      try {
        const operating = await fetchCumulativeHours(
          { oemName: m.oem_name!, model: m.model!, serialNumber: m.serial_number },
          'CumulativeOperatingHours',
          startUtc,
          endUtc,
        );
        const tx = db.transaction(() => {
          for (const r of operating) {
            const res = upsertHourReading.run({
              serial: m.serial_number,
              metric: 'operating',
              time: r.dateTime,
              cum: r.hours,
              fetchedAt,
            });
            readingsAdded += res.changes;
          }
        });
        tx();
      } catch (err) {
        errors.push(`${m.serial_number} (hours): ${err instanceof Error ? err.message : String(err)}`);
      }

      // Location history is best-effort: a Locations failure must not fail the
      // machine's fuel sync, so it runs in its own try/catch.
      try {
        const locs = await fetchLocationHistory(
          { oemName: m.oem_name!, model: m.model!, serialNumber: m.serial_number },
          startUtc,
          endUtc,
        );
        storeDailyLocations(m.serial_number, locs, fetchedAt);
      } catch (err) {
        errors.push(`${m.serial_number} (location): ${err instanceof Error ? err.message : String(err)}`);
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
