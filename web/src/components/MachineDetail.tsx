import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import type { MachinePosition, MachineSeries } from '../types';
import { fmt, fmtDateTime, shortModel, today } from '../util';
import { DateField } from './DateField';
import { LocationMiniMap } from './LocationMiniMap';

// Earliest date with reliable position history (matches the other maps).
const MAP_DATE_FLOOR = '2026-06-03';

export function MachineDetail({
  serial,
  from,
  to,
  onClose,
}: {
  serial: string;
  from: string;
  to: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<MachineSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Map date is independent of the comparison range: defaults to today, user can
  // step back to see where the machine was on any past day with a recorded fix.
  const [mapDate, setMapDate] = useState(today());
  const [pos, setPos] = useState<MachinePosition | null>(null);
  const [posLoading, setPosLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .machineSeries(serial, from, to)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [serial, from, to]);

  useEffect(() => {
    setPosLoading(true);
    api
      .machinePositions(mapDate)
      .then((list) => setPos(list.find((p) => p.serialNumber === serial) ?? null))
      .catch(() => setPos(null))
      .finally(() => setPosLoading(false));
  }, [serial, mapDate]);

  // Both series rebased to cumulative-since-period-start so they share a scale:
  // LiDAT = consumed since the first reading, Maris = running sum of issuances.
  const chartData = useMemo(() => {
    if (!data) return [];
    const lidat = data.lidatReadings;
    const lidatBase = lidat.length ? lidat[0].fuelConsumedCum : 0;
    const lidatByTime = new Map(
      lidat.map((r) => [new Date(r.time).getTime(), r.fuelConsumedCum - lidatBase]),
    );
    const maris = data.marisItems
      .map((m) => ({ t: new Date(m.datum).getTime(), litres: m.kolicina || 0 }))
      .sort((a, b) => a.t - b.t);

    const times = new Set<number>();
    lidatByTime.forEach((_v, t) => times.add(t));
    maris.forEach((m) => times.add(m.t));

    return [...times]
      .sort((a, b) => a - b)
      .map((t) => ({
        t,
        lidat: lidatByTime.has(t) ? lidatByTime.get(t)! : null,
        // Maris carries forward: cumulative issued up to and including t.
        maris: maris.reduce((s, m) => (m.t <= t ? s + m.litres : s), 0),
      }));
  }, [data]);

  const marisTotal = data?.marisItems.reduce((s, i) => s + (i.kolicina || 0), 0) ?? 0;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>
            {data ? `${shortModel(data.machine.model)} ` : ''}
            <span className="muted">{serial}</span>
          </h2>
          <button className="close" onClick={onClose}>
            ×
          </button>
        </div>

        {loading && <div className="spinner">Učitavanje…</div>}
        {error && <div className="error-box">{error}</div>}

        {data && (
          <>
            <div className="cards">
              <div className="card">
                <div className="label">Maris izdano</div>
                <div className="value maris">{fmt(marisTotal, 1)} L</div>
                <div className="sub">{data.marisItems.length} izdatnica</div>
              </div>
              <div className="card">
                <div className="label">LiDAT očitanja</div>
                <div className="value lidat">{data.lidatReadings.length}</div>
                <div className="sub">u razdoblju</div>
              </div>
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

            <div className="panel">
              <h2>Kumulativno: izdano (Maris) vs potrošeno (LiDAT) (L)</h2>
              {chartData.length > 1 ? (
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={chartData} margin={{ left: 10, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2b3742" />
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      scale="time"
                      tickFormatter={(t) => new Date(t).toLocaleDateString('hr-HR')}
                      stroke="#8b9bab"
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis stroke="#8b9bab" tick={{ fontSize: 11 }} domain={[0, 'auto']} />
                    <Tooltip
                      contentStyle={{ background: '#182027', border: '1px solid #2b3742', color: '#e6edf3' }}
                      labelFormatter={(t) => fmtDateTime(new Date(t as number).toISOString())}
                      formatter={(v: number, name) => [`${fmt(v, 1)} L`, name]}
                    />
                    <Legend />
                    <Line
                      type="stepAfter"
                      dataKey="maris"
                      name="Maris (izdano)"
                      stroke="#4aa3ff"
                      dot={false}
                      strokeWidth={2}
                    />
                    <Line
                      type="monotone"
                      dataKey="lidat"
                      name="LiDAT (potrošeno)"
                      stroke="#f5a623"
                      dot={false}
                      strokeWidth={2}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="muted">
                  Nedovoljno podataka u razdoblju za prikaz krivulje. Sinkronizacija prikuplja podatke
                  s vremenom.
                </div>
              )}
            </div>

            <div className="panel">
              <h2>Maris izdatnice goriva</h2>
              <table>
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Dokument</th>
                    <th>Radni nalog</th>
                    <th>Artikl</th>
                    <th className="num">Količina</th>
                  </tr>
                </thead>
                <tbody>
                  {data.marisItems.map((it, i) => (
                    <tr key={i}>
                      <td>{fmtDateTime(it.datum)}</td>
                      <td className="muted">
                        {it.dokNaziv} {it.dokBroj}
                      </td>
                      <td className="muted">{it.rnalog}</td>
                      <td>
                        {it.artNaziv} <span className="muted">({it.artSifra})</span>
                      </td>
                      <td className="num">
                        {fmt(it.kolicina, 1)} {it.jmj}
                      </td>
                    </tr>
                  ))}
                  {data.marisItems.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                        Nema izdatnica goriva u razdoblju.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
