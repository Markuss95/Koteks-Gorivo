import { useEffect, useState } from 'react';
import { api } from '../api';
import type { HealthResponse, Machine } from '../types';
import { fmtDateTime, shortModel } from '../util';

export function MachinesPage({
  health,
  onSyncDone,
}: {
  health: HealthResponse | null;
  onSyncDone: () => void;
}) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api
      .machines()
      .then(setMachines)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const sync = async () => {
    setSyncing(true);
    setError(null);
    try {
      await api.triggerSync();
      // Poll until the backend reports it's no longer running.
      const poll = setInterval(async () => {
        const h = await api.health().catch(() => null);
        if (h && !h.sync.running) {
          clearInterval(poll);
          setSyncing(false);
          load();
          onSyncDone();
        }
      }, 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSyncing(false);
    }
  };

  const last = health?.sync.last;

  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={sync} disabled={syncing || health?.sync.running}>
          {syncing || health?.sync.running ? 'Sinkronizacija…' : 'Sinkroniziraj LiDAT'}
        </button>
        <button className="btn secondary" onClick={load}>
          Osvježi
        </button>
        <div style={{ marginLeft: 'auto' }} className="muted">
          Raspored: <code>{health?.sync.cron ?? '—'}</code>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {last && (
        <div className="panel">
          <h2>Zadnja sinkronizacija</h2>
          <div className="muted" style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <span>Status: <strong className={last.status === 'success' ? 'pos' : last.status === 'error' ? 'neg' : ''}>{last.status}</strong></span>
            <span>Početak: {fmtDateTime(last.started_at)}</span>
            <span>Kraj: {fmtDateTime(last.finished_at)}</span>
            <span>Dodano očitanja: {last.readings_added}</span>
            <span>Strojevi OK/greška: {last.machines_ok}/{last.machines_failed}</span>
          </div>
          {last.message && last.message !== 'OK' && (
            <div className="muted" style={{ marginTop: 8 }}>{last.message}</div>
          )}
        </div>
      )}

      <div className="panel">
        <h2>Strojevi ({machines.length})</h2>
        {loading ? (
          <div className="spinner">Učitavanje…</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Serijski broj</th>
                <th>LiDAT model</th>
                <th>EquipmentID</th>
                <th>Radni nalozi</th>
                <th className="num">Očitanja</th>
                <th>Zadnje očitanje</th>
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => (
                <tr key={m.serialNumber}>
                  <td><strong>{shortModel(m.model)}</strong></td>
                  <td>{m.serialNumber}</td>
                  <td className="muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.makeCode ?? ''}>
                    {m.oemName ? `${m.oemName} ${m.makeCode ?? ''}` : <span className="pill warn">nije povezan</span>}
                  </td>
                  <td className="muted">{m.equipmentId ?? '—'}</td>
                  <td className="muted">{m.rnalogs.join(', ')}</td>
                  <td className="num">{m.lidatReadingCount}</td>
                  <td className="muted">{fmtDateTime(m.lastReadingTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
