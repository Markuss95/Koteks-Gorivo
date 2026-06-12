import { useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Machine } from '../types';
import { fmtDateTime, shortModel } from '../util';

// A machine that actually has coordinates we can plot.
type Located = Machine & { latitude: number; longitude: number };

function hasLocation(m: Machine): m is Located {
  return typeof m.latitude === 'number' && typeof m.longitude === 'number';
}

// Amber pin drawn purely in CSS — avoids Leaflet's default marker images,
// which break under Vite bundling without extra asset wiring. The selected
// machine gets a highlighted variant.
function pinIcon(label: string, selected: boolean): L.DivIcon {
  return L.divIcon({
    className: `machine-pin${selected ? ' selected' : ''}`,
    html: `<span class="machine-pin__dot"></span><span class="machine-pin__label">${label}</span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

/**
 * Drive the viewport imperatively: focus the selected machine (pan + zoom +
 * open its popup), or fit all machines when nothing is selected.
 */
function MapController({
  points,
  focus,
  markerRefs,
}: {
  points: Array<[number, number]>;
  focus: { serial: string; pos: [number, number] } | null;
  markerRefs: React.MutableRefObject<Record<string, L.Marker | null>>;
}) {
  const map = useMap();
  useEffect(() => {
    if (focus) {
      map.setView(focus.pos, Math.max(map.getZoom(), 14), { animate: true });
      markerRefs.current[focus.serial]?.openPopup();
      return;
    }
    map.closePopup();
    if (points.length === 1) {
      map.setView(points[0], 13);
    } else if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
    }
  }, [map, focus, points, markerRefs]);
  return null;
}

export function MachinesMap({
  machines,
  selected,
  onSelect,
}: {
  machines: Machine[];
  selected: string | null;
  onSelect: (serial: string | null) => void;
}) {
  const located = useMemo(() => machines.filter(hasLocation), [machines]);
  const points = useMemo<Array<[number, number]>>(
    () => located.map((m) => [m.latitude, m.longitude]),
    [located],
  );
  const markerRefs = useRef<Record<string, L.Marker | null>>({});

  // Only machines we can actually plot are focusable on the map.
  const focus = useMemo(() => {
    if (!selected) return null;
    const m = located.find((x) => x.serialNumber === selected);
    return m ? { serial: m.serialNumber, pos: [m.latitude, m.longitude] as [number, number] } : null;
  }, [selected, located]);

  if (located.length === 0) {
    return (
      <div className="panel">
        <h2>Karta strojeva</h2>
        <div className="muted">
          Nema GPS pozicija. Pokrenite sinkronizaciju — pozicije se preuzimaju iz LiDAT snimke flote.
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="map-head">
        <h2>
          Karta strojeva <span className="muted">({located.length} s pozicijom)</span>
        </h2>
        <div className="map-select">
          <select
            value={focus ? focus.serial : ''}
            onChange={(e) => onSelect(e.target.value || null)}
          >
            <option value="">Svi strojevi</option>
            {located.map((m) => (
              <option key={m.serialNumber} value={m.serialNumber}>
                {shortModel(m.model)} — {m.serialNumber}
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
      <div className="map-wrap">
        <MapContainer
          center={points[0]}
          zoom={11}
          scrollWheelZoom
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />
          <MapController points={points} focus={focus} markerRefs={markerRefs} />
          {located.map((m) => (
            <Marker
              key={m.serialNumber}
              position={[m.latitude, m.longitude]}
              icon={pinIcon(shortModel(m.model), m.serialNumber === selected)}
              ref={(r) => {
                markerRefs.current[m.serialNumber] = r;
              }}
              eventHandlers={{ click: () => onSelect(m.serialNumber) }}
            >
              <Popup>
                <strong>{shortModel(m.model)}</strong>
                <br />
                Serijski broj: {m.serialNumber}
                {m.equipmentId && (
                  <>
                    <br />
                    EquipmentID: {m.equipmentId}
                  </>
                )}
                <br />
                {m.latitude.toFixed(5)}, {m.longitude.toFixed(5)}
                <br />
                <span className="muted">Pozicija: {fmtDateTime(m.locationTime)}</span>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
