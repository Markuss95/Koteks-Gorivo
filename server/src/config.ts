import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

// Resolve DB_PATH relative to the server package root (one level up from src/dist).
const serverRoot = path.resolve(__dirname, '..');
const dbPathRaw = optional('DB_PATH', './data/koteks-gorivo.db');

/** One LiDAT AEMP login. Each login exposes its own (disjoint) fleet scope. */
export interface LidatAccount {
  label: string;
  baseUrl: string;
  username: string;
  password: string;
}

/**
 * Build the list of LiDAT accounts. The primary account comes from
 * LIDAT_USERNAME/LIDAT_PASSWORD (+ LIDAT_BASE_URL). Additional accounts are read
 * from numbered suffixes LIDAT_USERNAME_2/LIDAT_PASSWORD_2, _3, ... — each may
 * override the base URL (LIDAT_BASE_URL_2) and set a label (LIDAT_LABEL_2),
 * otherwise it reuses the shared base URL. Enumeration stops at the first gap.
 */
function buildLidatAccounts(): LidatAccount[] {
  const baseUrl = required('LIDAT_BASE_URL').replace(/\/+$/, '');
  const accounts: LidatAccount[] = [
    {
      label: optional('LIDAT_LABEL', 'primary'),
      baseUrl,
      username: required('LIDAT_USERNAME'),
      password: required('LIDAT_PASSWORD'),
    },
  ];
  for (let i = 2; ; i++) {
    const username = process.env[`LIDAT_USERNAME_${i}`];
    const password = process.env[`LIDAT_PASSWORD_${i}`];
    if (!username || !password) break;
    accounts.push({
      label: optional(`LIDAT_LABEL_${i}`, `account-${i}`),
      baseUrl: optional(`LIDAT_BASE_URL_${i}`, baseUrl),
      username,
      password,
    });
  }
  return accounts;
}

export const config = {
  port: Number(optional('PORT', '4000')),
  dbPath: path.isAbsolute(dbPathRaw) ? dbPathRaw : path.resolve(serverRoot, dbPathRaw),
  serverRoot,

  maris: {
    baseUrl: required('MARIS_BASE_URL').replace(/\/+$/, ''),
    clientId: required('MARIS_CLIENT_ID'),
    clientSecret: required('MARIS_CLIENT_SECRET'),
    // The Maris server omits the intermediate CA in its TLS chain; supply it here
    // so Node can verify (the matching root is already in Node's bundle).
    caFile: path.isAbsolute(optional('MARIS_CA_FILE', './certs/sectigo-intermediate.pem'))
      ? optional('MARIS_CA_FILE', './certs/sectigo-intermediate.pem')
      : path.resolve(serverRoot, optional('MARIS_CA_FILE', './certs/sectigo-intermediate.pem')),
  },

  lidat: {
    // One or more AEMP logins. Each login serves its own (disjoint) set of
    // machines; the sync fetches every account's fleet and routes each machine's
    // time-series queries to the account that owns it.
    accounts: buildLidatAccounts(),
  },

  sync: {
    cron: optional('LIDAT_SYNC_CRON', '0 */6 * * *'),
    onStart: optional('LIDAT_SYNC_ON_START', 'true').toLowerCase() === 'true',
  },

  defaults: {
    fuelArticleCodes: optional('FUEL_ARTICLE_CODES', '06010001')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // Earliest date with reliable LiDAT history (collection start). Comparisons
  // before this are rejected — LiDAT only serves 14 days and we have nothing older.
  dataMinDate: optional('DATA_MIN_DATE', '2026-05-27'),

  // Allowed browser origin for CORS. Empty = allow all (fine for local/dev).
  // In production set to the Netlify site URL, e.g. https://koteks-gorivo.netlify.app
  corsOrigin: optional('CORS_ORIGIN', ''),

  auth: {
    // Secret for signing JWTs. A dev fallback keeps local setup frictionless;
    // production MUST set JWT_SECRET (warned at boot in index.ts).
    jwtSecret: optional('JWT_SECRET', 'dev-insecure-secret-change-me'),
    jwtSecretIsDefault: !process.env.JWT_SECRET,
    tokenTtl: optional('JWT_TTL', '7d'),
    // First admin, seeded on first boot when no users exist yet.
    adminUsername: optional('ADMIN_USERNAME', ''),
    adminPassword: optional('ADMIN_PASSWORD', ''),
  },
} as const;
