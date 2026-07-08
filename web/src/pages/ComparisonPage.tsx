import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import type { ComparisonResult, MachineComparison, MachineGroup } from '../types';
import { effectiveDateFloor, fmt, isStale, shortModel, today } from '../util';
import { MachineDetail } from '../components/MachineDetail';
import { DateField } from '../components/DateField';
import { GroupFilter } from '../components/GroupFilter';
import { StaleLegend } from '../components/StaleLegend';
import { exportComparisonExcel, exportComparisonPdf } from '../export';

type SortKey =
  | 'model'
  | 'marisIssuedLitres'
  | 'lidatConsumedLitres'
  | 'differenceLitres'
  | 'variancePct';

// Fallback floor until the backend reports the authoritative value.
const MIN_DATE_FALLBACK = '2026-05-27';

export function ComparisonPage({ allowedGroups }: { allowedGroups: MachineGroup[] }) {
  // Groups shown by default: Osijek if available, otherwise whatever the user has.
  const initialGroups: MachineGroup[] = allowedGroups.includes('osijek')
    ? ['osijek']
    : allowedGroups;
  // Start `from` at the group-aware floor so the very first fetch already uses the
  // correct range (a Velički/Psunj-only user must start at 26 Jun, not 4 Jun).
  const [from, setFrom] = useState(() => effectiveDateFloor(MIN_DATE_FALLBACK, initialGroups));
  const [to, setTo] = useState(today());
  const [minDate, setMinDate] = useState(MIN_DATE_FALLBACK);
  const [data, setData] = useState<ComparisonResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default: smallest LiDAT↔Maris discrepancy first (closest agreement).
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: 'differenceLitres',
    dir: 1,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [groups, setGroups] = useState<Set<MachineGroup>>(() => new Set(initialGroups));

  // Monotonic id of the latest in-flight request; older responses are ignored so
  // an out-of-order fetch can never overwrite a newer one (fixes the login race).
  const reqSeq = useRef(0);
  const run = () => {
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
  };

  useEffect(() => {
    // Pull the authoritative data floor from the backend. `from` is not set here:
    // it already starts at the group-aware floor, and the clamp effect below
    // raises it if the backend reports a later minDate. Setting it here would
    // reset a Velički/Psunj-only user back to the global floor and trigger a
    // second, racing fetch.
    api
      .settings()
      .then((s) => setMinDate(s.minDate))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-run the comparison whenever the date range changes — including when
  // selecting a later-starting group clamps `from` up. Also covers the initial
  // load. The "Usporedi" button stays for an explicit manual re-fetch.
  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  const rows = useMemo(() => {
    if (!data) return [];
    const r = data.machines.filter((m) => groups.has(m.group));
    r.sort((a, b) => {
      const av = valueFor(a, sort.key);
      const bv = valueFor(b, sort.key);
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv as string) * sort.dir;
      return ((av as number) - (bv as number)) * sort.dir;
    });
    return r;
  }, [data, sort, groups]);

  const chartData = useMemo(
    () =>
      rows
        .filter((m) => m.marisIssuedLitres > 0 || (m.lidatConsumedLitres ?? 0) > 0)
        .slice(0, 25)
        .map((m) => ({
          name: `${shortModel(m.model)} ${m.serialNumber}`,
          serial: m.serialNumber,
          Maris: m.marisIssuedLitres,
          LiDAT: m.lidatConsumedLitres ?? 0,
        })),
    [rows],
  );

  // Totals recomputed from the visible (group-filtered) rows so the cards and
  // chart stay in sync with the selected groups.
  const totals = useMemo(() => {
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
      marisIssuedLitres,
      lidatConsumedLitres,
      differenceLitres: marisIssuedLitres - lidatConsumedLitres,
      machinesWithLidatData,
      machinesTotal: rows.length,
    };
  }, [rows]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));

  // Effective picker floor: the strictest of the data cutoff and the selected
  // groups' floors (Velički Kamen / Kamen Psunj start later — see util).
  const effectiveMin = useMemo(() => effectiveDateFloor(minDate, groups), [minDate, groups]);

  // If selecting a later-starting group pushes the floor past the current start,
  // clamp `from` up so the picker never holds a now-greyed-out date.
  useEffect(() => {
    if (from < effectiveMin) setFrom(effectiveMin);
  }, [effectiveMin, from]);

  const [exporting, setExporting] = useState<null | 'pdf' | 'excel'>(null);
  const runExport = async (kind: 'pdf' | 'excel') => {
    if (!data) return;
    setExporting(kind);
    setError(null);
    try {
      const fn = kind === 'pdf' ? exportComparisonPdf : exportComparisonExcel;
      await fn(rows, data, from, to);
    } catch (e) {
      setError(`Izvoz nije uspio: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(null);
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
        <button className="btn" onClick={run} disabled={loading}>
          {loading ? 'Učitavanje…' : 'Usporedi'}
        </button>
        <div style={{ marginLeft: 'auto' }}>
          <GroupFilter value={groups} onChange={setGroups} options={allowedGroups} />
        </div>
        <div className="muted">
          {data && `Eurodizel (artikl): ${data.fuelArticleCodes.join(', ')}`}
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {data && (
        <div className="cards">
          <div className="card">
            <div className="label">Maris — izdano</div>
            <div className="value maris">{fmt(totals.marisIssuedLitres)} L</div>
            <div className="sub">iz skladišta (izdatnice)</div>
          </div>
          <div className="card">
            <div className="label">LiDAT — potrošeno</div>
            <div className="value lidat">{fmt(totals.lidatConsumedLitres)} L</div>
            <div className="sub">
              stvarna potrošnja · {totals.machinesWithLidatData}/{totals.machinesTotal} strojeva
            </div>
          </div>
          <div className="card">
            <div className="label">Razlika</div>
            <div
              className={`value ${totals.differenceLitres > 0 ? 'neg' : 'pos'}`}
              style={{ color: undefined }}
            >
              {fmt(totals.differenceLitres)} L
            </div>
            <div className="sub">izdano − potrošeno</div>
          </div>
          <div className="card">
            <div className="label">Odstupanje</div>
            <div className="value">
              {totals.lidatConsumedLitres > 0
                ? `${((totals.differenceLitres / totals.lidatConsumedLitres) * 100).toFixed(1)}%`
                : '—'}
            </div>
            <div className="sub">razlika / potrošeno</div>
          </div>
        </div>
      )}

      {chartData.length > 0 && (
        <div className="panel">
          <h2>Izdano (Maris) vs potrošeno (LiDAT) — po stroju, L</h2>
          <ResponsiveContainer width="100%" height={Math.max(280, chartData.length * 26)}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ left: 40, right: 20 }}
              style={{ cursor: 'pointer' }}
              onClick={(state) => {
                const serial = state?.activePayload?.[0]?.payload?.serial;
                if (serial) setSelected(serial);
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#2b3742" horizontal={false} />
              <XAxis type="number" stroke="#8b9bab" />
              <YAxis type="category" dataKey="name" width={150} stroke="#8b9bab" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#182027', border: '1px solid #2b3742', color: '#e6edf3' }}
                formatter={(v: number) => `${fmt(v)} L`}
              />
              <Legend />
              <Bar dataKey="Maris" fill="#4aa3ff" />
              <Bar dataKey="LiDAT" fill="#f5a623" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>Detalji po stroju</h2>
          <div className="panel-actions">
            <button
              className="btn secondary"
              onClick={() => runExport('excel')}
              disabled={!data || rows.length === 0 || exporting !== null}
            >
              {exporting === 'excel' ? 'Izvoz…' : 'Izvoz Excel'}
            </button>
            <button
              className="btn secondary"
              onClick={() => runExport('pdf')}
              disabled={!data || rows.length === 0 || exporting !== null}
            >
              {exporting === 'pdf' ? 'Izvoz…' : 'Izvoz PDF'}
            </button>
          </div>
        </div>
        <StaleLegend />
        <table>
          <thead>
            <tr>
              <Th label="Stroj" onClick={() => toggleSort('model')} active={sort.key === 'model'} dir={sort.dir} />
              <th>Radni nalog</th>
              <Th label="Maris izdano (L)" num onClick={() => toggleSort('marisIssuedLitres')} active={sort.key === 'marisIssuedLitres'} dir={sort.dir} />
              <Th label="LiDAT potroš. (L)" num onClick={() => toggleSort('lidatConsumedLitres')} active={sort.key === 'lidatConsumedLitres'} dir={sort.dir} />
              <Th label="Razlika (L)" num onClick={() => toggleSort('differenceLitres')} active={sort.key === 'differenceLitres'} dir={sort.dir} />
              <Th label="Odstup." num onClick={() => toggleSort('variancePct')} active={sort.key === 'variancePct'} dir={sort.dir} />
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr
                key={m.serialNumber}
                className={`clickable${isStale(m.lastReadingTime) ? ' stale-row' : ''}`}
                onClick={() => setSelected(m.serialNumber)}
              >
                <td>
                  <strong>{shortModel(m.model)}</strong> <span className="muted">{m.serialNumber}</span>
                  {m.lidatPartial && (
                    <span className="pill warn" title="Nema očitanja prije početka razdoblja — potrošnja je podcijenjena">
                      djelomično
                    </span>
                  )}
                </td>
                <td className="muted">{m.rnalogs.join(', ') || '—'}</td>
                <td className="num">{fmt(m.marisIssuedLitres, 1)}</td>
                <td className="num">{m.lidatConsumedLitres === null ? '—' : fmt(m.lidatConsumedLitres, 1)}</td>
                <td className={`num ${(m.differenceLitres ?? 0) > 0 ? 'neg' : 'pos'}`}>
                  {m.differenceLitres === null ? '—' : `${m.differenceLitres >= 0 ? '+' : ''}${fmt(m.differenceLitres, 1)}`}
                </td>
                <td className={`num ${(m.variancePct ?? 0) > 0 ? 'neg' : 'pos'}`}>
                  {m.variancePct === null ? '—' : `${m.variancePct >= 0 ? '+' : ''}${m.variancePct.toFixed(1)}%`}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                  Nema podataka za odabrano razdoblje.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <MachineDetail
          serial={selected}
          from={from}
          to={to}
          lastReadingTime={rows.find((m) => m.serialNumber === selected)?.lastReadingTime ?? null}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

function valueFor(m: MachineComparison, key: SortKey): number | string | null {
  switch (key) {
    case 'model':
      return `${shortModel(m.model)} ${m.serialNumber}`;
    case 'differenceLitres':
      // Sort by the SIZE of the discrepancy, regardless of direction. Rows with
      // no usable comparison — exact-zero difference, or no variance (Odstupanje
      // "—", i.e. no LiDAT consumption) — are treated as null so they sink to the
      // bottom.
      return m.differenceLitres === null || m.differenceLitres === 0 || m.variancePct === null
        ? null
        : Math.abs(m.differenceLitres);
    default:
      return m[key];
  }
}

function Th({
  label,
  onClick,
  active,
  dir,
  num,
}: {
  label: string;
  onClick: () => void;
  active: boolean;
  dir: 1 | -1;
  num?: boolean;
}) {
  return (
    <th className={num ? 'num' : ''} onClick={onClick}>
      {label} {active ? (dir === 1 ? '▲' : '▼') : ''}
    </th>
  );
}
