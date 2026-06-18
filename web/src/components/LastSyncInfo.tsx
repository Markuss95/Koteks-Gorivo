import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SyncLog } from '../types';
import { fmtDateTime } from '../util';

const STATUS_LABEL: Record<string, string> = {
  success: 'uspješno',
  error: 'greška',
  running: 'u tijeku',
};

/** Compact line showing when LiDAT last synced — for machine detail modals. */
export function LastSyncInfo() {
  const [last, setLast] = useState<SyncLog | null | undefined>(undefined);

  useEffect(() => {
    api
      .health()
      .then((h) => setLast(h.sync.last))
      .catch(() => setLast(null));
  }, []);

  if (last === undefined) return null; // still loading
  return (
    <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
      {last
        ? `Zadnja LiDAT sinkronizacija: ${fmtDateTime(last.finished_at ?? last.started_at)} · ${
            STATUS_LABEL[last.status] ?? last.status
          }`
        : 'LiDAT sinkronizacija još nije zabilježena.'}
    </div>
  );
}
