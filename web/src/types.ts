export type MachineGroup = 'osijek' | 'velicki' | 'psunj';

// Display order + Croatian labels for the worksite groups.
export const GROUP_ORDER: MachineGroup[] = ['osijek', 'velicki', 'psunj'];
export const GROUP_LABELS: Record<MachineGroup, string> = {
  osijek: 'Osijek Koteks',
  velicki: 'Velički Kamen',
  psunj: 'Kamen Psunj',
};

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

export type Role = 'user' | 'admin';

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
  allowedGroups: MachineGroup[];
}

export interface ManagedUser {
  id: number;
  username: string;
  role: Role;
  allowedGroups: MachineGroup[];
  createdAt: string;
  updatedAt: string | null;
}

export interface MachinePosition {
  serialNumber: string;
  model: string;
  equipmentId: string | null;
  group: MachineGroup;
  latitude: number;
  longitude: number;
  readingTime: string;
  day: string;
}

export interface MachineComparison {
  serialNumber: string;
  model: string;
  equipmentId: string | null;
  group: MachineGroup;
  lastReadingTime: string | null;
  rnalogs: string[];
  marisIssuedLitres: number;
  marisIssueCount: number;
  marisValue: number;
  lidatConsumedLitres: number | null;
  lidatBaselineTime: string | null;
  lidatEndTime: string | null;
  lidatReadingsInRange: number;
  lidatPartial: boolean;
  differenceLitres: number | null;
  variancePct: number | null;
}

export interface ComparisonResult {
  from: string;
  to: string;
  fuelArticleCodes: string[];
  generatedAt: string;
  machines: MachineComparison[];
  totals: {
    marisIssuedLitres: number;
    lidatConsumedLitres: number;
    differenceLitres: number;
    machinesWithLidatData: number;
    machinesTotal: number;
  };
}

export interface MachineUtilization {
  serialNumber: string;
  model: string;
  equipmentId: string | null;
  group: MachineGroup;
  lastReadingTime: string | null;
  operatingHours: number | null;
  reportingDays: number;
  hoursPerDay: number | null;
  idleHours: number | null;
  idlePct: number | null;
  fuelLitres: number | null;
  litresPerHour: number | null;
  partial: boolean;
}

export interface UtilizationResult {
  from: string;
  to: string;
  generatedAt: string;
  machines: MachineUtilization[];
  totals: {
    operatingHours: number;
    idleHours: number;
    fuelLitres: number;
    avgHoursPerDay: number;
    avgIdlePct: number;
    avgLitresPerHour: number;
    machinesWithData: number;
    machinesTotal: number;
  };
}

export interface UtilizationSeriesPoint {
  day: string;
  operatingHours: number | null;
  idleHours: number | null;
  fuelLitres: number | null;
}

export interface UtilizationSeries {
  serial: string;
  from: string;
  to: string;
  points: UtilizationSeriesPoint[];
}

// ---- Tank control (tank-level sensor vs Maris slips and engine consumption) ----

/**
 * 'coarse' sensors move in big steps: refuels and fill-to-fill balance only, no
 * drain detection. 'unknown' = too little movement to judge, treated like coarse.
 */
export type SensorQuality = 'fine' | 'coarse' | 'unknown' | 'none';

/** From one fill to a full tank to the next. */
export interface TankCycle {
  start: string;
  end: string;
  refilledLitres: number;
  refillSource: 'maris' | 'sensor';
  burnedLitres: number; // the most the engine can have burned in between
  levelChangeLitres: number; // level after the closing fill − after the opening one
  missingLitres: number; // refilled − level change − burned
  drainLitres: number;
}

export interface TankRefuel {
  time: string;
  prevTime: string;
  litres: number;
  levelBefore: number;
  levelAfter: number;
}

export interface TankDrain {
  time: string;
  prevTime: string;
  litres: number; // left unburned and stayed missing
  burnedLitres: number; // the most the engine can have burned
  returnedLitres: number; // part of the drop the reading got back soon after (or had gained just before)
  levelBefore: number;
  levelAfter: number;
  // The machine's stored GPS fix for that day, if any.
  latitude: number | null;
  longitude: number | null;
  locationTime: string | null;
}

// 'too_small': no rise found, but the slip is too small for this sensor to show.
export type SlipStatus = 'ok' | 'mismatch' | 'no_refuel' | 'too_small' | 'no_data';

export interface TankSlipCheck {
  date: string;
  dokBroj: number;
  sklSifra: string;
  sklNaziv: string;
  rnalog: string;
  marisLitres: number;
  tankLitres: number | null;
  refuelTime: string | null;
  differenceLitres: number | null;
  status: SlipStatus;
  // Checked together with these other slips (one fill booked on several), and
  // against this many fills (two for one slip covering a fill in two goes).
  sharedWith: number[];
  fills: number;
}

export interface TankMachineSummary {
  serialNumber: string;
  model: string;
  equipmentId: string | null;
  group: MachineGroup;
  tankCapacity: number | null;
  capacityCorrected: boolean;
  sensor: SensorQuality;
  sensorStepLitres: number | null;
  levelReadings: number;
  refuelCount: number;
  refuelLitres: number;
  slipCount: number;
  slipOk: number;
  slipMismatch: number;
  slipNoRefuel: number;
  slipUnchecked: number; // no level data around it, or too small for the sensor
  refuelsWithoutSlip: number;
  refuelsAwaitingSlip: number;
  drainCount: number;
  drainLitres: number;
  cycleCount: number;
  cycleRefilledLitres: number;
  cycleMissingLitres: number;
  capacitySuspect: boolean;
}

/** Slips consistently a multiple of the tank rise: the capacity is likely wrong. */
export interface CapacityHint {
  ratio: number;
  agreeing: number;
  slips: number;
  suggestedLitres: number;
}

export type TankEventKind =
  | 'drain'
  | 'cycle_loss'
  | 'slip_mismatch'
  | 'slip_no_refuel'
  | 'refuel_no_slip'
  | 'refuel_awaiting_slip';

export interface TankEvent {
  kind: TankEventKind;
  serialNumber: string;
  model: string;
  group: MachineGroup;
  day: string;
  time: string | null;
  // drain: unburned litres; cycle_loss: missing beyond flagged drains;
  // slip events: Maris litres; refuel_no_slip: tank litres
  litres: number;
  tankLitres: number | null;
  marisLitres: number | null;
  burnedLitres: number | null;
  levelChangeLitres: number | null; // cycle_loss: level after the closing fill − after the opening one
  returnedLitres: number | null; // drain: part of the drop the reading got back
  since: string | null;
  dokBroj: number | null;
}

export interface TankOverview {
  from: string;
  to: string;
  generatedAt: string;
  levelHistoryFrom: string | null;
  marisError: string | null;
  // A refuel without an izdatnica is only a finding after this many days.
  marisGraceDays: number;
  machines: TankMachineSummary[];
  events: TankEvent[];
}

export interface TankDetail {
  serialNumber: string;
  model: string;
  equipmentId: string | null;
  group: MachineGroup;
  tankCapacity: number | null;
  lidatTankCapacity: number | null;
  capacityCorrected: boolean;
  sensor: SensorQuality;
  sensorStepLitres: number | null;
  levelReadings: number;
  firstLevelTime: string | null;
  refuels: TankRefuel[];
  drains: TankDrain[];
  cycles: TankCycle[];
  slips: TankSlipCheck[];
  refuelsWithoutSlip: TankRefuel[];
  refuelsAwaitingSlip: TankRefuel[];
  capacityHint: CapacityHint | null;
  from: string;
  to: string;
  marisError: string | null;
  levelSeries: Array<{ t: string; litres: number }>;
  // Newest LiDAT reading of any kind for this machine, whatever the range.
  lastLidatTime: string | null;
  // The machine's last stored GPS fix up to the end of the range.
  location: { latitude: number | null; longitude: number | null; locationTime: string | null };
  marisGraceDays: number;
}

export interface HealthResponse {
  maris: { ok: boolean; message: string };
  lidat: { ok: boolean; message: string };
  db: { readingCount: number; machineCount: number };
  sync: {
    running: boolean;
    cron: string;
    last: SyncLog | null;
  };
}

export interface SyncLog {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  readings_added: number;
  machines_ok: number;
  machines_failed: number;
  message: string | null;
}

export interface MachineSeries {
  machine: {
    serialNumber: string;
    model: string;
    equipmentId: string | null;
    rnalogs: string[];
    latitude: number | null;
    longitude: number | null;
    locationTime: string | null;
  };
  // Period consumption computed on the server exactly like the comparison table.
  lidat: { consumedLitres: number | null; baselineCum: number | null; partial: boolean };
  lidatReadings: Array<{ time: string; fuelConsumedCum: number; fuelUnits: string | null }>;
  marisItems: Array<{
    datum: string;
    rnalog: string;
    sklSifra: string;
    sklNaziv: string;
    dokNaziv: string;
    dokBroj: number;
    artSifra: string;
    artNaziv: string;
    kolicina: number;
    jmj: string;
    vrijednost: number;
  }>;
}

export type ReportType = 'fuel' | 'activity';
/** How often a subscription is sent: the previous month, or the previous quarter. */
export type ReportCadence = 'monthly' | 'quarterly';
/** A single produced file. */
export type ReportFormat = 'pdf' | 'excel';
/** What the user picked — 'both' produces one file of each. */
export type FormatChoice = ReportFormat | 'both';
export type FuelScope = 'matched' | 'all';

/** Parameters the server needs to build a report — no file content crosses the wire. */
export interface ReportRequest {
  type: ReportType;
  format: ReportFormat;
  from: string;
  to: string;
  scope?: FuelScope;
  groups?: MachineGroup[];
}

export interface ReportSubscription {
  id: number;
  userId: number;
  username: string;
  reportType: ReportType;
  cadence: ReportCadence;
  format: FormatChoice;
  active: boolean;
  createdAt: string;
}

export interface ReportLogEntry {
  id: number;
  ran_at: string;
  period_from: string;
  period_to: string;
  recipient: string;
  report_type: string;
  cadence: string;
  format: string;
  status: string;
  message: string | null;
}

export interface ReportRunResult {
  ran: boolean;
  cadence: ReportCadence;
  reason?: string;
  from?: string;
  to?: string;
  /** 'Q1 2026' on a quarterly run; absent for monthly. */
  periodLabel?: string;
  sent: number;
  failed: number;
  skipped: number;
  details: Array<{
    recipient: string;
    type: string;
    format: string;
    // Worksite the entry refers to; one mail is sent per group.
    group: string;
    status: string;
    message?: string;
  }>;
}

export interface Settings {
  fuelArticleCodes: string[];
  syncCron: string;
  minDate: string;
  // Default recipient for e-mailed reports, and whether the server can send at
  // all. Optional so an older backend still typechecks.
  mailTo?: string;
  mailConfigured?: boolean;
  // Domains reports may be sent to. Empty/absent = no restriction.
  mailAllowedDomains?: string[];
}
