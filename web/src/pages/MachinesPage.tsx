import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { HealthResponse, Machine, MachinePosition } from '../types';
import { fmtDateTime, shortModel, today } from '../util';
import { MachinesMap } from '../components/MachinesMap';

type SortKey = 'model' | 'serialNumber' | 'equipmentId' | 'lidatReadingCount' | 'lastReadingTime';

// Earliest date with reliable position history (matches the comparison floor).
const MAP_DATE_FLOOR = '2026-06-01';

function valueFor(m: Machine, key: SortKey): number | string | null {
  if (key === 'model') return `${shortModel(m.model)} ${m.serialNumber}`;
  return m[key];
}

export function MachinesPage({
  health,
  onSyncDone,
}: {
  health: HealthResponse | null;
  onSyncDone: () => void;
}) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default: most recent reading first.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'lastReadingTime', dir: -1 });
  // Selected machine to focus on the map (null = show all).
  const [selected, setSelected] = useState<string | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  // Map date: default today, positions for that date.
  const [mapDate, setMapDate] = useState(today());
  const [positions, setPositions] = useState<MachinePosition[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(true);

  const loadPositions = (date: string) => {
    setPositionsLoading(true);
    api
      .machinePositions(date)
      .then(setPositions)
      .catch((e) => setError(e.message))
      .finally(() => setPositionsLoading(false));
  };
  useEffect(() => loadPositions(mapDate), [mapDate]);

  // Select a machine from the table and bring the map into view.
  const focusMachine = (serial: string) => {
    setSelected(serial);
    mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const sorted = useMemo(() => {
    const r = [...machines];
    r.sort((a, b) => {
      const av = valueFor(a, sort.key);
      const bv = valueFor(b, sort.key);
      if (av === null) return 1; // nulls always last
      if (bv === null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv as string) * sort.dir;
      return ((av as number) - (bv as number)) * sort.dir;
    });
    return r;
  }, [machines, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));

  const load = () => {
    setLoading(true);
    api
      .machines()
      .then(setMachines)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      await api.triggerSync();
      // Poll until the backend reports it's no longer running.
      const poll = setInterval(async () => {
        const h = await api.health().catch(() => null);
        if (h && !h.sync.running) {
          clearInterval(poll);
          setSyncing(false);
          load();
          loadPositions(mapDate);
          onSyncDone();
        }
      }, 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSyncing(false);
    }
  };

  const last = health?.sync.last;

  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={sync} disabled={syncing || health?.sync.running}>
          {syncing || health?.sync.running ? 'Sinkronizacija…' : 'Sinkroniziraj LiDAT'}
        </button>
        <button className="btn secondary" onClick={load}>
          Osvježi
        </button>
        <div style={{ marginLeft: 'auto' }} className="muted">
          Raspored: <code>{health?.sync.cron ?? '—'}</code>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div ref={mapRef}>
        <MachinesMap
          positions={positions}
          selected={selected}
          onSelect={setSelected}
          date={mapDate}
          onDateChange={(d) => {
            setSelected(null);
            setMapDate(d);
          }}
          minDate={MAP_DATE_FLOOR}
          maxDate={today()}
          loading={positionsLoading}
        />
      </div>

      {last && (
        <div className="panel">
          <h2>Zadnja sinkronizacija</h2>
          <div className="muted" style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <span>Status: <strong className={last.status === 'success' ? 'pos' : last.status === 'error' ? 'neg' : ''}>{last.status}</strong></span>
            <span>Početak: {fmtDateTime(last.started_at)}</span>
            <span>Kraj: {fmtDateTime(last.finished_at)}</span>
            <span>Dodano očitanja: {last.readings_added}</span>
            <span>Strojevi OK/greška: {last.machines_ok}/{last.machines_failed}</span>
          </div>
          {last.message && last.message !== 'OK' && (
            <div className="muted" style={{ marginTop: 8 }}>{last.message}</div>
          )}
        </div>
      )}

      <div className="panel">
        <h2>Strojevi ({machines.length})</h2>
        {loading ? (
          <div className="spinner">Učitavanje…</div>
        ) : (
          <table>
            <thead>
              <tr>
                <Th label="Model" onClick={() => toggleSort('model')} active={sort.key === 'model'} dir={sort.dir} />
                <Th label="Serijski broj" onClick={() => toggleSort('serialNumber')} active={sort.key === 'serialNumber'} dir={sort.dir} />
                <th>LiDAT model</th>
                <Th label="EquipmentID" onClick={() => toggleSort('equipmentId')} active={sort.key === 'equipmentId'} dir={sort.dir} />
                <th>Radni nalozi</th>
                <Th label="Očitanja" num onClick={() => toggleSort('lidatReadingCount')} active={sort.key === 'lidatReadingCount'} dir={sort.dir} />
                <Th label="Zadnje očitanje" onClick={() => toggleSort('lastReadingTime')} active={sort.key === 'lastReadingTime'} dir={sort.dir} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => {
                const located = m.latitude != null && m.longitude != null;
                return (
                <tr
                  key={m.serialNumber}
                  className={`${located ? 'clickable' : ''}${m.serialNumber === selected ? ' selected-row' : ''}`}
                  onClick={located ? () => focusMachine(m.serialNumber) : undefined}
                  title={located ? 'Prikaži na karti' : 'Nema GPS pozicije'}
                >
                  <td><strong>{shortModel(m.model)}</strong></td>
                  <td>{m.serialNumber}</td>
                  <td className="muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.makeCode ?? ''}>
                    {m.oemName ? `${m.oemName} ${m.makeCode ?? ''}` : <span className="pill warn">nije povezan</span>}
                  </td>
                  <td className="muted">{m.equipmentId ?? '—'}</td>
                  <td className="muted">{m.rnalogs.join(', ')}</td>
                  <td className="num">{m.lidatReadingCount}</td>
                  <td className="muted">{fmtDateTime(m.lastReadingTime)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
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
