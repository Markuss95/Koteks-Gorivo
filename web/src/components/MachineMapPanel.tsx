import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { MachineGroup, MachinePosition } from '../types';
import { today } from '../util';
import { MachinesMap } from './MachinesMap';

// Earliest date with reliable position history (matches the comparison floor).
const MAP_DATE_FLOOR = '2026-06-04';

/**
 * Self-contained machine map: owns the date + positions fetching and (optionally)
 * the selection. Used on both Strojevi and Ler so the map is identical.
 *
 * - `selected`/`onSelect`: pass to control selection from the parent (e.g. a table
 *   row click). Omit for fully self-managed selection.
 * - `reloadSignal`: bump to re-fetch positions for the current date (e.g. after a sync).
 */
export function MachineMapPanel({
  selected,
  onSelect,
  reloadSignal,
  groups,
}: {
  selected?: string | null;
  onSelect?: (serial: string | null) => void;
  reloadSignal?: number;
  // When set, only positions in these groups are plotted (undefined = all).
  groups?: Set<MachineGroup>;
}) {
  const [mapDate, setMapDate] = useState(today());
  const [positions, setPositions] = useState<MachinePosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [internalSelected, setInternalSelected] = useState<string | null>(null);

  const sel = selected !== undefined ? selected : internalSelected;
  const setSel = onSelect ?? setInternalSelected;

  useEffect(() => {
    setLoading(true);
    api
      .machinePositions(mapDate)
      .then(setPositions)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mapDate, reloadSignal]);

  const shown = useMemo(
    () => (groups ? positions.filter((p) => groups.has(p.group)) : positions),
    [positions, groups],
  );

  return (
    <>
      {error && <div className="error-box">{error}</div>}
      <MachinesMap
        positions={shown}
        selected={sel}
        onSelect={setSel}
        date={mapDate}
        onDateChange={(d) => {
          setSel(null);
          setMapDate(d);
        }}
        minDate={MAP_DATE_FLOOR}
        maxDate={today()}
        loading={loading}
      />
    </>
  );
}
