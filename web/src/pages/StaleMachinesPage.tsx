import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api } from '../api';
import type { Machine, MachineGroup } from '../types';
import { GROUP_LABELS } from '../types';
import { daysSince, fmtDateTime, isStale, shortModel } from '../util';
import { GroupFilter } from '../components/GroupFilter';

const STALE_DAYS = 10;
const DEFAULT_CENTER: [number, number] = [45.55, 18.69]; // Osijek area fallback

function pinIcon(label: string): L.DivIcon {
  return L.divIcon({
    className: 'machine-pin',
    html: `<span class="machine-pin__dot"></span><span class="machine-pin__label">${label}</span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function FitBounds({ points }: { points: Array<[number, number]> }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], 13);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
  }, [map, points]);
  return null;
}

export function StaleMachinesPage({ allowedGroups }: { allowedGroups: MachineGroup[] }) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Exactly one group is shown at a time: Osijek if available, else the user's first.
  const [groups, setGroups] = useState<Set<MachineGroup>>(
    () => new Set<MachineGroup>([allowedGroups.includes('osijek') ? 'osijek' : allowedGroups[0] ?? 'osijek']),
  );
  const mapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    api
      .machines()
      .then(setMachines)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Stale = no LiDAT reading in the last 10 days (or never), within the chosen groups.
  const rows = useMemo(
    () =>
      machines
        .filter((m) => isStale(m.lastReadingTime, STALE_DAYS) && groups.has(m.group))
        .sort((a, b) => {
          const da = daysSince(a.lastReadingTime);
          const db = daysSince(b.lastReadingTime);
          // Highest days first, descending; never-connected ("Nikad") last.
          if (da === null && db === null) return 0;
          if (da === null) return 1;
          if (db === null) return -1;
          return db - da;
        }),
    [machines, groups],
  );

  const located = useMemo(
    () => rows.filter((m) => m.latitude != null && m.longitude != null),
    [rows],
  );
  const points = useMemo<Array<[number, number]>>(
    () => located.map((m) => [m.latitude as number, m.longitude as number]),
    [located],
  );

  return (
    <>
      <div className="toolbar">
        <div className="muted">
          Strojevi bez LiDAT izvještaja dulje od {STALE_DAYS} dana — prikazani su sa zadnjom poznatom
          lokacijom.
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <GroupFilter value={groups} onChange={setGroups} options={allowedGroups} single />
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="panel" ref={mapRef}>
        <div className="map-head">
          <h2>
            Zadnja poznata lokacija <span className="muted">({located.length})</span>
          </h2>
        </div>
        {located.length === 0 ? (
          <div className="muted">
            {loading ? 'Učitavanje…' : 'Nema neaktivnih strojeva s poznatom lokacijom.'}
          </div>
        ) : (
          <div className="map-wrap">
            <MapContainer
              center={points[0] ?? DEFAULT_CENTER}
              zoom={11}
              scrollWheelZoom
              style={{ height: '100%', width: '100%' }}
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              />
              <FitBounds points={points} />
              {located.map((m) => (
                <Marker
                  key={m.serialNumber}
                  position={[m.latitude as number, m.longitude as number]}
                  icon={pinIcon(shortModel(m.model))}
                />
              ))}
            </MapContainer>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Neaktivni strojevi ({rows.length})</h2>
        {loading ? (
          <div className="spinner">Učitavanje…</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Stroj</th>
                <th>Grupa</th>
                <th>Zadnje očitanje</th>
                <th className="num">Dana bez signala</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const d = daysSince(m.lastReadingTime);
                return (
                  <tr key={m.serialNumber}>
                    <td>
                      <strong>{shortModel(m.model)}</strong>{' '}
                      <span className="muted">{m.serialNumber}</span>
                    </td>
                    <td className="muted">{GROUP_LABELS[m.group]}</td>
                    <td className="muted">
                      {m.lastReadingTime ? fmtDateTime(m.lastReadingTime) : 'Nikad'}
                    </td>
                    <td className="num">{d === null ? '—' : Math.floor(d)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    Svi strojevi su nedavno izvijestili.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
