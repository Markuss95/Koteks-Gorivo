import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Machine } from '../types';
import { fmt, fmtDateTime, shortModel } from '../util';
import { MachineMapPanel } from '../components/MachineMapPanel';

type Row = Machine & { idlePct: number | null };
type SortKey = 'model' | 'operatingHours' | 'idleHours' | 'idlePct';

// LiDAT reports working hours and idle hours as DISJOINT counters (idle can
// exceed working), so total engine-on time = working + idle and the idle share
// is idle / (working + idle).
function idleRatio(m: Machine): number | null {
  if (m.operatingHours == null || m.idleHours == null) return null;
  const total = m.operatingHours + m.idleHours;
  return total > 0 ? (m.idleHours / total) * 100 : null;
}

export function LerPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Default: worst idlers first.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'idlePct', dir: -1 });
  // Selected machine to focus on the map (null = show all).
  const [selected, setSelected] = useState<string | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  // Select a machine from the table and bring the map into view.
  const focusMachine = (serial: string) => {
    setSelected(serial);
    mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    setLoading(true);
    api
      .machines()
      .then(setMachines)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const rows = useMemo<Row[]>(() => {
    const r = machines
      .filter((m) => m.operatingHours != null || m.idleHours != null)
      .map((m) => ({ ...m, idlePct: idleRatio(m) }));
    r.sort((a, b) => {
      const av = valueFor(a, sort.key);
      const bv = valueFor(b, sort.key);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv as string) * sort.dir;
      return ((av as number) - (bv as number)) * sort.dir;
    });
    return r;
  }, [machines, sort]);

  const withPct = rows.filter((m) => m.idlePct != null);
  const avgIdle = withPct.length
    ? withPct.reduce((s, m) => s + (m.idlePct ?? 0), 0) / withPct.length
    : 0;
  const totalIdle = rows.reduce((s, m) => s + (m.idleHours ?? 0), 0);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));

  return (
    <>
      {error && <div className="error-box">{error}</div>}

      <div ref={mapRef}>
        <MachineMapPanel selected={selected} onSelect={setSelected} />
      </div>

      <div className="cards">
        <div className="card">
          <div className="label">Prosječni udio lera</div>
          <div className="value">{avgIdle.toFixed(1)}%</div>
          <div className="sub">{rows.length} praćenih strojeva</div>
        </div>
        <div className="card">
          <div className="label">Ukupno sati u leru</div>
          <div className="value">{fmt(totalIdle, 0)} h</div>
          <div className="sub">kumulativno (od proizvodnje)</div>
        </div>
      </div>

      <div className="panel">
        <h2>Ler po stroju</h2>
        <div className="muted" style={{ marginBottom: 12 }}>
          Ler = motor radi, ali stroj ne obavlja posao. Visok udio znači da se gorivo troši bez
          stvarnog rada. Vrijednosti su kumulativne (od proizvodnje stroja).
        </div>
        {loading ? (
          <div className="spinner">Učitavanje…</div>
        ) : (
          <table>
            <thead>
              <tr>
                <Th label="Stroj" onClick={() => toggleSort('model')} active={sort.key === 'model'} dir={sort.dir} />
                <Th label="Radni sati" num onClick={() => toggleSort('operatingHours')} active={sort.key === 'operatingHours'} dir={sort.dir} />
                <Th label="Sati u leru" num onClick={() => toggleSort('idleHours')} active={sort.key === 'idleHours'} dir={sort.dir} />
                <Th label="Udio lera" num onClick={() => toggleSort('idlePct')} active={sort.key === 'idlePct'} dir={sort.dir} />
                <th>Stanje</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const located = m.latitude != null && m.longitude != null;
                return (
                  <tr
                    key={m.serialNumber}
                    className={`${located ? 'clickable' : ''}${m.serialNumber === selected ? ' selected-row' : ''}`}
                    onClick={located ? () => focusMachine(m.serialNumber) : undefined}
                    title={located ? 'Prikaži na karti' : 'Nema GPS pozicije'}
                  >
                    <td>
                      <strong>{shortModel(m.model)}</strong> <span className="muted">{m.serialNumber}</span>
                    </td>
                    <td className="num">{m.operatingHours == null ? '—' : fmt(m.operatingHours, 1)}</td>
                    <td className="num">{m.idleHours == null ? '—' : fmt(m.idleHours, 1)}</td>
                    <td className={`num ${m.idlePct != null && m.idlePct >= 50 ? 'neg' : ''}`}>
                      {m.idlePct == null ? '—' : `${m.idlePct.toFixed(1)}%`}
                    </td>
                    <td className="muted">{fmtDateTime(m.hoursTime)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    Nema podataka o satima rada. Sinkronizacija prikuplja podatke s vremenom.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function valueFor(m: Row, key: SortKey): number | string | null {
  if (key === 'model') return `${shortModel(m.model)} ${m.serialNumber}`;
  if (key === 'idlePct') return m.idlePct;
  return m[key];
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
