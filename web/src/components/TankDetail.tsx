import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import type { SensorQuality, SlipStatus, TankDetail as TankDetailData, TankDrain } from '../types';
import { fmt, fmtDate, fmtDateTime, shortModel, today } from '../util';
import { DateField } from './DateField';
import { LocationMiniMap } from './LocationMiniMap';

// Same floor as the other detail drawers.
const DATE_FLOOR = '2026-06-04';

const SLIP_STATUS: Record<SlipStatus, { label: string; cls: string }> = {
  ok: { label: 'u redu', cls: 'pos' },
  mismatch: { label: 'razlika', cls: 'neg' },
  no_refuel: { label: 'nema dolijevanja', cls: 'neg' },
  no_data: { label: 'nema podataka o razini', cls: 'muted' },
};

const SENSOR_NOTE: Record<SensorQuality, string | null> = {
  fine: null,
  coarse:
    'Senzor razine na ovom stroju mijenja se u velikim koracima, pa pojedinačni odljevi nisu vidljivi. Manjak se računa između dva punjenja do punog spremnika.',
  unknown:
    'Za ovaj stroj još nema dovoljno podataka o razini da bi se procijenila preciznost senzora, pa se pojedinačni odljevi ne provjeravaju.',
  none: 'Za ovaj stroj nema podataka o razini goriva.',
};

/** Drawer: tank level over time with refuels and drains, and each Maris slip checked. */
export function TankDetail({
  serial,
  model,
  from,
  to,
  isAdmin,
  onClose,
  onCapacityChanged,
}: {
  serial: string;
  model: string;
  from: string;
  to: string;
  isAdmin: boolean;
  onClose: () => void;
  onCapacityChanged: () => void;
}) {
  // Seeded from the page range, adjustable here independently.
  const [rFrom, setRFrom] = useState(from);
  const [rTo, setRTo] = useState(to);
  const [data, setData] = useState<TankDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDrain, setSelectedDrain] = useState<TankDrain | null>(null);
  // Bumped after a capacity correction to reload with the new litres.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .tankDetail(serial, rFrom, rTo)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // Show where the most recent drain happened, if any.
        setSelectedDrain(d.drains.length ? d.drains[d.drains.length - 1] : null);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [serial, rFrom, rTo, reload]);

  const series = useMemo(
    () => (data?.levelSeries ?? []).map((p) => ({ t: Date.parse(p.t), litres: p.litres })),
    [data],
  );
  // Each refuel / drain is drawn over the stretch of line where it happened: from
  // the last reading before it to the first one after, level before → after.
  const refuelMarks = useMemo(
    () =>
      (data?.refuels ?? []).map((r) => ({
        t0: Date.parse(r.prevTime),
        t1: Date.parse(r.time),
        from: r.levelBefore,
        to: r.levelAfter,
        litres: r.litres,
      })),
    [data],
  );
  const drainMarks = useMemo(
    () =>
      (data?.drains ?? []).map((d) => ({
        t0: Date.parse(d.prevTime),
        t1: Date.parse(d.time),
        from: d.levelBefore,
        to: d.levelAfter,
        litres: d.litres,
      })),
    [data],
  );
  // Labels get crowded on long ranges; the tables below list every event anyway.
  const showMarkLabels = refuelMarks.length + drainMarks.length <= 20;

  // Explicit time axis from the level line itself.
  const xDomain = useMemo<[number, number]>(
    () => (series.length ? [series[0].t, series[series.length - 1].t] : [0, 1]),
    [series],
  );
  const xTicks = useMemo(() => dayTicks(xDomain[0], xDomain[1]), [xDomain]);

  const totals = useMemo(() => {
    if (!data) return null;
    return {
      refuelLitres: data.refuels.reduce((s, r) => s + r.litres, 0),
      marisLitres: data.slips.reduce((s, c) => s + c.marisLitres, 0),
      drainLitres: data.drains.reduce((s, d) => s + d.litres, 0),
      cycleRefilled: data.cycles.reduce((s, c) => s + c.refilledLitres, 0),
      cycleMissing: data.cycles.reduce((s, c) => s + c.missingLitres, 0),
    };
  }, [data]);

  const cap = data?.tankCapacity ?? null;

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
            <DateField value={rFrom} min={DATE_FLOOR} max={rTo} onChange={setRFrom} />
          </div>
          <div className="field">
            <label>Do datuma</label>
            <DateField value={rTo} min={rFrom || DATE_FLOOR} max={today()} onChange={setRTo} />
          </div>
        </div>

        {loading && <div className="spinner">Učitavanje…</div>}
        {error && <div className="error-box">{error}</div>}

        {data && totals && !loading && (
          <>
            {data.marisError && (
              <div className="error-box">
                Maris trenutno nije dostupan, pa izdatnice nisu provjerene. ({data.marisError})
              </div>
            )}

            <CapacityLine
              data={data}
              isAdmin={isAdmin}
              onSaved={() => {
                setReload((n) => n + 1);
                onCapacityChanged();
              }}
            />

            {SENSOR_NOTE[data.sensor] && (
              <div className="muted" style={{ marginBottom: 12 }}>
                {SENSOR_NOTE[data.sensor]}
              </div>
            )}

            <div className="cards">
              <div className="card">
                <div className="label">Dolijevanja</div>
                <div className="value">{data.refuels.length}</div>
                <div className="sub">{fmt(totals.refuelLitres, 0)} L uliveno (senzor)</div>
              </div>
              <div className="card">
                <div className="label">Maris izdano</div>
                <div className="value maris">{fmt(totals.marisLitres, 0)} L</div>
                <div className="sub">{data.slips.length} izdatnica</div>
              </div>
              <div className="card">
                <div className="label">Manjak između punjenja</div>
                <div className={`value ${totals.cycleMissing >= 30 ? 'neg' : ''}`}>
                  {data.cycles.length ? `${fmt(totals.cycleMissing, 0)} L` : '—'}
                </div>
                <div className="sub">
                  {data.cycles.length
                    ? `od ${fmt(totals.cycleRefilled, 0)} L uliveno`
                    : 'nema dva punjenja do punog'}
                </div>
              </div>
              {data.sensor === 'fine' && (
                <div className="card">
                  <div className="label">Odljevi</div>
                  <div className={`value ${data.drains.length ? 'neg' : ''}`}>{data.drains.length}</div>
                  <div className="sub">{fmt(totals.drainLitres, 0)} L bez potrošnje motora</div>
                </div>
              )}
            </div>

            <div className="panel">
              <h2>Razina goriva u spremniku (L)</h2>
              {series.length > 1 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={series} margin={{ left: 10, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2b3742" />
                    <XAxis
                      dataKey="t"
                      type="number"
                      scale="time"
                      domain={xDomain}
                      ticks={xTicks}
                      allowDataOverflow
                      tickFormatter={(t) =>
                        new Date(t).toLocaleDateString('hr-HR', { day: '2-digit', month: '2-digit' })
                      }
                      stroke="#8b9bab"
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis
                      stroke="#8b9bab"
                      tick={{ fontSize: 11 }}
                      domain={[0, cap ?? 'auto']}
                      allowDataOverflow
                    />
                    <Tooltip
                      contentStyle={{ background: '#182027', border: '1px solid #2b3742', color: '#e6edf3' }}
                      labelFormatter={(t) => fmtDateTime(new Date(t as number).toISOString())}
                      formatter={(v: number, name) => [`${fmt(v, 0)} L`, name]}
                    />
                    {/* When fuel left unburned: a light band over the time it happened. */}
                    {drainMarks.map((d) => (
                      <ReferenceArea
                        key={`band-${d.t1}`}
                        x1={d.t0}
                        x2={d.t1}
                        fill="#f85149"
                        fillOpacity={0.12}
                        ifOverflow="hidden"
                      />
                    ))}
                    {cap && (
                      <ReferenceLine
                        y={cap}
                        stroke="#8b9bab"
                        strokeDasharray="4 4"
                        label={{ value: 'pun spremnik', fill: '#8b9bab', fontSize: 11, position: 'insideTopRight' }}
                      />
                    )}
                    <Line
                      dataKey="litres"
                      name="Razina u spremniku"
                      type="linear"
                      stroke="#f5a623"
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                    {/* The stretch of line where fuel went in (green) or left unburned (red). */}
                    {refuelMarks.map((r) => (
                      <ReferenceLine
                        key={`refuel-${r.t1}`}
                        segment={[
                          { x: r.t0, y: r.from },
                          { x: r.t1, y: r.to },
                        ]}
                        stroke="#3fb950"
                        strokeWidth={4}
                        ifOverflow="hidden"
                        label={
                          showMarkLabels
                            ? { value: `+${fmt(r.litres, 0)} L`, fill: '#3fb950', fontSize: 11, position: 'left' }
                            : undefined
                        }
                      />
                    ))}
                    {drainMarks.map((d) => (
                      <ReferenceLine
                        key={`drain-${d.t1}`}
                        segment={[
                          { x: d.t0, y: d.from },
                          { x: d.t1, y: d.to },
                        ]}
                        stroke="#f85149"
                        strokeWidth={5}
                        ifOverflow="hidden"
                        label={
                          showMarkLabels
                            ? {
                                value: `−${fmt(d.litres, 0)} L`,
                                fill: '#f85149',
                                fontSize: 12,
                                fontWeight: 700,
                                position: 'right',
                              }
                            : undefined
                        }
                      />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="muted">
                  Nema podataka o razini u razdoblju.
                  {data.firstLevelTime && ` Razina se za ovaj stroj prikuplja od ${fmtDateTime(data.firstLevelTime)}.`}
                </div>
              )}
              {series.length > 1 && (
                <div className="chart-legend">
                  <span>
                    <i style={{ background: '#f5a623', height: 2 }} /> Razina u spremniku
                  </span>
                  <span>
                    <i style={{ background: '#3fb950' }} /> Dolijevanje (+ L uliveno)
                  </span>
                  {data.sensor === 'fine' && (
                    <span>
                      <i style={{ background: '#f85149' }} /> Odljev: gorivo je izašlo iz spremnika, a
                      motor ga nije potrošio (− L)
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="panel">
              <h2>Izdatnice (Maris) i dolijevanja u spremnik</h2>
              <table>
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Izdatnica</th>
                    <th className="num">Maris (L)</th>
                    <th className="num">Spremnik (L)</th>
                    <th className="num">Razlika (L)</th>
                    <th>Dolijevanje</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.slips.map((c) => (
                    <tr key={`${c.date}-${c.sklSifra}-${c.dokBroj}`}>
                      <td>{fmtDate(c.date)}</td>
                      <td className="muted" title={c.sklNaziv}>
                        {c.dokBroj} <span className="muted">({c.sklSifra})</span>
                      </td>
                      <td className="num">{fmt(c.marisLitres, 0)}</td>
                      <td className="num">{c.tankLitres == null ? '—' : `+${fmt(c.tankLitres, 0)}`}</td>
                      <td className={`num ${c.status === 'mismatch' ? 'neg' : ''}`}>
                        {c.differenceLitres == null ? '—' : fmt(c.differenceLitres, 0)}
                      </td>
                      <td className="muted">{c.refuelTime ? fmtDateTime(c.refuelTime) : '—'}</td>
                      <td className={SLIP_STATUS[c.status].cls}>{SLIP_STATUS[c.status].label}</td>
                    </tr>
                  ))}
                  {data.slips.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                        Nema izdatnica goriva u razdoblju.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {data.sensor === 'fine' && (
              <div className="panel">
                <h2>Odljevi iz spremnika</h2>
                <div className="muted" style={{ marginBottom: 12 }}>
                  Razina je naglo pala više nego što je motor potrošio u istom razdoblju. Kliknite redak
                  za lokaciju stroja taj dan.
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Vrijeme</th>
                      <th className="num">Razina prije → poslije (L)</th>
                      <th className="num">Motor potrošio (L)</th>
                      <th className="num">Bez potrošnje (L)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.drains.map((d) => (
                      <tr
                        key={d.time}
                        className={`clickable${selectedDrain?.time === d.time ? ' selected-row' : ''}`}
                        onClick={() => setSelectedDrain(d)}
                      >
                        <td>{fmtDateTime(d.time)}</td>
                        <td className="num">
                          {fmt(d.levelBefore, 0)} → {fmt(d.levelAfter, 0)}
                        </td>
                        <td className="num">{fmt(d.burnedLitres, 0)}</td>
                        <td className="num neg">{fmt(d.litres, 0)}</td>
                      </tr>
                    ))}
                    {data.drains.length === 0 && (
                      <tr>
                        <td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                          Nema odljeva u razdoblju.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                {selectedDrain && selectedDrain.latitude != null && selectedDrain.longitude != null && (
                  <div style={{ marginTop: 12 }}>
                    <LocationMiniMap lat={selectedDrain.latitude} lng={selectedDrain.longitude} />
                    <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                      {selectedDrain.latitude.toFixed(5)}, {selectedDrain.longitude.toFixed(5)} · pozicija
                      stroja zabilježena {fmtDateTime(selectedDrain.locationTime)}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="panel">
              <h2>Između punjenja do punog spremnika</h2>
              <div className="muted" style={{ marginBottom: 12 }}>
                Kad se spremnik dvaput napuni do vrha, drugo punjenje vraća točno ono što je u
                međuvremenu izašlo iz spremnika. Ono što motor nije potrošio izašlo je na drugi način.
                Uliveno se uzima iz Marisa kad se izdatnica slaže sa senzorom, inače sa senzora.
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Od punjenja</th>
                    <th>Do punjenja</th>
                    <th className="num">Uliveno (L)</th>
                    <th className="num">Motor potrošio (L)</th>
                    <th className="num">Nedostaje (L)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cycles.map((c) => (
                    <tr key={c.start}>
                      <td>{fmtDateTime(c.start)}</td>
                      <td>{fmtDateTime(c.end)}</td>
                      <td className="num">
                        {fmt(c.refilledLitres, 0)}{' '}
                        <span className="muted">({c.refillSource === 'maris' ? 'Maris' : 'senzor'})</span>
                      </td>
                      <td className="num">{fmt(c.burnedLitres, 0)}</td>
                      <td className={`num ${c.missingLitres >= 30 ? 'neg' : ''}`}>{fmt(c.missingLitres, 0)}</td>
                    </tr>
                  ))}
                  {data.cycles.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                        U razdoblju nema dva uzastopna punjenja do punog spremnika.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {data.refuelsWithoutSlip.length > 0 && (
              <div className="panel">
                <h2>Dolijevanja bez izdatnice</h2>
                <div className="muted" style={{ marginBottom: 12 }}>
                  Senzor je vidio dolijevanje, ali u Marisu nema izdatnice za taj dan (±1 dan). Maris
                  ponekad kasni s unosom.
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Vrijeme</th>
                      <th className="num">Razina prije → poslije (L)</th>
                      <th className="num">Uliveno (L)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.refuelsWithoutSlip.map((r) => (
                      <tr key={r.time}>
                        <td>{fmtDateTime(r.time)}</td>
                        <td className="num">
                          {fmt(r.levelBefore, 0)} → {fmt(r.levelAfter, 0)}
                        </td>
                        <td className="num">+{fmt(r.litres, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Local midnights inside [from, to], thinned to at most ~8 labels. */
function dayTicks(from: number, to: number): number[] {
  const out: number[] = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  while (d.getTime() <= to) {
    out.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  const step = Math.max(1, Math.ceil(out.length / 8));
  return out.filter((_, i) => i % step === 0);
}

/**
 * Tank size used for the litres, and (admins) a correction for machines whose
 * LiDAT capacity is wrong — every litre read off the sensor scales with it.
 */
function CapacityLine({
  data,
  isAdmin,
  onSaved,
}: {
  data: TankDetailData;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = (litres: number | null) => {
    setSaving(true);
    setError(null);
    api
      .setTankCapacity(data.serialNumber, litres)
      .then(() => {
        setEditing(false);
        onSaved();
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const parsed = Number(value.replace(',', '.'));
  const valid = value.trim() !== '' && Number.isFinite(parsed) && parsed > 0 && parsed <= 5000;

  return (
    <div style={{ marginBottom: 12 }}>
      <span className="muted">Spremnik: </span>
      <strong>{data.tankCapacity == null ? 'nepoznat' : `${fmt(data.tankCapacity, 0)} L`}</strong>{' '}
      <span className="muted">
        {data.capacityCorrected
          ? `(ručno ispravljeno; LiDAT javlja ${data.lidatTankCapacity == null ? '—' : `${fmt(data.lidatTankCapacity, 0)} L`})`
          : '(prema LiDAT-u)'}
      </span>
      {isAdmin && !editing && (
        <>
          {' '}
          <button
            className="btn secondary"
            style={{ padding: '3px 10px', fontSize: 12, marginLeft: 8 }}
            onClick={() => {
              setValue(data.tankCapacity == null ? '' : String(data.tankCapacity));
              setEditing(true);
            }}
          >
            Ispravi
          </button>
          {data.capacityCorrected && (
            <button
              className="btn secondary"
              style={{ padding: '3px 10px', fontSize: 12, marginLeft: 6 }}
              disabled={saving}
              onClick={() => save(null)}
            >
              Vrati LiDAT vrijednost
            </button>
          )}
        </>
      )}
      {isAdmin && editing && (
        <span style={{ marginLeft: 8, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input
            type="number"
            min={1}
            max={5000}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            style={{ width: 90 }}
          />
          <span className="muted">L</span>
          <button
            className="btn"
            style={{ padding: '3px 10px', fontSize: 12 }}
            disabled={!valid || saving}
            onClick={() => save(parsed)}
          >
            Spremi
          </button>
          <button
            className="btn secondary"
            style={{ padding: '3px 10px', fontSize: 12 }}
            onClick={() => setEditing(false)}
          >
            Odustani
          </button>
        </span>
      )}
      {data.capacityHint && data.tankCapacity != null && (
        <div className="hint-box">
          Izdatnice su redom oko <strong>{fmt(data.capacityHint.ratio, 2)}×</strong> veće od porasta
          razine u spremniku (slaže se {data.capacityHint.agreeing} od {data.capacityHint.slips}). To
          obično znači da je kapacitet spremnika krivo zadan: umjesto{' '}
          {fmt(data.tankCapacity, 0)} L vjerojatno je oko{' '}
          <strong>{fmt(data.capacityHint.suggestedLitres, 0)} L</strong>. Provjerite stvarni kapacitet
          stroja — dok nije ispravan, litre sa senzora (dolijevanja, odljevi, manjak) su pogrešne.
          {isAdmin && (
            <button
              className="btn secondary"
              style={{ padding: '3px 10px', fontSize: 12, marginLeft: 8 }}
              disabled={saving}
              onClick={() => save(data.capacityHint!.suggestedLitres)}
            >
              Postavi {fmt(data.capacityHint.suggestedLitres, 0)} L
            </button>
          )}
        </div>
      )}
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
