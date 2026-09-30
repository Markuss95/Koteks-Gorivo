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

// Tank-level collection started on this day; nothing earlier to show.
const EVENTS_FLOOR = '2026-09-16';
// The events list shows this many days at a time, newest first.
const EVENTS_PAGE_DAYS = 3;

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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

type Sort<K> = { key: K; dir: 1 | -1 };

/** Nulls last in either direction; text by locale, numbers numerically. */
function compareBy<T, K>(valueOf: (row: T, key: K) => number | string | null, sort: Sort<K>) {
  return (a: T, b: T) => {
    const av = valueOf(a, sort.key);
    const bv = valueOf(b, sort.key);
    if (av === null) return bv === null ? 0 : 1;
    if (bv === null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv as string) * sort.dir;
    return ((av as number) - (bv as number)) * sort.dir;
  };
}

/** The same column again reverses; a new column starts highest first. */
function nextSort<K>(key: K) {
  return (s: Sort<K> | null): Sort<K> =>
    s && s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 };
}

type EventSortKey = 'date' | 'time' | 'machine' | 'kind' | 'litres';

function eventValue(e: TankEvent, key: EventSortKey): number | string | null {
  switch (key) {
    case 'date':
      return `${e.day} ${e.time ?? ''}`;
    case 'time':
      return e.time ? clock(e.time) : null; // time of day, e.g. night-time drains together
    case 'machine':
      return `${shortModel(e.model)} ${e.serialNumber}`;
    case 'kind':
      return EVENT_ORDER.indexOf(e.kind);
    case 'litres':
      return e.litres;
  }
}

type MachineSortKey =
  | 'model'
  | 'sensor'
  | 'refuelCount'
  | 'slipOkShare'
  | 'slipNoRefuel'
  | 'refuelsWithoutSlip'
  | 'drainLitres'
  | 'cycleMissingLitres';

// Sensor precision: precise beats coarse beats too-little-data beats none, and
// within precise and coarse a smaller level step is the more precise sensor.
const SENSOR_RANK: Record<SensorQuality, number> = { fine: 3, coarse: 2, unknown: 1, none: 0 };
const NO_STEP = 999_999;

function machineValue(m: TankMachineSummary, key: MachineSortKey): number | string | null {
  switch (key) {
    case 'model':
      return `${shortModel(m.model)} ${m.serialNumber}`;
    case 'sensor':
      return SENSOR_RANK[m.sensor] * 1_000_000 - Math.min(m.sensorStepLitres ?? NO_STEP, NO_STEP);
    case 'slipOkShare': {
      const slips = m.slipCount - m.slipNoData;
      return slips > 0 ? m.slipOk / slips : null;
    }
    case 'cycleMissingLitres':
      return m.cycleCount ? m.cycleMissingLitres : null;
    default:
      return m[key];
  }
}

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
  // Table sorts; null keeps each table's default order.
  const [sort, setSort] = useState<Sort<MachineSortKey> | null>(null);
  const [eventSort, setEventSort] = useState<Sort<EventSortKey> | null>(null);

  // Events list: its own from/to window (default the last EVENTS_PAGE_DAYS),
  // independent of the page's date range and paged by its own length.
  const [eventsEnd, setEventsEnd] = useState(() => today());
  const [eventsFrom, setEventsFrom] = useState(() => {
    const start = shiftDay(today(), -(EVENTS_PAGE_DAYS - 1));
    return start < EVENTS_FLOOR ? EVENTS_FLOOR : start;
  });
  const [eventsData, setEventsData] = useState<TankEvent[] | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const eventsSeq = useRef(0);
  const loadEvents = () => {
    setEventsLoading(true);
    setEventsError(null);
    const seq = ++eventsSeq.current;
    api
      .tankOverview(eventsFrom, eventsEnd)
      .then((d) => {
        if (seq === eventsSeq.current) setEventsData(d.events);
      })
      .catch((e) => {
        if (seq === eventsSeq.current) setEventsError(e.message);
      })
      .finally(() => {
        if (seq === eventsSeq.current) setEventsLoading(false);
      });
  };
  useEffect(() => {
    loadEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsFrom, eventsEnd]);
  // Move the whole window by its own length (-1 older, +1 newer), keeping its
  // length but never crossing the collection floor or today.
  const pageEvents = (direction: -1 | 1) => {
    const len =
      Math.round((Date.parse(`${eventsEnd}T00:00:00Z`) - Date.parse(`${eventsFrom}T00:00:00Z`)) / 86_400_000) + 1;
    let from = shiftDay(eventsFrom, direction * len);
    let to = shiftDay(eventsEnd, direction * len);
    if (from < EVENTS_FLOOR) {
      from = EVENTS_FLOOR;
      to = shiftDay(EVENTS_FLOOR, len - 1);
    }
    if (to > today()) {
      to = today();
      from = shiftDay(to, -(len - 1));
      if (from < EVENTS_FLOOR) from = EVENTS_FLOOR;
    }
    setEventsFrom(from);
    setEventsEnd(to);
  };

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
    const rows = data.machines.filter((m) => groups.has(m.group));
    if (!sort) {
      // Until a column is chosen: the biggest losses first.
      return rows.sort(
        (a, b) =>
          loss(b) - loss(a) ||
          b.slipMismatch + b.slipNoRefuel - (a.slipMismatch + a.slipNoRefuel) ||
          b.levelReadings - a.levelReadings,
      );
    }
    return rows.sort(compareBy(machineValue, sort));
  }, [data, groups, sort]);

  const th = (label: string, key: MachineSortKey, num = false) => (
    <Th label={label} num={num} onClick={() => setSort(nextSort(key))} active={sort?.key === key} dir={sort?.dir ?? -1} />
  );
  const eventTh = (label: string, key: EventSortKey, num = false) => (
    <Th
      label={label}
      num={num}
      onClick={() => setEventSort(nextSort(key))}
      active={eventSort?.key === key}
      dir={eventSort?.dir ?? -1}
    />
  );

  const groupEvents = useMemo(
    () => (data ? data.events.filter((e) => groups.has(e.group)) : []),
    [data, groups],
  );
  const events = useMemo(() => {
    const rows = (eventsData ?? []).filter((e) => groups.has(e.group) && kinds.has(e.kind));
    return eventSort ? rows.sort(compareBy(eventValue, eventSort)) : rows;
  }, [eventsData, groups, kinds, eventSort]);

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

  // The card whose kind is the only one shown, if any.
  const focused = kinds.size === 1 ? [...kinds][0] : null;
  const eventsRef = useRef<HTMLDivElement>(null);
  const focusKind = (k: TankEventKind | null) => {
    setKinds(k === null || focused === k ? new Set(EVENT_ORDER) : new Set([k]));
    eventsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

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

      {/* Clicking a card narrows the events list to that kind (again = all kinds). */}
      <div className="cards">
        <div
          className={`card clickable${focused === 'drain' ? ' active' : ''}`}
          onClick={() => focusKind('drain')}
          title="Prikaži samo odljeve u popisu događaja"
        >
          <div className="label">Odljevi iz spremnika</div>
          <div className={`value ${totals.drains ? 'neg' : ''}`}>{totals.drains}</div>
          <div className="sub">{fmt(totals.drainLitres, 0)} L bez potrošnje motora</div>
        </div>
        <div
          className={`card clickable${focused === 'cycle_loss' ? ' active' : ''}`}
          onClick={() => focusKind('cycle_loss')}
          title="Prikaži samo manjak između punjenja u popisu događaja"
        >
          <div className="label">Manjak između punjenja</div>
          <div className={`value ${totals.cycles ? 'neg' : ''}`}>{totals.cycles}</div>
          <div className="sub">{fmt(totals.cycleLitres, 0)} L nije potrošio motor</div>
        </div>
        <div
          className={`card clickable${focused === 'slip_no_refuel' ? ' active' : ''}`}
          onClick={() => focusKind('slip_no_refuel')}
          title="Prikaži samo izdatnice bez dolijevanja u popisu događaja"
        >
          <div className="label">Izdatnice bez dolijevanja</div>
          <div className={`value ${totals.noRefuel ? 'neg' : ''}`}>{totals.noRefuel}</div>
          <div className="sub">senzor nije vidio dolijevanje</div>
        </div>
        <div
          className={`card clickable${focused === 'slip_mismatch' ? ' active' : ''}`}
          onClick={() => focusKind('slip_mismatch')}
          title="Prikaži samo izdatnice koje se ne slažu s dolijevanjem"
        >
          <div className="label">Izdatnica ≠ dolijevanje</div>
          <div className={`value ${totals.mismatch ? 'neg' : ''}`}>{totals.mismatch}</div>
          <div className="sub">izdano i uliveno se razlikuju</div>
        </div>
        <div
          className="card clickable"
          onClick={() => focusKind(null)}
          title="Prikaži sve vrste događaja"
        >
          <div className="label">Provjerene izdatnice</div>
          <div className="value">
            {totals.slipsOk}/{totals.slips}
          </div>
          <div className="sub">u skladu s razinom u spremniku</div>
        </div>
      </div>

      <div className="panel" ref={eventsRef}>
        <div className="panel-head">
          <h2>
            Sumnjivi događaji ({events.length}){' '}
            <span className="muted" style={{ fontWeight: 400 }}>
              {fmtDate(eventsFrom)} – {fmtDate(eventsEnd)}
            </span>
          </h2>
          <div className="panel-actions" style={{ alignItems: 'center' }}>
            <button
              className="btn secondary"
              onClick={() => pageEvents(-1)}
              disabled={eventsLoading || eventsFrom <= EVENTS_FLOOR}
            >
              ← Starije
            </button>
            <span className="muted" style={{ fontSize: 12 }}>Od</span>
            <DateField
              value={eventsFrom}
              min={EVENTS_FLOOR}
              max={eventsEnd}
              onChange={(d) => setEventsFrom(d < EVENTS_FLOOR ? EVENTS_FLOOR : d > eventsEnd ? eventsEnd : d)}
            />
            <span className="muted" style={{ fontSize: 12 }}>Do</span>
            <DateField
              value={eventsEnd}
              min={eventsFrom}
              max={today()}
              onChange={(d) => setEventsEnd(d < eventsFrom ? eventsFrom : d > today() ? today() : d)}
            />
            <button
              className="btn secondary"
              onClick={() => pageEvents(1)}
              disabled={eventsLoading || eventsEnd >= today()}
            >
              Novije →
            </button>
          </div>
        </div>
        <div className="group-filter" style={{ marginBottom: 12 }}>
          {EVENT_ORDER.map((k) => (
            <label key={k} className="group-filter__item">
              <input type="checkbox" checked={kinds.has(k)} onChange={() => toggleKind(k)} />
              <span>{EVENT_LABELS[k]}</span>
            </label>
          ))}
        </div>
        {eventsError && <div className="error-box">{eventsError}</div>}
        {eventsLoading ? (
          <div className="spinner">Učitavanje…</div>
        ) : (
          <table>
            <thead>
              <tr>
                {eventTh('Datum', 'date')}
                {eventTh('Vrijeme', 'time')}
                {eventTh('Stroj', 'machine')}
                {eventTh('Vrsta', 'kind')}
                {eventTh('Opis', 'litres')}
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
                {th('Stroj', 'model')}
                {th('Senzor razine', 'sensor')}
                {th('Dolijevanja', 'refuelCount', true)}
                {th('Izdatnice u redu', 'slipOkShare', true)}
                {th('Bez dolijevanja', 'slipNoRefuel', true)}
                {th('Dolij. bez izdatnice', 'refuelsWithoutSlip', true)}
                {th('Odljevi (L)', 'drainLitres', true)}
                {th('Manjak između punjenja', 'cycleMissingLitres', true)}
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
                    {m.capacitySuspect && (
                      <span
                        className="pill warn"
                        title="Izdatnice su redom višekratnik porasta u spremniku — kapacitet je vjerojatno krivo zadan"
                      >
                        provjeri kapacitet
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
