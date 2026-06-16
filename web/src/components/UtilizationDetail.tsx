import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import type { MachinePosition, UtilizationSeries } from '../types';
import { fmt, fmtDateTime, shortModel, today } from '../util';
import { DateField } from './DateField';
import { LocationMiniMap } from './LocationMiniMap';

// Earliest date with reliable position history (matches the other maps).
const MAP_DATE_FLOOR = '2026-06-03';

/** Modal: daily Radni sati / Sati u leru / Gorivo over the selected range. */
export function UtilizationDetail({
  serial,
  model,
  from,
  to,
  onClose,
}: {
  serial: string;
  model: string;
  from: string;
  to: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<UtilizationSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Chart range: seeded from the page range but adjustable here independently.
  const [rFrom, setRFrom] = useState(from);
  const [rTo, setRTo] = useState(to);

  // Location map (independent of the chart range): defaults to today, user can
  // step back to see where the machine was on any past day with a recorded fix.
  const [mapDate, setMapDate] = useState(today());
  const [pos, setPos] = useState<MachinePosition | null>(null);
  const [posLoading, setPosLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .utilizationSeries(serial, rFrom, rTo)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [serial, rFrom, rTo]);

  useEffect(() => {
    setPosLoading(true);
    api
      .machinePositions(mapDate)
      .then((list) => setPos(list.find((p) => p.serialNumber === serial) ?? null))
      .catch(() => setPos(null))
      .finally(() => setPosLoading(false));
  }, [serial, mapDate]);

  const chart = useMemo(
    () =>
      (data?.points ?? []).map((p) => ({
        day: p.day,
        operating: p.operatingHours,
        idle: p.idleHours,
        fuel: p.fuelLitres,
      })),
    [data],
  );

  const totals = useMemo(() => {
    const sum = (k: 'operating' | 'idle' | 'fuel') =>
      chart.reduce((s, p) => s + (p[k] ?? 0), 0);
    return { operating: sum('operating'), idle: sum('idle'), fuel: sum('fuel') };
  }, [chart]);

  const dayLabel = (d: string) => {
    const [, m, day] = d.split('-');
    return `${day}.${m}.`;
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>
            {shortModel(model)} <span className="muted">{serial}</span>
          </h2>
          <button className="close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="toolbar">
          <div className="field">
            <label>Od datuma</label>
            <DateField value={rFrom} min={MAP_DATE_FLOOR} max={rTo} onChange={setRFrom} />
          </div>
          <div className="field">
            <label>Do datuma</label>
            <DateField value={rTo} min={rFrom || MAP_DATE_FLOOR} max={today()} onChange={setRTo} />
          </div>
        </div>

        {loading && <div className="spinner">Učitavanje…</div>}
        {error && <div className="error-box">{error}</div>}

        {data && !loading && (
          <>
            <div className="cards">
              <div className="card">
                <div className="label">Radni sati</div>
                <div className="value">{fmt(totals.operating, 1)} h</div>
                <div className="sub">u razdoblju</div>
              </div>
              <div className="card">
                <div className="label">Sati u leru</div>
                <div className="value">{fmt(totals.idle, 1)} h</div>
                <div className="sub">u razdoblju</div>
              </div>
              <div className="card">
                <div className="label">Gorivo</div>
                <div className="value">{fmt(totals.fuel, 1)} L</div>
                <div className="sub">u razdoblju</div>
              </div>
            </div>

            <div className="panel">
              <h2>Po danima: radni sati, ler i gorivo</h2>
              {chart.length > 0 ? (
                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={chart} margin={{ left: 10, right: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2b3742" />
                    <XAxis
                      dataKey="day"
                      tickFormatter={dayLabel}
                      stroke="#8b9bab"
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis
                      yAxisId="h"
                      stroke="#8b9bab"
                      tick={{ fontSize: 11 }}
                      label={{ value: 'sati', angle: -90, position: 'insideLeft', fill: '#8b9bab', fontSize: 11 }}
                    />
                    <YAxis
                      yAxisId="l"
                      orientation="right"
                      stroke="#f5a623"
                      tick={{ fontSize: 11 }}
                      label={{ value: 'L', angle: 90, position: 'insideRight', fill: '#f5a623', fontSize: 11 }}
                    />
                    <Tooltip
                      contentStyle={{ background: '#182027', border: '1px solid #2b3742', color: '#e6edf3' }}
                      labelFormatter={(d) => dayLabel(String(d))}
                      formatter={(v: number, name) =>
                        name === 'Gorivo' ? [`${fmt(v, 1)} L`, name] : [`${fmt(v, 1)} h`, name]
                      }
                    />
                    <Legend />
                    <Bar yAxisId="h" dataKey="operating" name="Radni sati" fill="#4aa3ff" stackId="h" />
                    <Bar yAxisId="h" dataKey="idle" name="Sati u leru" fill="#8b5cf6" stackId="h" />
                    <Line
                      yAxisId="l"
                      type="monotone"
                      dataKey="fuel"
                      name="Gorivo"
                      stroke="#f5a623"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="muted">
                  Nema dnevnih podataka u razdoblju. Sinkronizacija prikuplja podatke s vremenom.
                </div>
              )}
            </div>

            <div className="panel">
              <div className="panel-head">
                <h2>Lokacija stroja</h2>
                <div className="field" style={{ marginLeft: 'auto' }}>
                  <label>Datum</label>
                  <DateField value={mapDate} min={MAP_DATE_FLOOR} max={today()} onChange={setMapDate} />
                </div>
              </div>
              {posLoading ? (
                <div className="spinner">Učitavanje…</div>
              ) : pos ? (
                <>
                  <LocationMiniMap lat={pos.latitude} lng={pos.longitude} />
                  <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                    {pos.latitude.toFixed(5)}, {pos.longitude.toFixed(5)}
                    {' · '}
                    {pos.day === mapDate
                      ? `zabilježeno ${fmtDateTime(pos.readingTime)}`
                      : `zadnji zapis ${fmtDateTime(pos.readingTime)}`}
                  </div>
                </>
              ) : (
                <div className="muted">Nema GPS pozicije za odabrani datum.</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
