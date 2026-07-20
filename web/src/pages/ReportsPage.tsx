import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type {
  ComparisonResult,
  Machine,
  MachineComparison,
  MachineGroup,
  MachineUtilization,
  UtilizationResult,
} from '../types';
import { daysSince, effectiveDateFloor, fmt, isStale, today } from '../util';
import { DateField } from '../components/DateField';
import { GroupFilter } from '../components/GroupFilter';
import {
  LOCATION_AFTER_DAYS,
  exportComparisonExcel,
  exportComparisonPdf,
  exportUtilizationExcel,
  exportUtilizationPdf,
  groupExcluded,
  lastKnownPosition,
} from '../export';
import { reverseGeocode, type GeoPoint } from '../geocode';

// Same fallback floor as the comparison page until the backend reports its own.
const MIN_DATE_FALLBACK = '2026-05-27';

// Silence threshold for this report's headline card. Also the cutoff at which
// the report prints a machine's last known location (see LOCATION_AFTER_DAYS).
const STALE_DAYS = LOCATION_AFTER_DAYS;

type ReportType = 'fuel' | 'activity';
type Format = 'pdf' | 'excel';
type Scope = 'matched' | 'all';

// A machine "has both entries" when Maris issued fuel for it AND LiDAT reported
// real consumption — the same pairing the comparison page uses for its matched
// totals, so a machine missing one side can't skew the report.
function hasBothEntries(m: MachineComparison): boolean {
  return m.marisIssuedLitres > 0 && m.lidatConsumedLitres !== null && m.lidatConsumedLitres > 0;
}

export function ReportsPage({ allowedGroups }: { allowedGroups: MachineGroup[] }) {
  const initialGroups: MachineGroup[] = [
    allowedGroups.includes('osijek') ? 'osijek' : allowedGroups[0] ?? 'osijek',
  ];
  const [reportType, setReportType] = useState<ReportType>('fuel');
  const [from, setFrom] = useState(() => effectiveDateFloor(MIN_DATE_FALLBACK, initialGroups));
  const [to, setTo] = useState(today());
  const [minDate, setMinDate] = useState(MIN_DATE_FALLBACK);
  const [groups, setGroups] = useState<Set<MachineGroup>>(() => new Set(initialGroups));
  const [format, setFormat] = useState<Format>('pdf');
  // Default: only machines that have both a Maris and a LiDAT entry.
  const [scope, setScope] = useState<Scope>('matched');

  const [fuelData, setFuelData] = useState<ComparisonResult | null>(null);
  const [activityData, setActivityData] = useState<UtilizationResult | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  // Reverse-geocoding progress; the lookups are rate-limited to 1/s, so a first
  // run over many machines takes a while and needs to say so.
  const [geoProgress, setGeoProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then((s) => setMinDate(s.minDate))
      .catch(() => {});
    // The machine list carries the last known position; it isn't date-dependent,
    // so it's fetched once. A failure only costs the location column.
    api
      .machines()
      .then(setMachines)
      .catch(() => {});
  }, []);

  const effectiveMin = useMemo(() => effectiveDateFloor(minDate, groups), [minDate, groups]);
  useEffect(() => {
    if (from < effectiveMin) setFrom(effectiveMin);
  }, [effectiveMin, from]);

  // Both datasets are always loaded: the activity report needs utilization, and
  // the fuel report now carries the activity columns too. Older responses are
  // ignored so an out-of-order fetch can't overwrite a newer one (same guard as
  // the other pages).
  const reqSeq = useRef(0);
  useEffect(() => {
    setLoading(true);
    setError(null);
    const seq = ++reqSeq.current;
    Promise.all([api.comparison(from, to), api.utilization(from, to)])
      .then(([c, u]) => {
        if (seq !== reqSeq.current) return;
        setFuelData(c);
        setActivityData(u);
      })
      .catch((e) => {
        if (seq === reqSeq.current) setError(e.message);
      })
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false);
      });
  }, [from, to]);

  // ---- Fuel report rows/totals ----
  const fuelGroupRows = useMemo(
    () => (fuelData ? fuelData.machines.filter((m) => groups.has(m.group)) : []),
    [fuelData, groups],
  );
  const fuelMatchedRows = useMemo(() => fuelGroupRows.filter(hasBothEntries), [fuelGroupRows]);
  const fuelRows = scope === 'matched' ? fuelMatchedRows : fuelGroupRows;

  // Machines the matched report leaves out. Only meaningful in 'matched' scope —
  // the "svi strojevi" report already lists everything.
  const fuelExcluded = useMemo(
    () => (scope === 'matched' ? fuelGroupRows.filter((m) => !hasBothEntries(m)) : []),
    [fuelGroupRows, scope],
  );

  // Totals recomputed from exactly the rows going into the report, so the
  // summary block in the PDF/Excel matches its own table.
  const fuelReport: ComparisonResult | null = useMemo(() => {
    if (!fuelData) return null;
    let marisIssuedLitres = 0;
    let lidatConsumedLitres = 0;
    let machinesWithLidatData = 0;
    for (const m of fuelRows) {
      marisIssuedLitres += m.marisIssuedLitres;
      if (m.lidatConsumedLitres !== null) {
        lidatConsumedLitres += m.lidatConsumedLitres;
        machinesWithLidatData += 1;
      }
    }
    return {
      ...fuelData,
      machines: fuelRows,
      totals: {
        marisIssuedLitres,
        lidatConsumedLitres,
        differenceLitres: marisIssuedLitres - lidatConsumedLitres,
        machinesWithLidatData,
        machinesTotal: fuelRows.length,
      },
    };
  }, [fuelData, fuelRows]);

  // Difference as a share of what LiDAT actually reported burnt — the same basis
  // the comparison page and the exported reports use for "Odstupanje".
  const variancePct = useMemo(() => {
    const t = fuelReport?.totals;
    if (!t || t.lidatConsumedLitres <= 0) return null;
    return (t.differenceLitres / t.lidatConsumedLitres) * 100;
  }, [fuelReport]);

  // Utilization keyed by serial, so the fuel report can carry the activity
  // columns for each of its machines.
  const activityBySerial = useMemo(
    () => new Map((activityData?.machines ?? []).map((m) => [m.serialNumber, m])),
    [activityData],
  );

  // Machine records keyed by serial, for the activity report's location column.
  const machineBySerial = useMemo(
    () => new Map(machines.map((m) => [m.serialNumber, m])),
    [machines],
  );

  // ---- Activity report rows ----
  // Every machine in the group is listed, including ones that reported nothing in
  // the period — those are exactly the machines this report is meant to surface.
  // Sorted by last contact, most recent first; never-contacted machines last.
  const activityRows = useMemo<MachineUtilization[]>(() => {
    if (!activityData) return [];
    const r = activityData.machines.filter((m) => groups.has(m.group));
    r.sort((a, b) => {
      if (a.lastReadingTime === b.lastReadingTime) return 0;
      if (a.lastReadingTime === null) return 1;
      if (b.lastReadingTime === null) return -1;
      return b.lastReadingTime.localeCompare(a.lastReadingTime);
    });
    return r;
  }, [activityData, groups]);

  // Headline numbers for the activity preview, matching the report's own columns.
  const activityStats = useMemo(() => {
    const days = activityRows.map((m) => daysSince(m.lastReadingTime));
    const seen = days.filter((d): d is number => d !== null);
    const stale = activityRows.filter((m) => isStale(m.lastReadingTime, STALE_DAYS));
    return {
      never: days.length - seen.length,
      stale: stale.length,
      // How many silent machines will actually print coordinates — the rest have
      // no position on file at all.
      staleLocated: stale.filter((m) => {
        const rec = machineBySerial.get(m.serialNumber);
        return rec?.latitude != null && rec?.longitude != null;
      }).length,
      worst: seen.length ? Math.floor(Math.max(...seen)) : null,
    };
  }, [activityRows, machineBySerial]);

  const isFuel = reportType === 'fuel';
  const rowCount = isFuel ? fuelRows.length : activityRows.length;
  const ready = isFuel ? fuelReport !== null : activityData !== null;

  const generate = async () => {
    if (rowCount === 0) return;
    setGenerating(true);
    setError(null);
    try {
      if (isFuel && fuelReport) {
        const fn = format === 'pdf' ? exportComparisonPdf : exportComparisonExcel;
        await fn(fuelRows, fuelReport, from, to, activityBySerial, fuelExcluded);
      } else if (!isFuel) {
        // Only the machines that actually print a position get looked up, and
        // cached hits cost nothing — so most runs make no network calls at all.
        const points: GeoPoint[] = [];
        for (const m of activityRows) {
          const pos = lastKnownPosition(m, machineBySerial);
          if (pos) points.push({ serialNumber: m.serialNumber, lat: pos.lat, lon: pos.lon });
        }
        const places = await reverseGeocode(points, (done, total) =>
          setGeoProgress(total > 0 && done < total ? { done, total } : null),
        );
        setGeoProgress(null);
        const fn = format === 'pdf' ? exportUtilizationPdf : exportUtilizationExcel;
        await fn(activityRows, from, to, machineBySerial, places);
      }
    } catch (e) {
      setError(`Izrada izvještaja nije uspjela: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGenerating(false);
      setGeoProgress(null);
    }
  };

  return (
    <>
      <div className="toolbar">
        <div className="field">
          <label>Vrsta izvještaja</label>
          <select value={reportType} onChange={(e) => setReportType(e.target.value as ReportType)}>
            <option value="fuel">Gorivo (Maris vs LiDAT)</option>
            <option value="activity">Aktivnost strojeva</option>
          </select>
        </div>
        <div className="field">
          <label>Od datuma</label>
          <DateField value={from} min={effectiveMin} max={to} onChange={setFrom} />
        </div>
        <div className="field">
          <label>Do datuma</label>
          <DateField value={to} min={from || effectiveMin} max={today()} onChange={setTo} />
        </div>
        <div className="field">
          <label>Format</label>
          <select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            <option value="pdf">PDF</option>
            <option value="excel">Excel (.xlsx)</option>
          </select>
        </div>
        {/* The Maris/LiDAT pairing only means something for the fuel report. */}
        {isFuel && (
          <div className="field">
            <label>Obuhvat strojeva</label>
            <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              <option value="matched">Samo s Maris i LiDAT unosom</option>
              <option value="all">Svi strojevi</option>
            </select>
          </div>
        )}
        <div style={{ marginLeft: 'auto' }}>
          <GroupFilter value={groups} onChange={setGroups} options={allowedGroups} single />
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="panel">
        <div className="panel-head">
          <h2>
            {isFuel ? 'Izvještaj o potrošnji goriva' : 'Izvještaj o aktivnosti strojeva'}
          </h2>
          <div className="panel-actions">
            <button
              className="btn"
              onClick={generate}
              disabled={loading || generating || !ready || rowCount === 0}
            >
              {geoProgress
                ? `Dohvaćanje lokacija… (${geoProgress.done}/${geoProgress.total})`
                : generating
                  ? 'Izrada…'
                  : 'Generiraj izvještaj'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="muted" style={{ padding: 12 }}>
            Učitavanje…
          </div>
        ) : (
          <>
            {isFuel ? (
              <div className="cards">
                <div className="card">
                  <div className="label">Strojeva u izvještaju</div>
                  <div className="value">{fuelRows.length}</div>
                  <div className="sub">
                    {scope === 'matched'
                      ? `od ukupno ${fuelGroupRows.length} u razdoblju`
                      : `${fuelMatchedRows.length} s oba unosa`}
                  </div>
                </div>
                <div className="card">
                  <div className="label">Maris — izdano</div>
                  <div className="value maris">
                    {fmt(fuelReport?.totals.marisIssuedLitres ?? 0)} L
                  </div>
                </div>
                <div className="card">
                  <div className="label">LiDAT — potrošeno</div>
                  <div className="value lidat">
                    {fmt(fuelReport?.totals.lidatConsumedLitres ?? 0)} L
                  </div>
                </div>
                <div className="card">
                  <div className="label">Razlika</div>
                  <div className="value">
                    {fmt(fuelReport?.totals.differenceLitres ?? 0)} L
                    {variancePct !== null && (
                      <span className={`pct ${variancePct > 0 ? 'neg' : 'pos'}`}>
                        {variancePct >= 0 ? '+' : ''}
                        {variancePct.toFixed(1)}%
                      </span>
                    )}
                  </div>
                  <div className="sub">izdano − potrošeno · % od LiDAT potrošnje</div>
                </div>
              </div>
            ) : (
              <div className="cards">
                <div className="card">
                  <div className="label">Strojeva u izvještaju</div>
                  <div className="value">{activityRows.length}</div>
                  <div className="sub">sortirano po zadnjem kontaktu</div>
                </div>
                <div className="card">
                  <div className="label">Bez signala &gt; {STALE_DAYS} dana</div>
                  <div className={`value ${activityStats.stale > 0 ? 'neg' : 'pos'}`}>
                    {activityStats.stale}
                  </div>
                  <div className="sub">
                    {activityStats.staleLocated} s poznatom lokacijom u izvještaju
                  </div>
                </div>
                <div className="card">
                  <div className="label">Najdulje bez signala</div>
                  <div className="value">
                    {activityStats.worst === null ? '—' : `${activityStats.worst} dana`}
                  </div>
                  <div className="sub">od strojeva koji su se ikad javili</div>
                </div>
                <div className="card">
                  <div className="label">Nikad se nisu javili</div>
                  <div className="value">{activityStats.never}</div>
                  <div className="sub">nema nijednog LiDAT očitanja</div>
                </div>
              </div>
            )}

            {isFuel && fuelExcluded.length > 0 && (
              <div className="muted" style={{ marginBottom: 12 }}>
                Izvještaj na kraju navodi i {fuelExcluded.length} strojeva bez oba unosa —{' '}
                {groupExcluded(fuelExcluded)
                  .map((g) => g.title)
                  .join(' · ')}
                .
              </div>
            )}

            {rowCount === 0 && (
              <div className="muted" style={{ textAlign: 'center', padding: 30 }}>
                Nema strojeva za odabrano razdoblje i obuhvat.
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
