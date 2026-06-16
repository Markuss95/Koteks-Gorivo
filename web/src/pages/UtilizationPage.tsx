import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { MachineUtilization, UtilizationResult } from '../types';
import { daysAgo, fmt, shortModel, today } from '../util';
import { DateField } from '../components/DateField';
import { MachineMapPanel } from '../components/MachineMapPanel';

type SortKey =
  | 'model'
  | 'operatingHours'
  | 'hoursPerDay'
  | 'reportingDays'
  | 'fuelLitres'
  | 'litresPerHour';

// Fallback floor until the backend reports the authoritative value.
const MIN_DATE_FALLBACK = '2026-05-27';
// Hard floor for the date pickers: data before 1 June 2026 is unreliable.
const DATA_FLOOR = '2026-06-01';

export function UtilizationPage() {
  const [from, setFrom] = useState(daysAgo(10));
  const [to, setTo] = useState(today());
  const [minDate, setMinDate] = useState(MIN_DATE_FALLBACK);
  const [data, setData] = useState<UtilizationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default: most-worked machines first.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'operatingHours', dir: -1 });
  const [selected, setSelected] = useState<string | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  const run = () => {
    setLoading(true);
    setError(null);
    api
      .utilization(from, to)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setMinDate(s.minDate);
        const floor = s.minDate > DATA_FLOOR ? s.minDate : DATA_FLOOR;
        setFrom((f) => (f < floor ? floor : f));
      })
      .catch(() => {});
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusMachine = (serial: string) => {
    setSelected(serial);
    mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const rows = useMemo<MachineUtilization[]>(() => {
    if (!data) return [];
    const r = data.machines.filter((m) => m.operatingHours != null || m.fuelLitres != null);
    r.sort((a, b) => {
      const av = valueFor(a, sort.key);
      const bv = valueFor(b, sort.key);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv as string) * sort.dir;
      return ((av as number) - (bv as number)) * sort.dir;
    });
    return r;
  }, [data, sort]);

  const avgHoursPerDay = data?.totals.avgHoursPerDay ?? 0;
  const totalOperating = data?.totals.operatingHours ?? 0;
  const avgLitresPerHour = data?.totals.avgLitresPerHour ?? 0;

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));

  const effectiveMin = minDate > DATA_FLOOR ? minDate : DATA_FLOOR;

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
          {loading ? 'Učitavanje…' : 'Prikaži'}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div ref={mapRef}>
        <MachineMapPanel selected={selected} onSelect={setSelected} />
      </div>

      <div className="cards">
        <div className="card">
          <div className="label">Prosječno sati/dan</div>
          <div className="value">{avgHoursPerDay.toFixed(1)} h</div>
          <div className="sub">{rows.length} praćenih strojeva</div>
        </div>
        <div className="card">
          <div className="label">Ukupno radnih sati</div>
          <div className="value">{fmt(totalOperating, 0)} h</div>
          <div className="sub">za odabrano razdoblje</div>
        </div>
        <div className="card">
          <div className="label">Prosječno L/h</div>
          <div className="value">{avgLitresPerHour.toFixed(1)} L/h</div>
          <div className="sub">gorivo po radnom satu</div>
        </div>
      </div>

      <div className="panel">
        <h2>Iskorištenost po stroju</h2>
        <div className="muted" style={{ marginBottom: 12 }}>
          Radni sati = motor u radu (ukupno sati uključenog motora). Sati/dan pokazuje koliko se
          stroj koristi po aktivnom danu. L/h = gorivo po radnom satu (veće = neučinkovitije).
          Vrijednosti su za odabrano razdoblje.
        </div>
        {loading ? (
          <div className="spinner">Učitavanje…</div>
        ) : (
          <table>
            <thead>
              <tr>
                <Th label="Stroj" onClick={() => toggleSort('model')} active={sort.key === 'model'} dir={sort.dir} />
                <Th label="Radni sati" num onClick={() => toggleSort('operatingHours')} active={sort.key === 'operatingHours'} dir={sort.dir} />
                <Th label="Sati/dan" num onClick={() => toggleSort('hoursPerDay')} active={sort.key === 'hoursPerDay'} dir={sort.dir} />
                <Th label="Aktivni dani" num onClick={() => toggleSort('reportingDays')} active={sort.key === 'reportingDays'} dir={sort.dir} />
                <Th label="Gorivo (L)" num onClick={() => toggleSort('fuelLitres')} active={sort.key === 'fuelLitres'} dir={sort.dir} />
                <Th label="L/h" num onClick={() => toggleSort('litresPerHour')} active={sort.key === 'litresPerHour'} dir={sort.dir} />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr
                  key={m.serialNumber}
                  className={`clickable${m.serialNumber === selected ? ' selected-row' : ''}`}
                  onClick={() => focusMachine(m.serialNumber)}
                  title="Prikaži na karti"
                >
                  <td>
                    <strong>{shortModel(m.model)}</strong> <span className="muted">{m.serialNumber}</span>
                    {m.partial && (
                      <span className="pill warn" title="Nema očitanja prije početka razdoblja — sati su podcijenjeni">
                        djelomično
                      </span>
                    )}
                  </td>
                  <td className="num">{m.operatingHours == null ? '—' : fmt(m.operatingHours, 1)}</td>
                  <td className="num">{m.hoursPerDay == null ? '—' : fmt(m.hoursPerDay, 1)}</td>
                  <td className="num">{m.reportingDays || '—'}</td>
                  <td className="num">{m.fuelLitres == null ? '—' : fmt(m.fuelLitres, 1)}</td>
                  <td className="num">{m.litresPerHour == null ? '—' : fmt(m.litresPerHour, 1)}</td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    Nema podataka o korištenju za odabrano razdoblje.
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

function valueFor(m: MachineUtilization, key: SortKey): number | string | null {
  if (key === 'model') return `${shortModel(m.model)} ${m.serialNumber}`;
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
