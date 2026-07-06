import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { MachineGroup, MachineUtilization, UtilizationResult } from '../types';
import { DATA_FLOOR, effectiveDateFloor, fmt, isStale, shortModel, today } from '../util';
import { DateField } from '../components/DateField';
import { GroupFilter } from '../components/GroupFilter';
import { StaleLegend } from '../components/StaleLegend';
import { MachineMapPanel } from '../components/MachineMapPanel';
import { UtilizationDetail } from '../components/UtilizationDetail';

type SortKey =
  | 'model'
  | 'operatingHours'
  | 'hoursPerDay'
  | 'reportingDays'
  | 'idleHours'
  | 'idlePct'
  | 'fuelLitres'
  | 'litresPerHour';

// Fallback floor until the backend reports the authoritative value.
const MIN_DATE_FALLBACK = '2026-05-27';

export function UtilizationPage({ allowedGroups }: { allowedGroups: MachineGroup[] }) {
  const [from, setFrom] = useState(DATA_FLOOR);
  const [to, setTo] = useState(today());
  const [minDate, setMinDate] = useState(MIN_DATE_FALLBACK);
  const [data, setData] = useState<UtilizationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default: most-worked machines first.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'operatingHours', dir: -1 });
  const [selected, setSelected] = useState<string | null>(null);
  // Machine whose daily-trend modal is open (null = closed).
  const [detail, setDetail] = useState<{
    serial: string;
    model: string;
    lastReadingTime: string | null;
  } | null>(null);
  const [groups, setGroups] = useState<Set<MachineGroup>>(
    () => new Set(allowedGroups.includes('osijek') ? ['osijek'] : allowedGroups),
  );
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
        // Default the range start to the earliest selectable (non-grayed) date.
        setFrom(s.minDate > DATA_FLOOR ? s.minDate : DATA_FLOOR);
      })
      .catch(() => {});
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Row click: open the daily-trend modal and highlight the machine on the map.
  const openDetail = (m: MachineUtilization) => {
    setSelected(m.serialNumber);
    setDetail({ serial: m.serialNumber, model: m.model, lastReadingTime: m.lastReadingTime });
  };

  const rows = useMemo<MachineUtilization[]>(() => {
    if (!data) return [];
    const r = data.machines.filter(
      (m) => (m.operatingHours != null || m.fuelLitres != null) && groups.has(m.group),
    );
    r.sort((a, b) => {
      const av = valueFor(a, sort.key);
      const bv = valueFor(b, sort.key);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv as string) * sort.dir;
      return ((av as number) - (bv as number)) * sort.dir;
    });
    return r;
  }, [data, sort, groups]);

  // Card totals recomputed from the visible (group-filtered) rows so they stay
  // in sync with the selected groups.
  const cardTotals = useMemo(() => {
    let operating = 0;
    let fuel = 0;
    const hpd: number[] = [];
    const idlePct: number[] = [];
    for (const m of rows) {
      if (m.operatingHours != null) operating += m.operatingHours;
      if (m.fuelLitres != null) fuel += m.fuelLitres;
      if (m.hoursPerDay != null) hpd.push(m.hoursPerDay);
      if (m.idlePct != null) idlePct.push(m.idlePct);
    }
    const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    return {
      operating,
      avgHoursPerDay: mean(hpd),
      avgIdlePct: mean(idlePct),
      avgLitresPerHour: operating > 0 ? fuel / operating : 0,
    };
  }, [rows]);
  const avgHoursPerDay = cardTotals.avgHoursPerDay;
  const totalOperating = cardTotals.operating;
  const avgIdlePct = cardTotals.avgIdlePct;
  const avgLitresPerHour = cardTotals.avgLitresPerHour;

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));

  // Strictest of the data cutoff and the selected groups' floors (Velički Kamen
  // / Kamen Psunj start later — see util).
  const effectiveMin = useMemo(() => effectiveDateFloor(minDate, groups), [minDate, groups]);

  // Clamp `from` up if a later-starting group pushes the floor past it.
  useEffect(() => {
    if (from < effectiveMin) setFrom(effectiveMin);
  }, [effectiveMin, from]);

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
        <div style={{ marginLeft: 'auto' }}>
          <GroupFilter value={groups} onChange={setGroups} options={allowedGroups} />
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div ref={mapRef}>
        <MachineMapPanel selected={selected} onSelect={setSelected} groups={groups} />
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
          <div className="label">Prosječni udio lera</div>
          <div className="value">{avgIdlePct.toFixed(1)}%</div>
          <div className="sub">motor radi bez posla</div>
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
          stroj koristi po aktivnom danu. Ler = motor radi, ali stroj ne obavlja posao. L/h = gorivo
          po radnom satu. Vrijednosti su za odabrano razdoblje.
        </div>
        <StaleLegend />
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
                <Th label="Sati u leru" num onClick={() => toggleSort('idleHours')} active={sort.key === 'idleHours'} dir={sort.dir} />
                <Th label="Udio lera" num onClick={() => toggleSort('idlePct')} active={sort.key === 'idlePct'} dir={sort.dir} />
                <Th label="Gorivo (L)" num onClick={() => toggleSort('fuelLitres')} active={sort.key === 'fuelLitres'} dir={sort.dir} />
                <Th label="L/h" num onClick={() => toggleSort('litresPerHour')} active={sort.key === 'litresPerHour'} dir={sort.dir} />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr
                  key={m.serialNumber}
                  className={`clickable${m.serialNumber === selected ? ' selected-row' : ''}${isStale(m.lastReadingTime) ? ' stale-row' : ''}`}
                  onClick={() => openDetail(m)}
                  title="Prikaži graf po danima"
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
                  <td className="num">{m.idleHours == null ? '—' : fmt(m.idleHours, 1)}</td>
                  <td className={`num ${m.idlePct != null && m.idlePct >= 50 ? 'neg' : ''}`}>
                    {m.idlePct == null ? '—' : `${m.idlePct.toFixed(1)}%`}
                  </td>
                  <td className="num">{m.fuelLitres == null ? '—' : fmt(m.fuelLitres, 1)}</td>
                  <td className="num">{m.litresPerHour == null ? '—' : fmt(m.litresPerHour, 1)}</td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    Nema podataka o korištenju za odabrano razdoblje.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {detail && (
        <UtilizationDetail
          serial={detail.serial}
          model={detail.model}
          from={from}
          to={to}
          lastReadingTime={detail.lastReadingTime}
          onClose={() => setDetail(null)}
        />
      )}
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
