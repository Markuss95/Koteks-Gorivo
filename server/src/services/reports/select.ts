// Which machines go into a report, and the totals for them.
//
// This logic used to live in the React page, which meant the monthly e-mail and
// the on-screen numbers were two separate implementations of the same rules.
// It lives here now so both come from one place.
import type { MachineComparison, ComparisonResult } from '../comparison.js';
import type { MachineUtilization } from '../utilization.js';
import type { MachineGroup } from '../groups.js';

export type ReportType = 'fuel' | 'activity';
/**
 * How often a subscription is sent. 'monthly' covers the previous calendar
 * month; 'quarterly' covers the previous calendar quarter (Q1 = Jan–Mar, and so
 * on) and only goes out in the month after that quarter ends.
 */
export type ReportCadence = 'monthly' | 'quarterly';
export const CADENCE_LABELS: Record<ReportCadence, string> = {
  monthly: 'mjesečni',
  quarterly: 'kvartalni',
};
/** A single produced file. */
export type ReportFormat = 'pdf' | 'excel';
/** What the user picked — 'both' fans out to one file of each. */
export type FormatChoice = ReportFormat | 'both';

export function expandFormats(choice: FormatChoice): ReportFormat[] {
  return choice === 'both' ? ['pdf', 'excel'] : [choice];
}
/** 'matched' = only machines with both a Maris and a LiDAT entry. */
export type FuelScope = 'matched' | 'all';

/**
 * A machine "has both entries" when Maris issued fuel for it AND LiDAT reported
 * real consumption. A zero LiDAT reading counts as absent, not as a measured
 * zero — same rule the excluded-machines appendix uses, so the two can't disagree.
 */
export function hasBothEntries(m: MachineComparison): boolean {
  return m.marisIssuedLitres > 0 && m.lidatConsumedLitres !== null && m.lidatConsumedLitres > 0;
}

export const hasMaris = (m: MachineComparison) => m.marisIssuedLitres > 0;
export const hasLidat = (m: MachineComparison) =>
  m.lidatConsumedLitres !== null && m.lidatConsumedLitres > 0;

export interface FuelSelection {
  rows: MachineComparison[];
  excluded: MachineComparison[];
  totals: ComparisonResult['totals'];
  /** Difference as a share of LiDAT consumption; null when nothing was burnt. */
  variancePct: number | null;
}

/**
 * Pick the fuel-report rows for the chosen groups and scope, and recompute totals
 * from exactly those rows — so the report's summary always agrees with its own
 * table rather than with the fleet-wide figures.
 */
export function selectFuel(
  all: MachineComparison[],
  groups: MachineGroup[],
  scope: FuelScope,
): FuelSelection {
  const inGroup = all.filter((m) => groups.includes(m.group));
  const rows = scope === 'matched' ? inGroup.filter(hasBothEntries) : inGroup;
  const excluded = scope === 'matched' ? inGroup.filter((m) => !hasBothEntries(m)) : [];

  let marisIssuedLitres = 0;
  let lidatConsumedLitres = 0;
  let machinesWithLidatData = 0;
  for (const m of rows) {
    marisIssuedLitres += m.marisIssuedLitres;
    if (m.lidatConsumedLitres !== null) {
      lidatConsumedLitres += m.lidatConsumedLitres;
      machinesWithLidatData += 1;
    }
  }
  const differenceLitres = marisIssuedLitres - lidatConsumedLitres;

  return {
    rows,
    excluded,
    totals: {
      marisIssuedLitres,
      lidatConsumedLitres,
      differenceLitres,
      machinesWithLidatData,
      machinesTotal: rows.length,
    },
    variancePct: lidatConsumedLitres > 0 ? (differenceLitres / lidatConsumedLitres) * 100 : null,
  };
}

/**
 * Activity-report rows: every machine in the chosen groups, including ones that
 * reported nothing — those are precisely what the report exists to surface.
 * Sorted by last contact, most recent first; never-contacted machines last.
 */
export function selectActivity(
  all: MachineUtilization[],
  groups: MachineGroup[],
): MachineUtilization[] {
  const rows = all.filter((m) => groups.includes(m.group));
  rows.sort((a, b) => {
    if (a.lastReadingTime === b.lastReadingTime) return 0;
    if (a.lastReadingTime === null) return 1;
    if (b.lastReadingTime === null) return -1;
    return b.lastReadingTime.localeCompare(a.lastReadingTime);
  });
  return rows;
}

/**
 * The machines the matched report leaves out, split by *why*. Empty groups are
 * dropped, so a report only shows the categories it actually has.
 */
export function groupExcluded(
  excluded: MachineComparison[],
): Array<{ title: string; note: string; rows: MachineComparison[] }> {
  const marisOnly = excluded.filter((m) => hasMaris(m) && !hasLidat(m));
  const lidatOnly = excluded.filter((m) => !hasMaris(m) && hasLidat(m));
  const neither = excluded.filter((m) => !hasMaris(m) && !hasLidat(m));

  return [
    {
      title: `Samo Maris izdanje — nema LiDAT potrošnje (${marisOnly.length})`,
      note: 'Gorivo je izdano iz skladišta, ali LiDAT nije zabilježio potrošnju — provjeriti javlja li se stroj.',
      rows: marisOnly,
    },
    {
      title: `Samo LiDAT potrošnja — nema Maris izdanja (${lidatOnly.length})`,
      note: 'Stroj je trošio gorivo, ali u razdoblju nema izdatnice — gorivo je vjerojatno izdano izvan razdoblja ili na drugi radni nalog.',
      rows: lidatOnly,
    },
    {
      title: `Bez Maris i LiDAT podataka (${neither.length})`,
      note: 'Nema ni izdatnice ni zabilježene potrošnje u razdoblju.',
      rows: neither,
    },
  ].filter((g) => g.rows.length > 0);
}
