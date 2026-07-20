// Reverse geocoding of machine positions into readable place names, via
// OpenStreetMap's Nominatim service.
//
// Nominatim's usage policy caps us at ~1 request/second and asks that results be
// cached rather than re-fetched. So: lookups run sequentially with a delay, and
// every answer is stored in localStorage keyed by rounded coordinates — a machine
// parked in one spot is geocoded once, ever.
//
// Attribution (© OpenStreetMap contributors) is printed in the reports that use this.

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
const CACHE_KEY = 'kg_geocode_v1';
// Policy is 1 req/s; the margin keeps us clear of it under clock jitter.
const MIN_INTERVAL_MS = 1100;
const TIMEOUT_MS = 8000;

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

function loadCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, string>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // A full or unavailable localStorage only costs us the cache, not the report.
  }
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
    `${ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lon}` +
    `&zoom=16&addressdetails=1&accept-language=hr`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
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
 * Resolve place names for `points`, returning a serial → name map. Points already
 * in the cache resolve instantly; the rest are fetched one per second. Failures
 * are simply omitted from the result, so callers should treat a missing serial as
 * "no description available" rather than an error.
 *
 * `onProgress(done, total)` reports only the points that need a network call.
 */
export async function reverseGeocode(
  points: GeoPoint[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const cache = loadCache();
  const out = new Map<string, string>();

  const pending: GeoPoint[] = [];
  for (const p of points) {
    const hit = cache[cacheKey(p.lat, p.lon)];
    if (hit) out.set(p.serialNumber, hit);
    else pending.push(p);
  }

  // Several machines can sit at the same spot (a yard); dedupe so one shared
  // location costs one request.
  const byKey = new Map<string, GeoPoint[]>();
  for (const p of pending) {
    const k = cacheKey(p.lat, p.lon);
    const list = byKey.get(k);
    if (list) list.push(p);
    else byKey.set(k, [p]);
  }

  const total = byKey.size;
  let done = 0;
  onProgress?.(0, total);

  let dirty = false;
  for (const [key, group] of byKey) {
    const name = await lookup(group[0].lat, group[0].lon);
    if (name) {
      cache[key] = name;
      dirty = true;
      for (const p of group) out.set(p.serialNumber, name);
    }
    done += 1;
    onProgress?.(done, total);
    // Skip the courtesy delay after the final request.
    if (done < total) await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
  }

  if (dirty) saveCache(cache);
  return out;
}
