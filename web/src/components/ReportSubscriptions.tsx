import { useEffect, useState } from 'react';
import { api } from '../api';
import type {
  ManagedUser,
  FormatChoice,
  ReportCadence,
  ReportLogEntry,
  ReportRunResult,
  ReportSubscription,
  ReportType,
} from '../types';
import { fmtDateTime } from '../util';

const TYPES: Array<{ key: ReportType; label: string }> = [
  { key: 'fuel', label: 'Gorivo' },
  { key: 'activity', label: 'Aktivnost' },
];

const CADENCES: Array<{ key: ReportCadence; label: string }> = [
  { key: 'monthly', label: 'Mjesečno' },
  { key: 'quarterly', label: 'Kvartalno' },
];

/**
 * Admin panel: who receives which report automatically. Monthly subscriptions go
 * out on the last working day of every month and cover the previous month;
 * quarterly ones go out in April, July, October and January and cover the
 * quarter that ended a month earlier.
 */
export function ReportSubscriptions() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [subs, setSubs] = useState<ReportSubscription[]>([]);
  const [log, setLog] = useState<ReportLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<ReportRunResult | null>(null);
  const [runCadence, setRunCadence] = useState<ReportCadence>('monthly');

  const load = () =>
    Promise.all([api.users(), api.reportSubscriptions()])
      .then(([u, s]) => {
        setUsers(u);
        setSubs(s.subscriptions);
        setLog(s.log);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const find = (userId: number, type: ReportType, cadence: ReportCadence) =>
    subs.find((s) => s.userId === userId && s.reportType === type && s.cadence === cadence);

  const save = async (
    userId: number,
    reportType: ReportType,
    cadence: ReportCadence,
    patch: Partial<ReportSubscription>,
  ) => {
    const existing = find(userId, reportType, cadence);
    const key = `${userId}-${reportType}-${cadence}`;
    setBusy(key);
    setError(null);
    try {
      await api.saveSubscription({
        userId,
        reportType,
        cadence,
        format: patch.format ?? existing?.format ?? 'pdf',
        active: patch.active ?? existing?.active ?? false,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // Dry run builds every subscriber's report but sends nothing — the safe way to
  // confirm the schedule works without mailing anyone. A forced quarterly run
  // uses the last quarter that has fully ended, so it can be tested any day.
  const run = async (dryRun: boolean) => {
    setBusy('run');
    setError(null);
    setRunResult(null);
    try {
      setRunResult(await api.runSubscriptions(dryRun, runCadence));
      if (!dryRun) await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="panel"><div className="muted">Učitavanje…</div></div>;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Automatski izvještaji</h2>
        <div className="panel-actions">
          <select
            value={runCadence}
            onChange={(e) => setRunCadence(e.target.value as ReportCadence)}
            disabled={busy !== null}
          >
            {CADENCES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <button className="btn secondary" onClick={() => run(true)} disabled={busy !== null}>
            {busy === 'run' ? 'Provjera…' : 'Probni prolaz (bez slanja)'}
          </button>
          <button className="btn secondary" onClick={() => run(false)} disabled={busy !== null}>
            Pošalji odmah
          </button>
        </div>
      </div>

      <div className="muted" style={{ marginBottom: 12 }}>
        <strong>Mjesečno:</strong> šalje se zadnji radni dan u mjesecu i pokriva cijeli
        prethodni mjesec.{' '}
        <strong>Kvartalno:</strong> pokriva cijeli kvartal, a šalje se zadnji radni dan
        mjeseca nakon njegova završetka — Q1 (siječanj–ožujak) krajem travnja, Q2
        (travanj–lipanj) krajem srpnja, Q3 (srpanj–rujan) krajem listopada i Q4
        (listopad–prosinac) krajem siječnja. Primatelj vidi samo grupe koje su mu
        dodijeljene, a za svaku grupu dobiva zasebnu poruku.
      </div>

      {error && <div className="error-box">{error}</div>}

      {runResult && (
        <div className={runResult.failed > 0 ? 'error-box' : 'ok-box'}>
          {runResult.ran ? (
            <>
              Razdoblje {runResult.periodLabel ? `${runResult.periodLabel}: ` : ''}
              {runResult.from} – {runResult.to}: poslano {runResult.sent}, greška{' '}
              {runResult.failed}, preskočeno {runResult.skipped}.
              {runResult.details.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                  {runResult.details.map((d, i) => (
                    <li key={i}>
                      {d.recipient} — {d.group} — {d.type}/{d.format}: {d.status}
                      {d.message ? ` (${d.message})` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>Nije pokrenuto: {runResult.reason}</>
          )}
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th rowSpan={2}>Korisnik</th>
            {CADENCES.map((c) => (
              <th key={c.key} colSpan={TYPES.length} style={{ textAlign: 'center' }}>
                {c.label}
              </th>
            ))}
          </tr>
          <tr>
            {CADENCES.flatMap((c) =>
              TYPES.map((t) => <th key={`${c.key}-${t.key}`}>{t.label}</th>),
            )}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                <strong>{u.username}</strong>
                {u.role === 'admin' && <span className="pill">admin</span>}
              </td>
              {CADENCES.flatMap((c) =>
                TYPES.map((t) => {
                  const sub = find(u.id, t.key, c.key);
                  const key = `${u.id}-${t.key}-${c.key}`;
                  return (
                    <td key={key}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={sub?.active ?? false}
                          disabled={busy !== null}
                          onChange={(e) => save(u.id, t.key, c.key, { active: e.target.checked })}
                        />
                        <select
                          value={sub?.format ?? 'pdf'}
                          disabled={busy !== null || !(sub?.active ?? false)}
                          onChange={(e) =>
                            save(u.id, t.key, c.key, { format: e.target.value as FormatChoice })
                          }
                        >
                          <option value="pdf">PDF</option>
                          <option value="excel">Excel</option>
                          <option value="both">PDF i Excel</option>
                        </select>
                        {busy === key && <span className="muted">…</span>}
                      </label>
                    </td>
                  );
                }),
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {log.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, marginTop: 22 }}>Zadnja slanja</h2>
          <table>
            <thead>
              <tr>
                <th>Vrijeme</th>
                <th>Primatelj</th>
                <th>Izvještaj</th>
                <th>Razdoblje</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.id}>
                  <td className="muted">{fmtDateTime(l.ran_at)}</td>
                  <td>{l.recipient}</td>
                  <td className="muted">
                    {l.report_type}/{l.format}
                    {l.cadence === 'quarterly' && <span className="pill">kvartalno</span>}
                  </td>
                  <td className="muted">
                    {l.period_from} – {l.period_to}
                  </td>
                  <td className={l.status === 'success' ? 'pos' : 'neg'}>
                    {l.status === 'success' ? 'Poslano' : `Greška: ${l.message ?? ''}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
