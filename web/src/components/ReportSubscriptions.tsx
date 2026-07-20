import { useEffect, useState } from 'react';
import { api } from '../api';
import type {
  ManagedUser,
  FormatChoice,
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

/**
 * Admin panel: who receives which report automatically on the last working day
 * of each month. One row per user, one toggle + format per report kind.
 */
export function ReportSubscriptions() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [subs, setSubs] = useState<ReportSubscription[]>([]);
  const [log, setLog] = useState<ReportLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<ReportRunResult | null>(null);

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

  const find = (userId: number, type: ReportType) =>
    subs.find((s) => s.userId === userId && s.reportType === type);

  const save = async (userId: number, reportType: ReportType, patch: Partial<ReportSubscription>) => {
    const existing = find(userId, reportType);
    const key = `${userId}-${reportType}`;
    setBusy(key);
    setError(null);
    try {
      await api.saveSubscription({
        userId,
        reportType,
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
  // confirm the schedule works without mailing anyone.
  const run = async (dryRun: boolean) => {
    setBusy('run');
    setError(null);
    setRunResult(null);
    try {
      setRunResult(await api.runSubscriptions(dryRun));
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
        <h2>Automatski mjesečni izvještaji</h2>
        <div className="panel-actions">
          <button className="btn secondary" onClick={() => run(true)} disabled={busy !== null}>
            {busy === 'run' ? 'Provjera…' : 'Probni prolaz (bez slanja)'}
          </button>
          <button className="btn secondary" onClick={() => run(false)} disabled={busy !== null}>
            Pošalji odmah
          </button>
        </div>
      </div>

      <div className="muted" style={{ marginBottom: 12 }}>
        Izvještaji se šalju automatski zadnji radni dan u mjesecu i pokrivaju cijeli
        prethodni mjesec. Primatelj vidi samo grupe koje su mu dodijeljene, a za
        svaku grupu dobiva zasebnu poruku.
      </div>

      {error && <div className="error-box">{error}</div>}

      {runResult && (
        <div className={runResult.failed > 0 ? 'error-box' : 'ok-box'}>
          {runResult.ran ? (
            <>
              Razdoblje {runResult.from} – {runResult.to}: poslano {runResult.sent}, greška{' '}
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
            <th>Korisnik</th>
            {TYPES.map((t) => (
              <th key={t.key}>{t.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                <strong>{u.username}</strong>
                {u.role === 'admin' && <span className="pill">admin</span>}
              </td>
              {TYPES.map((t) => {
                const sub = find(u.id, t.key);
                const key = `${u.id}-${t.key}`;
                return (
                  <td key={t.key}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={sub?.active ?? false}
                        disabled={busy !== null}
                        onChange={(e) => save(u.id, t.key, { active: e.target.checked })}
                      />
                      <select
                        value={sub?.format ?? 'pdf'}
                        disabled={busy !== null || !(sub?.active ?? false)}
                        onChange={(e) =>
                          save(u.id, t.key, { format: e.target.value as FormatChoice })
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
              })}
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
