import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type {
  MachineGroup,
  SensorQuality,
  TankEvent,
  TankEventKind,
  TankMachineSummary,
  TankOverview,
} from '../types';
import { effectiveDateFloor, fmt, fmtDate, fmtDateTime, shortModel, today } from '../util';
import { useDateRange } from '../DateRangeContext';
import { DateField } from '../components/DateField';
import { GroupFilter } from '../components/GroupFilter';
import { TankDetail } from '../components/TankDetail';

// Fallback floor until the backend reports the authoritative value.
const MIN_DATE_FALLBACK = '2026-05-27';

export const EVENT_LABELS: Record<TankEventKind, string> = {
  drain: 'Odljev iz spremnika',
  cycle_loss: 'Manjak između punjenja',
  slip_mismatch: 'Izdatnica ≠ dolijevanje',
  slip_no_refuel: 'Izdatnica bez dolijevanja',
  refuel_no_slip: 'Dolijevanje bez izdatnice',
};

const EVENT_ORDER: TankEventKind[] = [
  'drain',
  'cycle_loss',
  'slip_mismatch',
  'slip_no_refuel',
  'refuel_no_slip',
];

export const SENSOR_LABELS: Record<SensorQuality, string> = {
  fine: 'precizan',
  coarse: 'grub',
  unknown: 'premalo podataka',
  none: 'nema podataka',
};

/** Time of day in Croatia, e.g. '11:50'. */
function clock(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' });
}

function eventDetail(e: TankEvent): string {
  switch (e.kind) {
    case 'drain':
      return `${fmt(e.litres, 0)} L napustilo spremnik bez potrošnje motora`;
    case 'cycle_loss': {
      const gross = (e.tankLitres ?? 0) - (e.burnedLitres ?? 0);
      const extra =
        Math.abs(gross - e.litres) > 1 ? ` (${fmt(e.litres, 0)} L izvan već prikazanih odljeva)` : '';
      return `Od ${fmtDateTime(e.since)}: uliveno ${fmt(e.tankLitres, 0)} L, motor potrošio ${fmt(e.burnedLitres, 0)} L — nedostaje ${fmt(gross, 0)} L${extra}`;
    }
    case 'slip_mismatch':
      return `Maris ${fmt(e.marisLitres, 0)} L · spremnik +${fmt(e.tankLitres, 0)} L (izdatnica ${e.dokBroj})`;
    case 'slip_no_refuel':
      return `Maris ${fmt(e.marisLitres, 0)} L (izdatnica ${e.dokBroj}) · senzor nije vidio dolijevanje`;
    case 'refuel_no_slip':
      return `Spremnik +${fmt(e.tankLitres, 0)} L · nema izdatnice u Marisu`;
  }
}

export function TankPage({
  allowedGroups,
  isAdmin,
}: {
  allowedGroups: MachineGroup[];
  isAdmin: boolean;
}) {
  const { from, to, setFrom, setTo } = useDateRange();
  const [minDate, setMinDate] = useState(MIN_DATE_FALLBACK);
  const [data, setData] = useState<TankOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Exactly one group is shown at a time: Osijek if available, else the user's first.
  const [groups, setGroups] = useState<Set<MachineGroup>>(
    () => new Set<MachineGroup>([allowedGroups.includes('osijek') ? 'osijek' : allowedGroups[0] ?? 'osijek']),
  );
  const [kinds, setKinds] = useState<Set<TankEventKind>>(() => new Set(EVENT_ORDER));
  const [detail, setDetail] = useState<{ serial: string; model: string } | null>(null);

  // Latest request wins; an older, slower response can't overwrite a newer one.
  const reqSeq = useRef(0);
  const run = () => {
    setLoading(true);
    setError(null);
    const seq = ++reqSeq.current;
    api
      .tankOverview(from, to)
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
    api
      .settings()
      .then((s) => setMinDate(s.minDate))
      .catch(() => {});
  }, []);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  const effectiveMin = useMemo(() => effectiveDateFloor(minDate, groups), [minDate, groups]);
  useEffect(() => {
    if (from < effectiveMin) setFrom(effectiveMin);
  }, [effectiveMin, from]);

  const machines = useMemo<TankMachineSummary[]>(() => {
    if (!data) return [];
    const loss = (m: TankMachineSummary) => Math.max(m.drainLitres, m.cycleMissingLitres);
    return data.machines
      .filter((m) => groups.has(m.group))
      .sort(
        (a, b) =>
          loss(b) - loss(a) ||
          b.slipMismatch + b.slipNoRefuel - (a.slipMismatch + a.slipNoRefuel) ||
          b.levelReadings - a.levelReadings,
      );
  }, [data, groups]);

  const groupEvents = useMemo(
    () => (data ? data.events.filter((e) => groups.has(e.group)) : []),
    [data, groups],
  );
  const events = useMemo(() => groupEvents.filter((e) => kinds.has(e.kind)), [groupEvents, kinds]);

  const totals = useMemo(() => {
    const of = (k: TankEventKind) => groupEvents.filter((e) => e.kind === k);
    const litres = (list: TankEvent[]) => list.reduce((s, e) => s + e.litres, 0);
    return {
      drains: of('drain').length,
      drainLitres: litres(of('drain')),
      cycles: of('cycle_loss').length,
      cycleLitres: litres(of('cycle_loss')),
      mismatch: of('slip_mismatch').length,
      noRefuel: of('slip_no_refuel').length,
      slips: machines.reduce((s, m) => s + m.slipCount - m.slipNoData, 0),
      slipsOk: machines.reduce((s, m) => s + m.slipOk, 0),
    };
  }, [groupEvents, machines]);

  const toggleKind = (k: TankEventKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const noHistoryYet = data && (!data.levelHistoryFrom || data.levelHistoryFrom.slice(0, 10) > to);

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
          <GroupFilter value={groups} onChange={setGroups} options={allowedGroups} single />
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}
      {data?.marisError && (
        <div className="error-box">
          Maris trenutno nije dostupan, pa izdatnice nisu provjerene. Odljevi iz spremnika su
          prikazani. ({data.marisError})
        </div>
      )}

      <div className="panel">
        <div className="muted">
          Razina goriva u spremniku (LiDAT senzor) uspoređuje se s izdatnicama iz Marisa i s
          potrošnjom motora. <strong>Odljev</strong>: razina je naglo pala barem 15 L više nego što je
          motor potrošio. <strong>Manjak između punjenja</strong>: između dva punjenja do punog
          spremnika uliveno je više goriva nego što je motor potrošio (za senzore koji ne mogu
          pokazati pojedinačni odljev). <strong>Izdatnica bez dolijevanja</strong>: senzor taj dan nije
          vidio da je gorivo uliveno. Maris ponekad kasni s unosom, pa se nedavna dolijevanja mogu
          privremeno prikazati bez izdatnice.
          {data?.levelHistoryFrom && (
            <>
              {' '}
              Razina goriva prikuplja se od <strong>{fmtDateTime(data.levelHistoryFrom)}</strong>{' '}
              (LiDAT čuva samo 14 dana), pa za ranije datume nema podataka.
            </>
          )}
        </div>
      </div>

      {noHistoryYet && (
        <div className="error-box">
          Za odabrano razdoblje još nema podataka o razini goriva. Prikupljanje je počelo{' '}
          {data?.levelHistoryFrom ? fmtDateTime(data.levelHistoryFrom) : 'tek nakon sljedeće sinkronizacije'}.
        </div>
      )}

      <div className="cards">
        <div className="card">
          <div className="label">Odljevi iz spremnika</div>
          <div className={`value ${totals.drains ? 'neg' : ''}`}>{totals.drains}</div>
          <div className="sub">{fmt(totals.drainLitres, 0)} L bez potrošnje motora</div>
        </div>
        <div className="card">
          <div className="label">Manjak između punjenja</div>
          <div className={`value ${totals.cycles ? 'neg' : ''}`}>{totals.cycles}</div>
          <div className="sub">{fmt(totals.cycleLitres, 0)} L nije potrošio motor</div>
        </div>
        <div className="card">
          <div className="label">Izdatnice bez dolijevanja</div>
          <div className={`value ${totals.noRefuel ? 'neg' : ''}`}>{totals.noRefuel}</div>
          <div className="sub">senzor nije vidio dolijevanje</div>
        </div>
        <div className="card">
          <div className="label">Izdatnica ≠ dolijevanje</div>
          <div className={`value ${totals.mismatch ? 'neg' : ''}`}>{totals.mismatch}</div>
          <div className="sub">izdano i uliveno se razlikuju</div>
        </div>
        <div className="card">
          <div className="label">Provjerene izdatnice</div>
          <div className="value">
            {totals.slipsOk}/{totals.slips}
          </div>
          <div className="sub">u skladu s razinom u spremniku</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Sumnjivi događaji ({events.length})</h2>
          <div className="group-filter" style={{ marginLeft: 'auto' }}>
            {EVENT_ORDER.map((k) => (
              <label key={k} className="group-filter__item">
                <input type="checkbox" checked={kinds.has(k)} onChange={() => toggleKind(k)} />
                <span>{EVENT_LABELS[k]}</span>
              </label>
            ))}
          </div>
        </div>
        {loading ? (
          <div className="spinner">Učitavanje…</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Datum</th>
                <th>Vrijeme</th>
                <th>Stroj</th>
                <th>Vrsta</th>
                <th>Opis</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr
                  key={`${e.serialNumber}-${e.kind}-${e.day}-${e.time ?? e.dokBroj}-${i}`}
                  className="clickable"
                  onClick={() => setDetail({ serial: e.serialNumber, model: e.model })}
                  title="Prikaži razinu goriva u spremniku"
                >
                  <td>{fmtDate(e.day)}</td>
                  <td className="muted">{clock(e.time)}</td>
                  <td>
                    <strong>{shortModel(e.model)}</strong> <span className="muted">{e.serialNumber}</span>
                  </td>
                  <td className={e.kind === 'refuel_no_slip' ? '' : 'neg'}>{EVENT_LABELS[e.kind]}</td>
                  <td className="muted">{eventDetail(e)}</td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    Nema sumnjivih događaja u odabranom razdoblju.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Pregled po strojevima</h2>
        <div className="muted" style={{ marginBottom: 12 }}>
          Precizan senzor mjeri razinu u koracima od nekoliko litara, pa pokazuje i pojedinačne
          odljeve. Grub senzor mijenja se u velikim skokovima, pa se za njega manjak računa samo
          između dva punjenja do punog spremnika. Manjak između punjenja = uliveno − potrošeno u
          motoru (uključuje i već prikazane odljeve).
        </div>
        {loading ? (
          <div className="spinner">Učitavanje…</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Stroj</th>
                <th>Senzor razine</th>
                <th className="num">Dolijevanja</th>
                <th className="num">Izdatnice u redu</th>
                <th className="num">Bez dolijevanja</th>
                <th className="num">Dolij. bez izdatnice</th>
                <th className="num">Odljevi (L)</th>
                <th className="num">Manjak između punjenja</th>
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => (
                <tr
                  key={m.serialNumber}
                  className={`clickable${m.sensor === 'none' ? ' stale-row' : ''}`}
                  onClick={() => setDetail({ serial: m.serialNumber, model: m.model })}
                  title="Prikaži razinu goriva u spremniku"
                >
                  <td>
                    <strong>{shortModel(m.model)}</strong> <span className="muted">{m.serialNumber}</span>
                    {m.capacityCorrected && (
                      <span className="pill warn" title="Kapacitet spremnika ručno ispravljen">
                        ispravljen spremnik
                      </span>
                    )}
                  </td>
                  <td className="muted">
                    {SENSOR_LABELS[m.sensor]}
                    {(m.sensor === 'fine' || m.sensor === 'coarse') &&
                      m.sensorStepLitres != null &&
                      ` (~${fmt(m.sensorStepLitres, 0)} L)`}
                  </td>
                  <td className="num">{m.refuelCount || '—'}</td>
                  <td className="num">
                    {m.slipCount - m.slipNoData > 0 ? `${m.slipOk}/${m.slipCount - m.slipNoData}` : '—'}
                  </td>
                  <td className={`num ${m.slipNoRefuel ? 'neg' : ''}`}>{m.slipNoRefuel || '—'}</td>
                  <td className="num">{m.refuelsWithoutSlip || '—'}</td>
                  <td className={`num ${m.drainCount ? 'neg' : ''}`}>
                    {m.drainCount ? `${m.drainCount} × · ${fmt(m.drainLitres, 0)}` : '—'}
                  </td>
                  <td className={`num ${m.cycleMissingLitres >= 30 ? 'neg' : ''}`}>
                    {m.cycleCount
                      ? `${fmt(m.cycleMissingLitres, 0)} L od ${fmt(m.cycleRefilledLitres, 0)} L`
                      : '—'}
                  </td>
                </tr>
              ))}
              {machines.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    Nema strojeva u odabranoj grupi.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {detail && (
        <TankDetail
          serial={detail.serial}
          model={detail.model}
          from={from}
          to={to}
          isAdmin={isAdmin}
          onClose={() => setDetail(null)}
          onCapacityChanged={run}
        />
      )}
    </>
  );
}
