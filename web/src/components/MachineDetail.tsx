import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import type { MachineSeries } from '../types';
import { fmt, fmtDateTime, shortModel } from '../util';

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

  useEffect(() => {
    setLoading(true);
    api
      .machineSeries(serial, from, to)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [serial, from, to]);

  const chartData =
    data?.lidatReadings.map((r) => ({
      t: new Date(r.time).getTime(),
      label: fmtDateTime(r.time),
      cum: r.fuelConsumedCum,
    })) ?? [];

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
              <h2>LiDAT — kumulativno gorivo (L)</h2>
              {chartData.length > 1 ? (
                <ResponsiveContainer width="100%" height={240}>
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
                    <YAxis stroke="#8b9bab" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                    <Tooltip
                      contentStyle={{ background: '#182027', border: '1px solid #2b3742', color: '#e6edf3' }}
                      labelFormatter={(t) => fmtDateTime(new Date(t as number).toISOString())}
                      formatter={(v: number) => [`${fmt(v, 1)} L`, 'Kumulativno']}
                    />
                    <Line type="monotone" dataKey="cum" stroke="#f5a623" dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="muted">
                  Nedovoljno LiDAT očitanja u razdoblju za prikaz krivulje. Sinkronizacija prikuplja
                  podatke s vremenom.
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
