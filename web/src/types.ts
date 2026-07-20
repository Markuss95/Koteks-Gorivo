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
  format: string;
  status: string;
  message: string | null;
}

export interface ReportRunResult {
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
