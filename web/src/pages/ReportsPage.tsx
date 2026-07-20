import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { ComparisonResult, MachineComparison, MachineGroup } from '../types';
import { effectiveDateFloor, fmt, today } from '../util';
import { DateField } from '../components/DateField';
import { GroupFilter } from '../components/GroupFilter';
import { exportComparisonExcel, exportComparisonPdf } from '../export';

// Same fallback floor as the comparison page until the backend reports its own.
const MIN_DATE_FALLBACK = '2026-05-27';

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
  const [from, setFrom] = useState(() => effectiveDateFloor(MIN_DATE_FALLBACK, initialGroups));
  const [to, setTo] = useState(today());
  const [minDate, setMinDate] = useState(MIN_DATE_FALLBACK);
  const [groups, setGroups] = useState<Set<MachineGroup>>(() => new Set(initialGroups));
  const [format, setFormat] = useState<Format>('pdf');
  // Default: only machines that have both a Maris and a LiDAT entry.
  const [scope, setScope] = useState<Scope>('matched');

  const [data, setData] = useState<ComparisonResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then((s) => setMinDate(s.minDate))
      .catch(() => {});
  }, []);

  const effectiveMin = useMemo(() => effectiveDateFloor(minDate, groups), [minDate, groups]);
  useEffect(() => {
    if (from < effectiveMin) setFrom(effectiveMin);
  }, [effectiveMin, from]);

  // Older responses are ignored so an out-of-order fetch can't overwrite a newer
  // one (same guard as the comparison page).
  const reqSeq = useRef(0);
  useEffect(() => {
    setLoading(true);
    setError(null);
    const seq = ++reqSeq.current;
    api
      .comparison(from, to)
      .then((d) => {
        if (seq === reqSeq.current) setData(d);
      })
      .catch((e) => {
        if (seq === reqSeq.current) setError(e.message);
      })
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false);
      });
  }, [from, to]);

  const groupRows = useMemo(
    () => (data ? data.machines.filter((m) => groups.has(m.group)) : []),
    [data, groups],
  );
  const matchedRows = useMemo(() => groupRows.filter(hasBothEntries), [groupRows]);
  const rows = scope === 'matched' ? matchedRows : groupRows;

  // Totals recomputed from exactly the rows going into the report, so the
  // summary block in the PDF/Excel matches its own table.
  const reportData: ComparisonResult | null = useMemo(() => {
    if (!data) return null;
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
    return {
      ...data,
      machines: rows,
      totals: {
        marisIssuedLitres,
        lidatConsumedLitres,
        differenceLitres: marisIssuedLitres - lidatConsumedLitres,
        machinesWithLidatData,
        machinesTotal: rows.length,
      },
    };
  }, [data, rows]);

  const generate = async () => {
    if (!reportData || rows.length === 0) return;
    setGenerating(true);
    setError(null);
    try {
      const fn = format === 'pdf' ? exportComparisonPdf : exportComparisonExcel;
      await fn(rows, reportData, from, to);
    } catch (e) {
      setError(`Izrada izvještaja nije uspjela: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      <div className="toolbar">
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
        <div className="field">
          <label>Obuhvat strojeva</label>
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="matched">Samo s Maris i LiDAT unosom</option>
            <option value="all">Svi strojevi</option>
          </select>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <GroupFilter value={groups} onChange={setGroups} options={allowedGroups} single />
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="panel">
        <div className="panel-head">
          <h2>Izvještaj o potrošnji goriva</h2>
          <div className="panel-actions">
            <button
              className="btn"
              onClick={generate}
              disabled={loading || generating || rows.length === 0}
            >
              {generating ? 'Izrada…' : 'Generiraj izvještaj'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="muted" style={{ padding: 12 }}>
            Učitavanje…
          </div>
        ) : (
          <>
            <div className="cards">
              <div className="card">
                <div className="label">Strojeva u izvještaju</div>
                <div className="value">{rows.length}</div>
                <div className="sub">
                  {scope === 'matched'
                    ? `od ukupno ${groupRows.length} u razdoblju`
                    : `${matchedRows.length} s oba unosa`}
                </div>
              </div>
              <div className="card">
                <div className="label">Maris — izdano</div>
                <div className="value maris">{fmt(reportData?.totals.marisIssuedLitres ?? 0)} L</div>
              </div>
              <div className="card">
                <div className="label">LiDAT — potrošeno</div>
                <div className="value lidat">
                  {fmt(reportData?.totals.lidatConsumedLitres ?? 0)} L
                </div>
              </div>
              <div className="card">
                <div className="label">Razlika</div>
                <div className="value">{fmt(reportData?.totals.differenceLitres ?? 0)} L</div>
                <div className="sub">izdano − potrošeno</div>
              </div>
            </div>

            {rows.length === 0 && (
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
