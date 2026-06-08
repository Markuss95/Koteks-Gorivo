import fs from 'node:fs';
import tls from 'node:tls';
import { Agent } from 'undici';
import { config } from '../config.js';

// The Maris TLS endpoint sends only its leaf certificate (missing intermediate),
// which Node's fetch rejects (UNABLE_TO_VERIFY_LEAF_SIGNATURE). We build a
// dispatcher that trusts Node's default roots plus the bundled Sectigo intermediate.
let marisDispatcher: Agent | undefined;
function getDispatcher(): Agent {
  if (marisDispatcher) return marisDispatcher;
  const ca: string[] = [...tls.rootCertificates];
  if (fs.existsSync(config.maris.caFile)) {
    ca.push(fs.readFileSync(config.maris.caFile, 'utf-8'));
  }
  marisDispatcher = new Agent({ connect: { ca } });
  return marisDispatcher;
}

export interface MarisItem {
  SKL_SIFRA: string;
  SKL_NAZIV: string;
  GODINA: string;
  DOK_SIFRA: string;
  DOK_NAZIV: string;
  DOK_BROJ: number;
  DATUM: string; // ISO 8601
  RNALOG: string;
  POSP: string;
  NAZIV_PPO: string;
  RBR_STAVKE: number;
  ART_SIFRA: string;
  ART_NAZIV: string;
  JMJ: string;
  KOLICINA: number;
  CIJENA: number;
  VRIJEDNOST: number;
}

interface MarisResponse {
  status: string;
  totalCount: number;
  limit: number;
  offset: number;
  items: MarisItem[];
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const basic = Buffer.from(`${config.maris.clientId}:${config.maris.clientSecret}`).toString(
    'base64',
  );
  const url = `${config.maris.baseUrl}/maris/MARIS/oauth/token`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    dispatcher: getDispatcher(),
  } as RequestInit);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Maris token request failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

/** Format a Date (or ISO string) as dd.mm.yyyy for Maris URL params. */
export function toMarisDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export interface MarisQuery {
  datumOd: string; // dd.mm.yyyy
  datumDo: string; // dd.mm.yyyy
  artikl?: string;
  rnalog?: string;
  rowCount?: number; // 0 = all
  rowOffset?: number;
}

export async function marisFetchItems(q: MarisQuery): Promise<MarisItem[]> {
  const token = await getToken();
  const params = new URLSearchParams();
  params.set('p_datum_od', q.datumOd);
  params.set('p_datum_do', q.datumDo);
  if (q.artikl) params.set('p_artikl', q.artikl);
  if (q.rnalog) params.set('p_rnalog', q.rnalog);
  params.set('row_count', String(q.rowCount ?? 0));
  if (q.rowOffset !== undefined) params.set('row_offset', String(q.rowOffset));

  const url = `${config.maris.baseUrl}/maris/MARIS/maris_api_skladisno/rekap_dok_stavke?${params.toString()}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    dispatcher: getDispatcher(),
  } as RequestInit);

  if (res.status === 401) {
    // Token may have expired early — clear and retry once.
    cachedToken = null;
    const retryToken = await getToken();
    const retry = await fetch(url, {
      headers: { Authorization: `Bearer ${retryToken}` },
      dispatcher: getDispatcher(),
    } as RequestInit);
    if (!retry.ok) {
      const text = await retry.text().catch(() => '');
      throw new Error(`Maris query failed (${retry.status}): ${text}`);
    }
    return ((await retry.json()) as MarisResponse).items ?? [];
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Maris query failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as MarisResponse;
  return data.items ?? [];
}

/** Lightweight connectivity/credentials check. */
export async function marisHealth(): Promise<{ ok: boolean; message: string }> {
  try {
    await getToken();
    return { ok: true, message: 'Token acquired' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
