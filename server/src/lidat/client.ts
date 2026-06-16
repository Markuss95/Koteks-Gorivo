import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';

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

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: true,
  trimValues: true,
});

function basicAuthHeader(): string {
  const token = Buffer.from(`${config.lidat.username}:${config.lidat.password}`).toString('base64');
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

async function fetchXml(pathSuffix: string): Promise<any> {
  const url = `${config.lidat.baseUrl}${pathSuffix}`;
  const res = await fetch(url, {
    headers: { Authorization: basicAuthHeader(), Accept: 'application/xml' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LiDAT request failed (${res.status}) for ${pathSuffix}: ${text.slice(0, 300)}`);
  }
  const xml = await res.text();
  return parser.parse(xml);
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

/** Pull all pages of the current fleet snapshot. */
export async function fetchFleetSnapshot(): Promise<LidatEquipment[]> {
  const out: LidatEquipment[] = [];
  let page = 1;
  const maxPages = 100; // safety bound

  while (page <= maxPages) {
    const doc = await fetchXml(`/Aemp2/Fleet/${page}`);
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
    const doc = await fetchXml(suffix);
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
    const doc = await fetchXml(suffix);
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
 * Cumulative hours time series for one machine over [start, end] for a given
 * AEMP2 metric ('CumulativeOperatingHours' or 'CumulativeIdleNonOperatingHours').
 * Same shape/limits as the fuel series: <Hour> values carry a `datetime` attribute.
 * LiDAT serves at most 14 days in the past, so callers chunk longer ranges.
 */
export async function fetchCumulativeHours(
  machine: { oemName: string; model: string; serialNumber: string },
  metric: 'CumulativeOperatingHours' | 'CumulativeIdleNonOperatingHours',
  startUtc: string,
  endUtc: string,
): Promise<LidatHourReading[]> {
  const out: LidatHourReading[] = [];
  let page = 1;
  const maxPages = 100;
  const make = encodeSegment(machine.oemName || 'Liebherr');
  const model = encodeSegment(machine.model);
  const serial = encodeSegment(machine.serialNumber);

  while (page <= maxPages) {
    const suffix = `/Aemp2/Fleet/Equipment/${make}/${model}/${serial}/${metric}/${startUtc}/${endUtc}/${page}`;
    const doc = await fetchXml(suffix);
    // Time-data root varies by metric/version; accept the common roots and pull
    // the per-metric children (each holds an <Hour> value + `datetime` attribute).
    const root = doc?.[`${metric}Messages`] ?? doc?.Fleet ?? doc;
    const nodes = toArray(root?.[metric]);

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

export async function lidatHealth(): Promise<{ ok: boolean; message: string }> {
  try {
    const doc = await fetchXml('/Aemp2/Fleet/1');
    const fleet = doc?.Fleet ?? doc;
    const count = toArray(fleet?.Equipment).length;
    return { ok: true, message: `Fleet page 1 returned ${count} machine(s)` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
