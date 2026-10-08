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
import type {
  CheckStatus,
  Confidence,
  EventReason,
  ReviewVerdict,
  TankCalibration,
  TankDetail,
  TankEvent,
  TankReadings,
  TankReview,
} from '../types';
import { fmt, fmtDate, fmtDateTime } from '../util';
import { EVENT_LABELS, eventDetail } from '../tankText';
import { LocationMiniMap } from './LocationMiniMap';

const HOUR_MS = 3_600_000;

const CONFIDENCE: Record<Confidence, { label: string; cls: string }> = {
  sure: { label: 'siguran', cls: 'ok' },
  check: { label: 'provjeriti', cls: 'warn' },
};

// A confirmed finding is a real loss or misbooking, so it stands out.
const VERDICT: Record<ReviewVerdict, { label: string; cls: string }> = {
  confirmed: { label: '✓ potvrđeno', cls: 'bad' },
  false_alarm: { label: '✗ lažna uzbuna', cls: '' },
};

const CHECK: Record<CheckStatus, { mark: string; cls: string; text: string }> = {
  ok: { mark: '✓', cls: 'pos', text: 'slaže se' },
  off: { mark: '✗', cls: 'neg', text: 'ne slaže se' },
  unknown: { mark: '?', cls: 'muted', text: 'premalo podataka' },
};

const ratioText = (r: number | null) => (r === null ? '' : fmt(r, 2));

function reasonsTitle(reasons: EventReason[]): string {
  return reasons.map((r) => `${r.ok ? '✓' : '!'} ${r.text}`).join('\n');
}

/** "siguran" / "provjeriti", with the reasons on hover. */
export function ConfidenceBadge({ event }: { event: TankEvent }) {
  if (!event.confidence) return <span className="muted">—</span>;
  const c = CONFIDENCE[event.confidence];
  return (
    <span className={`pill ${c.cls}`} title={reasonsTitle(event.reasons)}>
      {c.label}
    </span>
  );
}

/** What was found on site, if anyone has checked it. */
export function ReviewBadge({ review }: { review: TankReview | null }) {
  if (!review) return <span className="muted">—</span>;
  const v = VERDICT[review.verdict];
  return (
    <span
      className={`pill ${v.cls}`}
      title={`${review.username}, ${fmtDateTime(review.updatedAt)}${review.note ? `\n${review.note}` : ''}`}
    >
      {v.label}
    </span>
  );
}

/** Compact, for the machine table: Maris ✓ 0,98 · brojač ✓ 1,13. */
// What each check means, shown on hover.
const CHECK_HELP_LEGEND =
  'Zadnjih 30 dana. ✓ slaže se · ✗ ne slaže se · ? još premalo podataka. Broj je omjer (1,00 = savršeno slaganje).\n' +
  'Ne mijenja nikakve brojke — samo odlučuje mogu li događaji ovog stroja biti „siguran” ili traže „provjeriti”.';
const MARIS_HELP =
  'Maris: odgovara li porast razine pri svakom punjenju litrama s izdatnice? Ako ne, kapacitet spremnika u ' +
  `LiDAT-u vjerojatno je krivo zadan.\n\n${CHECK_HELP_LEGEND}`;
const COUNTER_HELP =
  'Brojač: pada li razina u spremniku za onoliko koliko je motor potrošio prema brojaču potrošnje?' +
  `\n\n${CHECK_HELP_LEGEND}`;
const HELP_STYLE = { cursor: 'help' } as const;

export function CalibrationCell({ calibration }: { calibration: TankCalibration }) {
  const { maris, counter } = calibration;
  return (
    <span>
      <span className={CHECK[maris.status].cls} title={MARIS_HELP} style={HELP_STYLE}>
        Maris {CHECK[maris.status].mark} {ratioText(maris.ratio)}
      </span>
      <span className="muted"> · </span>
      <span className={CHECK[counter.status].cls} title={COUNTER_HELP} style={HELP_STYLE}>
        brojač {CHECK[counter.status].mark} {ratioText(counter.ratio)}
      </span>
    </span>
  );
}

/** Sentence form, for the machine drawer. */
export function CalibrationLine({ calibration }: { calibration: TankCalibration }) {
  const { maris, counter } = calibration;
  return (
    <div style={{ marginBottom: 12 }}>
      <span className="muted">Provjera senzora (zadnjih 30 dana): </span>
      <span title={MARIS_HELP} style={HELP_STYLE}>
        izdatnice iz Marisa —{' '}
        <span className={CHECK[maris.status].cls}>
          {CHECK[maris.status].text}
          {maris.ratio !== null && ` (omjer ${ratioText(maris.ratio)})`}
        </span>
        <span className="muted">, {maris.slips} usporedivih</span>
      </span>
      ;{' '}
      <span title={COUNTER_HELP} style={HELP_STYLE}>
        brojač potrošnje —{' '}
        <span className={CHECK[counter.status].cls}>
          {CHECK[counter.status].text}
          {counter.ratio !== null && ` (omjer ${ratioText(counter.ratio)})`}
        </span>
        <span className="muted">, {fmt(counter.burnedLitres, 0)} L potrošnje za usporedbu</span>
      </span>
    </div>
  );
}

/** The span of raw readings that shows an event: around a drop, a fill-to-fill cycle, a slip's days. */
function evidenceWindow(e: TankEvent, d: TankDetail): { from: string; to: string; at: number | null } {
  const iso = (ms: number) => new Date(ms).toISOString();
  if (e.kind === 'drain' && e.time) {
    const drain = d.drains.find((x) => x.time === e.time);
    const b = Date.parse(e.time);
    return { from: iso(Date.parse(drain?.prevTime ?? e.time) - 6 * HOUR_MS), to: iso(b + 12 * HOUR_MS), at: b };
  }
  if (e.kind === 'cycle_loss' && e.since && e.time) {
    const b = Date.parse(e.time);
    const a = Math.max(Date.parse(e.since), b - 4.5 * 24 * HOUR_MS);
    return { from: iso(a - 2 * HOUR_MS), to: iso(b + 2 * HOUR_MS), at: b };
  }
  if (e.time) {
    const t = Date.parse(e.time);
    return { from: iso(t - 12 * HOUR_MS), to: iso(t + 12 * HOUR_MS), at: t };
  }
  // A slip with no fill: the day before it to the day after.
  const day = new Date(`${e.day}T00:00:00`).getTime();
  return { from: iso(day - 24 * HOUR_MS), to: iso(day + 48 * HOUR_MS), at: null };
}

interface EvidenceRow {
  t: number;
  measured: number;
  expected: number;
  burned: number | null; // counter since the window's first reading
  engine: number | null; // engine hours since then
}

/**
 * Each level reading next to what the level would be if only the engine had
 * used fuel since the first one (plus the fills the sensor saw): where the two
 * part, fuel left some other way.
 */
function evidenceRows(r: TankReadings, d: TankDetail): EvidenceRow[] {
  if (r.levels.length === 0) return [];
  const t0 = Date.parse(r.levels[0].t);
  const first = r.levels[0].litres;
  const fills = d.refuels.map((f) => ({ ms: Date.parse(f.time), litres: f.litres }));
  // Cumulative series as moved since t0; a counter that went back restarts from there.
  const since = (points: Array<{ ms: number; v: number }>) => {
    let i = 0;
    let prev: number | null = null;
    let total = 0;
    while (i < points.length && points[i].ms <= t0) prev = points[i++].v;
    return (ms: number): number | null => {
      while (i < points.length && points[i].ms <= ms) {
        const v = points[i++].v;
        if (prev !== null && v >= prev) total += v - prev;
        prev = v;
      }
      return prev === null ? null : total;
    };
  };
  const burnedAt = since(r.counter.map((c) => ({ ms: Date.parse(c.t), v: c.litres })));
  const engineAt = since(r.engine.map((c) => ({ ms: Date.parse(c.t), v: c.hours })));
  return r.levels.map((p) => {
    const ms = Date.parse(p.t);
    const burned = burnedAt(ms);
    const added = fills.filter((f) => f.ms > t0 && f.ms <= ms).reduce((s, f) => s + f.litres, 0);
    return {
      t: ms,
      measured: p.litres,
      expected: Math.round((first - (burned ?? 0) + added) * 10) / 10,
      burned,
      engine: engineAt(ms),
    };
  });
}

/**
 * One event, opened to check it: what was found and why it is (or isn't) sure,
 * the raw readings around it, where the machine stood, and what was found on site.
 */
export function EventEvidence({
  event,
  detail,
  graceDays,
  onReviewed,
  onClose,
}: {
  event: TankEvent;
  detail: TankDetail;
  graceDays: number | null;
  onReviewed: () => void;
  onClose: () => void;
}) {
  const span = useMemo(() => evidenceWindow(event, detail), [event, detail]);
  const [readings, setReadings] = useState<TankReadings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReadings(null);
    setError(null);
    api
      .tankReadings(detail.serialNumber, span.from, span.to)
      .then((r) => !cancelled && setReadings(r))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [detail.serialNumber, span.from, span.to]);

  const rows = useMemo(() => (readings ? evidenceRows(readings, detail) : []), [readings, detail]);
  const drain = event.kind === 'drain' ? detail.drains.find((d) => d.time === event.time) : undefined;
  const ticks = useMemo(() => hourTicks(rows), [rows]);

  return (
    <div className="panel evidence">
      <div className="panel-head">
        <h2>
          {EVENT_LABELS[event.kind]}{' '}
          <span className="muted" style={{ fontWeight: 400 }}>
            {event.time ? fmtDateTime(event.time) : fmtDate(event.day)}
          </span>
        </h2>
        <div className="panel-actions" style={{ alignItems: 'center' }}>
          <ConfidenceBadge event={event} />
          <button className="btn secondary" onClick={onClose}>
            Zatvori
          </button>
        </div>
      </div>
      <div style={{ marginBottom: 8 }}>{eventDetail(event, graceDays)}</div>
      {event.reasons.length > 0 && (
        <ul className="reasons">
          {event.reasons.map((r, i) => (
            <li key={i} className={r.ok ? 'ok' : 'no'}>
              <span className="mark">{r.ok ? '✓' : '!'}</span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Očitanja oko događaja</h3>
      {error && <div className="error-box">{error}</div>}
      {!readings && !error && <div className="spinner">Učitavanje…</div>}
      {readings && rows.length < 2 && <div className="muted">Nema očitanja razine u tom razdoblju.</div>}
      {rows.length >= 2 && (
        <>
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={rows} margin={{ left: 10, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2b3742" />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                ticks={ticks}
                tickFormatter={(t) =>
                  new Date(t).toLocaleString('hr-HR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                }
                stroke="#8b9bab"
                tick={{ fontSize: 11 }}
              />
              <YAxis stroke="#8b9bab" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
              <Tooltip
                contentStyle={{ background: '#182027', border: '1px solid #2b3742', color: '#e6edf3' }}
                labelFormatter={(t) => fmtDateTime(new Date(t as number).toISOString())}
                formatter={(v: number, name) => [`${fmt(v, 1)} L`, name]}
              />
              {readings?.engineOff.map((s) => (
                <ReferenceArea
                  key={`off-${s.from}`}
                  x1={Date.parse(s.from)}
                  x2={Date.parse(s.to)}
                  fill="#8b9bab"
                  fillOpacity={0.16}
                  ifOverflow="hidden"
                />
              ))}
              {span.at !== null && <ReferenceLine x={span.at} stroke="#f85149" strokeDasharray="4 4" />}
              <Line
                dataKey="measured"
                name="Izmjereno (senzor)"
                type="linear"
                stroke="#f5a623"
                strokeWidth={1.5}
                dot={rows.length < 120 ? { r: 2 } : false}
                isAnimationActive={false}
              />
              <Line
                dataKey="expected"
                name="Očekivano prema brojaču potrošnje"
                type="linear"
                stroke="#4aa3ff"
                strokeDasharray="5 4"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="chart-legend">
            <span>
              <i style={{ background: '#f5a623', height: 2 }} /> Izmjereno (senzor razine)
            </span>
            <span>
              <i style={{ background: '#4aa3ff', height: 2 }} /> Očekivano: prva razina − potrošnja motora + dolijevanja
            </span>
            {readings && readings.engineOff.length > 0 && (
              <span title="Brojač radnih sati motora je stajao barem 30 minuta">
                <i style={{ background: 'rgba(139,155,171,0.35)', height: 10 }} /> Motor ugašen
              </span>
            )}
          </div>
          <details style={{ marginTop: 8 }}>
            <summary>Sva očitanja ({rows.length})</summary>
            <div className="raw-readings">
              <table>
                <thead>
                  <tr>
                    <th>Vrijeme</th>
                    <th className="num">Razina (L)</th>
                    <th className="num">Brojač potrošnje (L)</th>
                    <th className="num">Rad motora (h)</th>
                    <th className="num">Razlika od očekivanog (L)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.t}>
                      <td>{fmtDateTime(new Date(r.t).toISOString())}</td>
                      <td className="num">{fmt(r.measured, 1)}</td>
                      <td className="num">{r.burned === null ? '—' : `+${fmt(r.burned, 1)}`}</td>
                      <td className="num">{r.engine === null ? '—' : `+${fmt(r.engine, 2)}`}</td>
                      <td className={`num ${r.measured - r.expected <= -15 ? 'neg' : ''}`}>
                        {fmt(r.measured - r.expected, 1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}

      {drain && drain.latitude != null && drain.longitude != null && (
        <div style={{ marginTop: 12 }}>
          <LocationMiniMap lat={drain.latitude} lng={drain.longitude} />
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            {drain.latitude.toFixed(5)}, {drain.longitude.toFixed(5)} · pozicija stroja zabilježena{' '}
            {fmtDateTime(drain.locationTime)}
            {drain.movedMetres !== null &&
              (drain.movedMetres <= 100
                ? ' · stroj se između očitanja nije pomaknuo'
                : ` · stroj se između očitanja pomaknuo ${fmt(drain.movedMetres / 1000, 1)} km`)}
          </div>
        </div>
      )}

      {event.confidence !== null && <ReviewForm event={event} onSaved={onReviewed} />}
    </div>
  );
}

/** Local midnights and noons inside the rows' span, thinned to about eight labels. */
function hourTicks(rows: EvidenceRow[]): number[] {
  if (rows.length < 2) return [];
  const [a, b] = [rows[0].t, rows[rows.length - 1].t];
  const step = (b - a) / HOUR_MS > 48 ? 12 : (b - a) / HOUR_MS > 18 ? 6 : 3;
  const d = new Date(a);
  d.setMinutes(0, 0, 0);
  d.setHours(Math.ceil(d.getHours() / step) * step);
  const out: number[] = [];
  while (d.getTime() <= b) {
    if (d.getTime() >= a) out.push(d.getTime());
    d.setHours(d.getHours() + step);
  }
  const thin = Math.max(1, Math.ceil(out.length / 8));
  return out.filter((_, i) => i % thin === 0);
}

/** What was found on site: confirmed or a false alarm, with a note. */
function ReviewForm({ event, onSaved }: { event: TankEvent; onSaved: () => void }) {
  const [verdict, setVerdict] = useState<ReviewVerdict | null>(event.review?.verdict ?? null);
  const [note, setNote] = useState(event.review?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVerdict(event.review?.verdict ?? null);
    setNote(event.review?.note ?? '');
  }, [event.key, event.review]);

  const save = (v: ReviewVerdict | null) => {
    setSaving(true);
    setError(null);
    api
      .saveTankReview({
        key: event.key,
        serialNumber: event.serialNumber,
        kind: event.kind,
        day: event.day,
        verdict: v,
        note: v ? note.trim() : '',
      })
      .then(onSaved)
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const changed = verdict !== (event.review?.verdict ?? null) || note.trim() !== (event.review?.note ?? '');

  return (
    <div className="review-box">
      <h3>Provjera na terenu</h3>
      {event.review && (
        <div className="muted" style={{ marginBottom: 8 }}>
          {VERDICT[event.review.verdict].label} — {event.review.username}, {fmtDateTime(event.review.updatedAt)}
        </div>
      )}
      <div className="review-actions">
        <button
          className={`btn secondary${verdict === 'confirmed' ? ' active' : ''}`}
          onClick={() => setVerdict('confirmed')}
          title="Na terenu je potvrđeno da je gorivo nestalo ili da je izdatnica kriva"
        >
          Potvrđeno
        </button>
        <button
          className={`btn secondary${verdict === 'false_alarm' ? ' active' : ''}`}
          onClick={() => setVerdict('false_alarm')}
          title="Na terenu se pokazalo da je sve u redu"
        >
          Lažna uzbuna
        </button>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={1000}
        rows={2}
        placeholder="Bilješka: što je utvrđeno (npr. tko je točio, gdje je stroj stajao)"
      />
      <div className="review-actions">
        <button className="btn" disabled={!verdict || !changed || saving} onClick={() => save(verdict)}>
          {saving ? 'Spremanje…' : 'Spremi'}
        </button>
        {event.review && (
          <button className="btn secondary" disabled={saving} onClick={() => save(null)}>
            Poništi provjeru
          </button>
        )}
      </div>
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
