import { XMLParser } from 'fast-xml-parser';
import { config, type LidatAccount } from '../config.js';

export interface LidatEquipment {
  oemName: string;
  model: string;
  equipmentId: string;
  serialNumber: string;
  fuelTankCapacity?: number;
  // Latest cumulative fuel reading from a fleet snapshot (if present)
  fuelConsumedCum?: number;
  fuelUnits?: string;
  fuelDateTime?: string;
  // Last known GPS position from the fleet snapshot (ISO 15143-3 Location)
  latitude?: number;
  longitude?: number;
  altitude?: number;
  locationTime?: string;
  // Cumulative engine + idle hours (ISO 15143-3 Cumulative*OperatingHours)
  operatingHours?: number;
  idleHours?: number;
  hoursTime?: string;
  // Tank fill level (ISO 15143-3 FuelRemaining), percent of capacity
  fuelRemainingPercent?: number;
  fuelRemainingTime?: string;
}

export interface LidatFuelReading {
  dateTime: string;
  fuelConsumedCum: number;
  fuelUnits?: string;
}

export interface LidatLocationReading {
  dateTime: string;
  latitude: number;
  longitude: number;
  altitude?: number;
}

export interface LidatHourReading {
  dateTime: string;
  hours: number;
}

export interface LidatLevelReading {
  dateTime: string;
  percent: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: true,
  trimValues: true,
});

function basicAuthHeader(account: LidatAccount): string {
  const token = Buffer.from(`${account.username}:${account.password}`).toString('base64');
  return `Basic ${token}`;
}

/** Encode a URL path segment but keep colons literal (LiDAT model strings use them). */
function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(/%3A/gi, ':');
}

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Tank percentage, or undefined for an empty/non-numeric <Percent> (never a fake 0 %). */
function parsePercent(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// LiDAT answers a burst of requests with 503 "Service Unavailable" and keeps
// refusing while the burst goes on. So the sync paces its requests, and a
// refused request waits and tries again instead of failing straight away.
// Both overridable (e.g. to test against a fake LiDAT without real waits).
const MIN_GAP_MS = Number(process.env.LIDAT_MIN_GAP_MS ?? 500);
const RETRY_DELAYS_MS = (process.env.LIDAT_RETRY_DELAYS_MS ?? '5000,20000,60000')
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= 0);
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const REQUEST_TIMEOUT_MS = 60_000;

/** LiDAT kept refusing (or not answering) even after the retries. */
export class LidatUnavailableError extends Error {}

// After this many requests in a row that failed even with retries, LiDAT is
// taken to be down: the rest of the run fails fast instead of spending ~1.5 min
// per request, and the next run carries on from the cursors.
const DOWN_AFTER_FAILURES = 3;
let failuresInARow = 0;

/** Start of a sync run: give LiDAT a clean slate. */
export function resetLidatBreaker(): void {
  failuresInARow = 0;
}

export function lidatLooksDown(): boolean {
  return failuresInARow >= DOWN_AFTER_FAILURES;
}

let nextSlot = 0;
/** Wait for this request's turn; slots are reserved up front, so parallel calls queue too. */
async function paced(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/**
 * GET one LiDAT resource and parse it. `quick` (the health check) skips pacing
 * and retries so the status dots answer at once.
 */
async function fetchXml(
  account: LidatAccount,
  pathSuffix: string,
  { quick = false }: { quick?: boolean } = {},
): Promise<any> {
  const url = `${account.baseUrl}${pathSuffix}`;
  const delays = quick ? [] : RETRY_DELAYS_MS;
  let lastProblem = '';
  if (!quick && lidatLooksDown()) {
    throw new LidatUnavailableError(`LiDAT unavailable — ${pathSuffix} skipped for the rest of this run`);
  }

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    if (!quick) await paced();

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: basicAuthHeader(account), Accept: 'application/xml' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error or timeout: worth another try.
      lastProblem = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (res.ok) {
      if (!quick) failuresInARow = 0;
      return parser.parse(await res.text());
    }

    const text = await res.text().catch(() => '');
    const problem = `LiDAT request failed (${res.status}) for ${account.label} ${pathSuffix}: ${text.slice(0, 300)}`;
    // A bad request, wrong login or unknown machine won't fix itself.
    if (!RETRYABLE_STATUS.has(res.status)) throw new Error(problem);
    lastProblem = problem;
  }
  if (!quick) failuresInARow++;
  throw new LidatUnavailableError(
    `${lastProblem} (gave up after ${delays.length + 1} attempts)`,
  );
}

function parseEquipmentHeader(eq: any): Pick<
  LidatEquipment,
  'oemName' | 'model' | 'equipmentId' | 'serialNumber'
> {
  const h = eq?.EquipmentHeader ?? {};
  return {
    oemName: String(h.OEMName ?? ''),
    model: String(h.Model ?? ''),
    equipmentId: String(h.EquipmentID ?? ''),
    serialNumber: String(h.SerialNumber ?? ''),
  };
}

/**
 * Parse the ISO 15143-3 <Location> block (last known GPS position).
 * Lat/Long/Altitude are child elements; the timestamp may arrive either as a
 * `datetime` attribute (as FuelUsed does) or a <DateTime> child, so we accept both.
 */
/**
 * Parse a single <Location> node (lat/long/altitude + timestamp). The timestamp
 * may arrive as a `datetime` attribute (as FuelUsed does) or a <DateTime> child.
 * Returns null for missing / non-numeric coordinates so we never plot (0,0).
 */
function parseLocationNode(
  loc: any,
): { latitude: number; longitude: number; altitude?: number; dateTime?: string } | null {
  if (!loc) return null;
  const lat = loc.Latitude !== undefined ? Number(loc.Latitude) : undefined;
  const lon = loc.Longitude !== undefined ? Number(loc.Longitude) : undefined;
  if (lat === undefined || lon === undefined || Number.isNaN(lat) || Number.isNaN(lon)) {
    return null;
  }
  const dt = loc['@_datetime'] ?? loc['@_DateTime'] ?? loc.DateTime;
  return {
    latitude: lat,
    longitude: lon,
    altitude: loc.Altitude !== undefined ? Number(loc.Altitude) : undefined,
    dateTime: dt !== undefined ? String(dt) : undefined,
  };
}

function parseLocation(eq: any): Pick<
  LidatEquipment,
  'latitude' | 'longitude' | 'altitude' | 'locationTime'
> {
  const node = parseLocationNode(toArray(eq?.Location)[0]);
  if (!node) return {};
  return {
    latitude: node.latitude,
    longitude: node.longitude,
    altitude: node.altitude,
    locationTime: node.dateTime,
  };
}

/** Pull all pages of the current fleet snapshot for one AEMP account. */
export async function fetchFleetSnapshot(account: LidatAccount): Promise<LidatEquipment[]> {
  const out: LidatEquipment[] = [];
  let page = 1;
  const maxPages = 100; // safety bound

  while (page <= maxPages) {
    const doc = await fetchXml(account, `/Aemp2/Fleet/${page}`);
    const fleet = doc?.Fleet ?? doc;
    const equipment = toArray(fleet?.Equipment);
    if (equipment.length === 0) break;

    for (const eq of equipment) {
      const header = parseEquipmentHeader(eq);
      if (!header.serialNumber) continue;
      const fuelUsed = toArray(eq?.FuelUsed)[0];
      const fuelRemaining = toArray(eq?.FuelRemaining)[0];
      const operating = toArray(eq?.CumulativeOperatingHours)[0];
      const idle = toArray(eq?.CumulativeIdleNonOperatingHours)[0];
      out.push({
        ...header,
        fuelTankCapacity: fuelRemaining?.FuelTankCapacity
          ? Number(fuelRemaining.FuelTankCapacity)
          : undefined,
        fuelConsumedCum: fuelUsed?.FuelConsumed !== undefined ? Number(fuelUsed.FuelConsumed) : undefined,
        fuelUnits: fuelUsed?.FuelUnits ? String(fuelUsed.FuelUnits) : undefined,
        // DateTime is a `datetime` attribute on the FuelUsed element.
        fuelDateTime: fuelUsed?.['@_datetime'] ? String(fuelUsed['@_datetime']) : undefined,
        // Cumulative engine hours and the idle subset of them (both <Hour>).
        operatingHours: operating?.Hour !== undefined ? Number(operating.Hour) : undefined,
        idleHours: idle?.Hour !== undefined ? Number(idle.Hour) : undefined,
        hoursTime: operating?.['@_datetime'] ? String(operating['@_datetime']) : undefined,
        fuelRemainingPercent: parsePercent(fuelRemaining?.Percent),
        fuelRemainingTime: fuelRemaining?.['@_datetime'] ? String(fuelRemaining['@_datetime']) : undefined,
        ...parseLocation(eq),
      });
    }

    // Stop if fewer than a full page (100) was returned.
    if (equipment.length < 100) break;
    page++;
  }

  return out;
}

/**
 * Cumulative fuel-used time series for one machine over [start, end].
 * LiDAT only serves up to 14 days in the past, so callers should chunk longer ranges.
 */
export async function fetchCumulativeFuelUsed(
  account: LidatAccount,
  machine: { oemName: string; model: string; serialNumber: string },
  startUtc: string,
  endUtc: string,
): Promise<LidatFuelReading[]> {
  const out: LidatFuelReading[] = [];
  let page = 1;
  const maxPages = 100;
  const make = encodeSegment(machine.oemName || 'Liebherr');
  const model = encodeSegment(machine.model);
  const serial = encodeSegment(machine.serialNumber);

  while (page <= maxPages) {
    const suffix = `/Aemp2/Fleet/Equipment/${make}/${model}/${serial}/CumulativeFuelUsed/${startUtc}/${endUtc}/${page}`;
    const doc = await fetchXml(account, suffix);
    // Time-data root is <FuelUsedMessages> with <FuelUsed> children directly.
    const root = doc?.FuelUsedMessages ?? doc?.Fleet ?? doc;
    const readings = toArray(root?.FuelUsed);

    if (readings.length === 0) break;
    for (const r of readings) {
      const dt = r?.['@_datetime'];
      if (dt === undefined || r?.FuelConsumed === undefined) continue;
      out.push({
        dateTime: String(dt),
        fuelConsumedCum: Number(r.FuelConsumed),
        fuelUnits: r.FuelUnits ? String(r.FuelUnits) : undefined,
      });
    }
    if (readings.length < 100) break;
    page++;
  }

  return out;
}

/**
 * GPS position time series for one machine over [start, end] (ISO 15143-3 Locations).
 * Same 14-day-window limit as the fuel series, so callers chunk longer ranges.
 */
export async function fetchLocationHistory(
  account: LidatAccount,
  machine: { oemName: string; model: string; serialNumber: string },
  startUtc: string,
  endUtc: string,
): Promise<LidatLocationReading[]> {
  const out: LidatLocationReading[] = [];
  let page = 1;
  const maxPages = 100;
  const make = encodeSegment(machine.oemName || 'Liebherr');
  const model = encodeSegment(machine.model);
  const serial = encodeSegment(machine.serialNumber);

  while (page <= maxPages) {
    const suffix = `/Aemp2/Fleet/Equipment/${make}/${model}/${serial}/Locations/${startUtc}/${endUtc}/${page}`;
    const doc = await fetchXml(account, suffix);
    // Time-data root varies by version; accept the common roots and pull <Location> children.
    const root = doc?.LocationMessages ?? doc?.Locations ?? doc?.Fleet ?? doc;
    const nodes = toArray(root?.Location);

    if (nodes.length === 0) break;
    for (const n of nodes) {
      const parsed = parseLocationNode(n);
      if (!parsed || parsed.dateTime === undefined) continue;
      out.push({
        dateTime: parsed.dateTime,
        latitude: parsed.latitude,
        longitude: parsed.longitude,
        altitude: parsed.altitude,
      });
    }
    if (nodes.length < 100) break;
    page++;
  }

  return out;
}

/**
 * Cumulative hours time series for one machine over [start, end].
 *
 * `urlMetric` is the AEMP2 endpoint path segment; `elementName` is the XML
 * element/root base name (defaults to urlMetric). They MATCH for operating
 * hours, but the idle endpoint mismatches: URL `CumulativeNonProductiveIdleHours`
 * (capital P) vs element `<CumulativeNonproductiveIdleHours>` (lower p), wrapped
 * in `<CumulativeNonproductiveIdleHoursMessages>`. Each node holds an `<Hour>`
 * value + a `datetime` attribute. LiDAT serves at most 14 days in the past.
 */
export async function fetchCumulativeHours(
  account: LidatAccount,
  machine: { oemName: string; model: string; serialNumber: string },
  urlMetric: 'CumulativeOperatingHours' | 'CumulativeNonProductiveIdleHours',
  startUtc: string,
  endUtc: string,
  elementName: string = urlMetric,
): Promise<LidatHourReading[]> {
  const out: LidatHourReading[] = [];
  let page = 1;
  const maxPages = 100;
  const make = encodeSegment(machine.oemName || 'Liebherr');
  const model = encodeSegment(machine.model);
  const serial = encodeSegment(machine.serialNumber);

  while (page <= maxPages) {
    const suffix = `/Aemp2/Fleet/Equipment/${make}/${model}/${serial}/${urlMetric}/${startUtc}/${endUtc}/${page}`;
    const doc = await fetchXml(account, suffix);
    // Pull the per-metric children (each holds an <Hour> value + `datetime` attr).
    const root = doc?.[`${elementName}Messages`] ?? doc?.Fleet ?? doc;
    const nodes = toArray(root?.[elementName]);

    if (nodes.length === 0) break;
    for (const n of nodes) {
      const dt = n?.['@_datetime'];
      const hour = n?.Hour;
      if (dt === undefined || hour === undefined) continue;
      out.push({ dateTime: String(dt), hours: Number(hour) });
    }
    if (nodes.length < 100) break;
    page++;
  }

  return out;
}

/**
 * Tank fill-level time series for one machine over [start, end] (ISO 15143-3
 * FuelRemainingRatio). Root is <FuelRemainingMessages> with <FuelRemaining>
 * children, each carrying a `datetime` attribute and a <Percent> value. Same
 * 14-day window limit as the other time series.
 */
export async function fetchFuelRemaining(
  account: LidatAccount,
  machine: { oemName: string; model: string; serialNumber: string },
  startUtc: string,
  endUtc: string,
): Promise<LidatLevelReading[]> {
  const out: LidatLevelReading[] = [];
  let page = 1;
  const maxPages = 100;
  const make = encodeSegment(machine.oemName || 'Liebherr');
  const model = encodeSegment(machine.model);
  const serial = encodeSegment(machine.serialNumber);

  while (page <= maxPages) {
    const suffix = `/Aemp2/Fleet/Equipment/${make}/${model}/${serial}/FuelRemainingRatio/${startUtc}/${endUtc}/${page}`;
    const doc = await fetchXml(account, suffix);
    const root = doc?.FuelRemainingMessages ?? doc?.Fleet ?? doc;
    const nodes = toArray(root?.FuelRemaining);

    if (nodes.length === 0) break;
    for (const n of nodes) {
      const dt = n?.['@_datetime'];
      const percent = parsePercent(n?.Percent);
      if (dt === undefined || percent === undefined) continue;
      out.push({ dateTime: String(dt), percent });
    }
    if (nodes.length < 100) break;
    page++;
  }

  return out;
}

export interface LidatAccountHealth {
  label: string;
  ok: boolean;
  message: string;
}

/** Probe every configured AEMP account. `ok` is true only if all accounts pass. */
export async function lidatHealth(): Promise<{
  ok: boolean;
  message: string;
  accounts: LidatAccountHealth[];
}> {
  const accounts = await Promise.all(
    config.lidat.accounts.map(async (account): Promise<LidatAccountHealth> => {
      try {
        const doc = await fetchXml(account, '/Aemp2/Fleet/1', { quick: true });
        const fleet = doc?.Fleet ?? doc;
        const count = toArray(fleet?.Equipment).length;
        return { label: account.label, ok: true, message: `Fleet page 1 returned ${count} machine(s)` };
      } catch (err) {
        return {
          label: account.label,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  const ok = accounts.every((a) => a.ok);
  const message = ok
    ? `${accounts.length} account(s) OK: ${accounts.map((a) => `${a.label} (${a.message})`).join('; ')}`
    : `Failing: ${accounts.filter((a) => !a.ok).map((a) => `${a.label} — ${a.message}`).join('; ')}`;
  return { ok, message, accounts };
}
