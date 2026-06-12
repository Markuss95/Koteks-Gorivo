import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MachinePosition } from '../types';
import { shortModel } from '../util';
import { DateField } from './DateField';

// Fallback view (Osijek area) when there are no positions to fit.
const DEFAULT_CENTER: [number, number] = [45.55, 18.69];

// Amber pin drawn purely in CSS — avoids Leaflet's default marker images, which
// break under Vite bundling. The selected machine gets a highlighted variant.
function pinIcon(label: string, selected: boolean): L.DivIcon {
  return L.divIcon({
    className: `machine-pin${selected ? ' selected' : ''}`,
    html: `<span class="machine-pin__dot"></span><span class="machine-pin__label">${label}</span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

/** Focus the selected machine (pan + zoom), or fit all when none. */
function MapController({
  points,
  focus,
}: {
  points: Array<[number, number]>;
  focus: { serial: string; pos: [number, number] } | null;
}) {
  const map = useMap();
  useEffect(() => {
    if (focus) {
      map.setView(focus.pos, Math.max(map.getZoom(), 14), { animate: true });
      return;
    }
    if (points.length === 1) {
      map.setView(points[0], 13);
    } else if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
    }
  }, [map, focus, points]);
  return null;
}

export function MachinesMap({
  positions,
  selected,
  onSelect,
  date,
  onDateChange,
  minDate,
  maxDate,
  loading,
}: {
  positions: MachinePosition[];
  selected: string | null;
  onSelect: (serial: string | null) => void;
  date: string;
  onDateChange: (date: string) => void;
  minDate: string;
  maxDate: string;
  loading: boolean;
}) {
  const points = useMemo<Array<[number, number]>>(
    () => positions.map((p) => [p.latitude, p.longitude]),
    [positions],
  );

  const focus = useMemo(() => {
    if (!selected) return null;
    const p = positions.find((x) => x.serialNumber === selected);
    return p ? { serial: p.serialNumber, pos: [p.latitude, p.longitude] as [number, number] } : null;
  }, [selected, positions]);

  return (
    <div className="panel">
      <div className="map-head">
        <h2>
          Karta strojeva <span className="muted">({positions.length})</span>
        </h2>
        <div className="map-controls">
          <label className="map-date">
            <span className="muted">Datum</span>
            <DateField value={date} min={minDate} max={maxDate} onChange={onDateChange} />
          </label>
          <select value={focus ? focus.serial : ''} onChange={(e) => onSelect(e.target.value || null)}>
            <option value="">Svi strojevi</option>
            {positions.map((p) => (
              <option key={p.serialNumber} value={p.serialNumber}>
                {shortModel(p.model)} — {p.serialNumber}
              </option>
            ))}
          </select>
          {focus && (
            <button className="btn secondary" onClick={() => onSelect(null)}>
              Prikaži sve
            </button>
          )}
        </div>
      </div>

      {positions.length === 0 ? (
        <div className="muted">
          {loading
            ? 'Učitavanje pozicija…'
            : `Nema GPS pozicija za ${date}. Pozicije se preuzimaju sinkronizacijom (od 1. 6. 2026.).`}
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
            <MapController points={points} focus={focus} />
            {positions.map((p) => (
              <Marker
                key={p.serialNumber}
                position={[p.latitude, p.longitude]}
                icon={pinIcon(shortModel(p.model), p.serialNumber === selected)}
                eventHandlers={{ click: () => onSelect(p.serialNumber) }}
              />
            ))}
          </MapContainer>
        </div>
      )}
    </div>
  );
}
