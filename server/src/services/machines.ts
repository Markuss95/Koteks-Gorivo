import { db } from '../db/index.js';
import { machineGroup, type MachineGroup } from './groups.js';

export interface Machine {
  serialNumber: string;
  model: string;
  oemName: string | null;
  makeCode: string | null;
  equipmentId: string | null;
  fuelTankCapacity: number | null;
  active: boolean;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
  locationTime: string | null;
  operatingHours: number | null;
  idleHours: number | null;
  hoursTime: string | null;
  rnalogs: string[];
  group: MachineGroup;
  lidatReadingCount: number;
  lastReadingTime: string | null;
}

export function listMachines(allowed?: MachineGroup[]): Machine[] {
  const allowSet = allowed ? new Set(allowed) : null;
  const rows = db
    .prepare(
      `SELECT m.serial_number, m.model, m.oem_name, m.make_code, m.equipment_id,
              m.fuel_tank_capacity, m.active, m.notes,
              m.latitude, m.longitude, m.location_time,
              m.operating_hours, m.idle_hours, m.hours_time,
              (SELECT COUNT(*) FROM lidat_fuel_reading r WHERE r.serial_number = m.serial_number) AS reading_count,
              (SELECT MAX(reading_time) FROM lidat_fuel_reading r WHERE r.serial_number = m.serial_number) AS last_reading
       FROM machine m
       ORDER BY m.model, m.serial_number`,
    )
    .all() as any[];

  const rnalogStmt = db.prepare(
    'SELECT rnalog FROM machine_rnalog WHERE serial_number = ? ORDER BY rnalog',
  );

  const out = rows.map((r) => {
    const rnalogs = (rnalogStmt.all(r.serial_number) as Array<{ rnalog: string }>).map(
      (x) => x.rnalog,
    );
    return {
      serialNumber: r.serial_number,
      model: r.model,
      oemName: r.oem_name,
      makeCode: r.make_code,
      equipmentId: r.equipment_id,
      fuelTankCapacity: r.fuel_tank_capacity,
      active: !!r.active,
      notes: r.notes,
      latitude: r.latitude,
      longitude: r.longitude,
      locationTime: r.location_time,
      operatingHours: r.operating_hours,
      idleHours: r.idle_hours,
      hoursTime: r.hours_time,
      rnalogs,
      group: machineGroup(rnalogs),
      lidatReadingCount: r.reading_count,
      lastReadingTime: r.last_reading,
    };
  });
  return allowSet ? out.filter((m) => allowSet.has(m.group)) : out;
}

/** Map of serial → group, for callers that don't load full machine rows. */
export function machineGroupsMap(): Map<string, MachineGroup> {
  const rows = db
    .prepare(
      `SELECT serial_number, GROUP_CONCAT(rnalog) rnalogs FROM machine_rnalog GROUP BY serial_number`,
    )
    .all() as Array<{ serial_number: string; rnalogs: string | null }>;
  const map = new Map<string, MachineGroup>();
  for (const r of rows) {
    map.set(r.serial_number, machineGroup((r.rnalogs ?? '').split(',')));
  }
  return map;
}

export interface MachinePosition {
  serialNumber: string;
  model: string;
  equipmentId: string | null;
  group: MachineGroup;
  latitude: number;
  longitude: number;
  readingTime: string; // exact UTC time of the plotted fix
  day: string; // UTC day the fix belongs to (may be earlier than the requested date)
}

/**
 * Each machine's position as of `date` (YYYY-MM-DD): the latest stored daily fix
 * on or before that date. Machines with no fix up to that date are omitted.
 */
export function listMachinePositions(date: string, allowed?: MachineGroup[]): MachinePosition[] {
  const allowSet = allowed ? new Set(allowed) : null;
  const rows = db
    .prepare(
      `SELECT m.serial_number, m.model, m.equipment_id,
              loc.latitude, loc.longitude, loc.reading_time, loc.day
       FROM machine m
       JOIN lidat_location loc ON loc.serial_number = m.serial_number
       WHERE loc.day = (
         SELECT MAX(l2.day) FROM lidat_location l2
         WHERE l2.serial_number = m.serial_number AND l2.day <= ?
       )
       ORDER BY m.model, m.serial_number`,
    )
    .all(date) as any[];

  const groups = machineGroupsMap();
  const out = rows.map((r) => ({
    serialNumber: r.serial_number,
    model: r.model,
    equipmentId: r.equipment_id,
    group: groups.get(r.serial_number) ?? ('osijek' as MachineGroup),
    latitude: r.latitude,
    longitude: r.longitude,
    readingTime: r.reading_time,
    day: r.day,
  }));
  return allowSet ? out.filter((p) => allowSet.has(p.group)) : out;
}
