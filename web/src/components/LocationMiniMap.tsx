import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Single amber dot (CSS divIcon — no Leaflet marker images needed).
const pin = L.divIcon({
  className: 'machine-pin',
  html: '<span class="machine-pin__dot"></span>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

/** Compact map centred on one machine's last known position. */
export function LocationMiniMap({ lat, lng }: { lat: number; lng: number }) {
  return (
    <div className="map-wrap" style={{ height: 240 }}>
      <MapContainer
        center={[lat, lng]}
        zoom={14}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        <Marker position={[lat, lng]} icon={pin} />
      </MapContainer>
    </div>
  );
}
