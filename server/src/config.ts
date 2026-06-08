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
    baseUrl: required('LIDAT_BASE_URL').replace(/\/+$/, ''),
    username: required('LIDAT_USERNAME'),
    password: required('LIDAT_PASSWORD'),
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
} as const;
