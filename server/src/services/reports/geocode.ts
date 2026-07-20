// Reverse geocoding of machine positions into readable place names, via
// OpenStreetMap's Nominatim service.
//
// Ported from the browser implementation. Two things differ server-side: the
// cache lives in SQLite (so it survives restarts and is shared by every user),
// and Nominatim's usage policy asks for an identifying User-Agent, which a
// browser cannot set but Node can.
import { db } from '../../db/index.js';

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
// Policy is 1 req/s; the margin keeps us clear of it under clock jitter.
const MIN_INTERVAL_MS = 1100;
const TIMEOUT_MS = 8000;
const USER_AGENT = 'KoteksGorivo/1.0 (fleet fuel reporting; contact: noreply@osijek-koteks.hr)';

export interface GeoPoint {
  serialNumber: string;
  lat: number;
  lon: number;
}

// ~11 m precision: fine enough to distinguish parking spots, coarse enough that
// GPS jitter still hits the same cache entry.
function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function cacheGet(key: string): string | null {
  const row = db
    .prepare('SELECT place_name FROM geocode_cache WHERE coord_key = ?')
    .get(key) as { place_name: string } | undefined;
  return row ? row.place_name : null;
}

function cachePut(key: string, name: string): void {
  db.prepare(
    `INSERT INTO geocode_cache (coord_key, place_name, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(coord_key) DO UPDATE SET place_name = excluded.place_name, fetched_at = excluded.fetched_at`,
  ).run(key, name, new Date().toISOString());
}

// Nominatim's address object → a short "street, place" label. Falls back through
// the settlement tags because rural quarry sites rarely carry a city.
function describe(addr: Record<string, string> | undefined, displayName?: string): string | null {
  if (!addr) return displayName?.split(',').slice(0, 3).join(',').trim() || null;
  const settlement =
    addr.village ?? addr.town ?? addr.city ?? addr.hamlet ?? addr.municipality ?? addr.county;
  const parts = [addr.road, settlement].filter(Boolean);
  if (parts.length === 0) {
    return displayName?.split(',').slice(0, 3).join(',').trim() || null;
  }
  return parts.join(', ');
}

async function lookup(lat: number, lon: number): Promise<string | null> {
  const url =
    `${ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1&accept-language=hr`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      address?: Record<string, string>;
      display_name?: string;
    };
    return describe(body.address, body.display_name);
  } catch {
    // Offline, blocked, rate-limited or timed out — the column just stays empty.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve place names for `points`, returning a serial → name map. Cached points
 * cost nothing; the rest are fetched one per second. Failures are omitted, so a
 * missing serial means "no description available", not an error.
 */
export async function reverseGeocode(points: GeoPoint[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  // Several machines can sit at the same spot (a yard); dedupe so one shared
  // location costs one request.
  const pending = new Map<string, GeoPoint[]>();
  for (const p of points) {
    const key = cacheKey(p.lat, p.lon);
    const hit = cacheGet(key);
    if (hit) {
      out.set(p.serialNumber, hit);
      continue;
    }
    const list = pending.get(key);
    if (list) list.push(p);
    else pending.set(key, [p]);
  }

  let remaining = pending.size;
  for (const [key, group] of pending) {
    const name = await lookup(group[0].lat, group[0].lon);
    if (name) {
      cachePut(key, name);
      for (const p of group) out.set(p.serialNumber, name);
    }
    remaining -= 1;
    // Skip the courtesy delay after the final request.
    if (remaining > 0) await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
  }

  return out;
}
