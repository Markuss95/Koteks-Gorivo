import { db } from '../db/index.js';

export interface Machine {
  serialNumber: string;
  model: string;
  oemName: string | null;
  makeCode: string | null;
  equipmentId: string | null;
  fuelTankCapacity: number | null;
  active: boolean;
  notes: string | null;
  rnalogs: string[];
  lidatReadingCount: number;
  lastReadingTime: string | null;
}

export function listMachines(): Machine[] {
  const rows = db
    .prepare(
      `SELECT m.serial_number, m.model, m.oem_name, m.make_code, m.equipment_id,
              m.fuel_tank_capacity, m.active, m.notes,
              (SELECT COUNT(*) FROM lidat_fuel_reading r WHERE r.serial_number = m.serial_number) AS reading_count,
              (SELECT MAX(reading_time) FROM lidat_fuel_reading r WHERE r.serial_number = m.serial_number) AS last_reading
       FROM machine m
       ORDER BY m.model, m.serial_number`,
    )
    .all() as any[];

  const rnalogStmt = db.prepare(
    'SELECT rnalog FROM machine_rnalog WHERE serial_number = ? ORDER BY rnalog',
  );

  return rows.map((r) => ({
    serialNumber: r.serial_number,
    model: r.model,
    oemName: r.oem_name,
    makeCode: r.make_code,
    equipmentId: r.equipment_id,
    fuelTankCapacity: r.fuel_tank_capacity,
    active: !!r.active,
    notes: r.notes,
    rnalogs: (rnalogStmt.all(r.serial_number) as Array<{ rnalog: string }>).map((x) => x.rnalog),
    lidatReadingCount: r.reading_count,
    lastReadingTime: r.last_reading,
  }));
}
