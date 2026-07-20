// Single entry point for building a report. Both the manual buttons and the
// monthly scheduler call this, so what arrives by e-mail is byte-identical to
// what a user downloads for the same parameters.
import { buildComparison, getFuelArticleCodes } from '../comparison.js';
import { buildUtilization } from '../utilization.js';
import { listMachines } from '../machines.js';
import { GROUP_LABELS, type MachineGroup } from '../groups.js';
import { selectActivity, selectFuel, type FuelScope, type ReportFormat, type ReportType } from './select.js';
import { reverseGeocode, type GeoPoint } from './geocode.js';
import {
  PDF_MIME,
  XLSX_MIME,
  buildActivityExcel,
  buildActivityPdf,
  buildFuelExcel,
  buildFuelPdf,
  fileStem,
  lastKnownPosition,
  type ActivityBySerial,
  type MachineBySerial,
} from './layout.js';

export interface BuildReportOptions {
  type: ReportType;
  format: ReportFormat;
  from: string;
  to: string;
  /** Worksite groups to include — normally the requesting user's allowedGroups. */
  groups: MachineGroup[];
  /** Fuel report only; ignored for the activity report. */
  scope?: FuelScope;
  /**
   * Skip the Nominatim lookups for the activity report. Used by tests and by the
   * fast path where place names aren't worth the wait.
   */
  skipGeocode?: boolean;
}

export interface BuiltReport {
  filename: string;
  contentType: string;
  buffer: Buffer;
  /** Rows actually included — callers use it to avoid mailing an empty report. */
  rowCount: number;
  /** Worksite name when the report covers exactly one; null when it spans several. */
  groupLabel: string | null;
}

/** A report for a single worksite names it; one spanning several does not. */
function soleGroup(groups: MachineGroup[]): MachineGroup | null {
  return groups.length === 1 ? groups[0] : null;
}

/** Human-readable report name, used in e-mail subjects. */
export function reportTitle(type: ReportType): string {
  return type === 'fuel' ? 'Izvještaj o potrošnji goriva' : 'Izvještaj o aktivnosti strojeva';
}

export async function buildReport(opts: BuildReportOptions): Promise<BuiltReport> {
  const { type, format, from, to, groups } = opts;

  if (type === 'fuel') {
    const comparison = await buildComparison(from, to, groups);
    const selection = selectFuel(comparison.machines, groups, opts.scope ?? 'matched');

    // The fuel report carries the activity columns, so it needs utilization too.
    const utilization = buildUtilization(from, to, groups);
    const activity: ActivityBySerial = new Map(
      utilization.machines.map((m) => [m.serialNumber, m]),
    );

    const input = {
      selection,
      fuelArticleCodes: comparison.fuelArticleCodes ?? getFuelArticleCodes(),
      from,
      to,
      activity,
    };
    const buffer = format === 'pdf' ? await buildFuelPdf(input) : buildFuelExcel(input);
    const only = soleGroup(groups);
    return {
      filename: `${fileStem(from, to, 'gorivo', only ?? undefined)}.${format === 'pdf' ? 'pdf' : 'xlsx'}`,
      contentType: format === 'pdf' ? PDF_MIME : XLSX_MIME,
      buffer,
      rowCount: selection.rows.length,
      groupLabel: only ? GROUP_LABELS[only] : null,
    };
  }

  const utilization = buildUtilization(from, to, groups);
  const rows = selectActivity(utilization.machines, groups);
  const machines: MachineBySerial = new Map(
    listMachines(groups).map((m) => [m.serialNumber, m]),
  );

  // Only machines that actually print a position are looked up; cached ones cost
  // nothing, so a normal run makes few or no network calls.
  let places = new Map<string, string>();
  if (!opts.skipGeocode) {
    const points: GeoPoint[] = [];
    for (const m of rows) {
      const pos = lastKnownPosition(m, machines);
      if (pos) points.push({ serialNumber: m.serialNumber, lat: pos.lat, lon: pos.lon });
    }
    places = await reverseGeocode(points);
  }

  const input = { rows, from, to, machines, places };
  const buffer = format === 'pdf' ? await buildActivityPdf(input) : buildActivityExcel(input);
  const only = soleGroup(groups);
  return {
    filename: `${fileStem(from, to, 'aktivnost', only ?? undefined)}.${format === 'pdf' ? 'pdf' : 'xlsx'}`,
    contentType: format === 'pdf' ? PDF_MIME : XLSX_MIME,
    buffer,
    rowCount: rows.length,
    groupLabel: only ? GROUP_LABELS[only] : null,
  };
}
