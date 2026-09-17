import { TileLayer } from 'react-leaflet';

// CARTO basemaps require an API key since late Aug 2026 — without one every tile
// is stamped "API KEY REQUIRED". Free key: https://carto.com/basemaps/apikey
const CARTO_KEY = import.meta.env.VITE_CARTO_API_KEY?.trim();

const TILE_URL =
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' +
  (CARTO_KEY ? `?key=${encodeURIComponent(CARTO_KEY)}` : '');

if (!CARTO_KEY) {
  console.warn('VITE_CARTO_API_KEY is not set — map tiles will show an "API KEY REQUIRED" watermark.');
}

/** Dark CARTO basemap shared by every map in the app. */
export function BaseTileLayer() {
  return (
    <TileLayer
      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      url={TILE_URL}
    />
  );
}
