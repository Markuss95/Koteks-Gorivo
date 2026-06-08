# Koteks Gorivo — Maris vs LiDAT fuel comparison

Web app to compare fuel **issued** from the Maris ERP warehouse against fuel **actually consumed**
by Liebherr machines, reported by LiDAT telematics (ISO/TS 15143-3).

## How it works

- **Maris** (JSON REST, OAuth2 client-credentials) provides fuel issuance records (`izdatnica`) per
  work order (`RNALOG`). Full history is queryable on demand.
- **LiDAT** (XML, HTTP Basic auth) provides each machine's **cumulative** fuel consumption, but only
  for the **last 14 days**. A scheduled backend sync stores readings over time so any past period can
  be compared.
- Machines are matched by **serial number → RNALOG** via [`machine-rnalog-mapping.json`](machine-rnalog-mapping.json).
- Period consumption from LiDAT = (cumulative reading at end) − (cumulative reading before start).

## Structure

```
server/   Node + Express + TypeScript backend (API proxy, SQLite store, scheduled sync)
web/      Vite + React + TypeScript frontend
machine-rnalog-mapping.json   Machine ↔ work-order mapping (seeded into the DB)
Documentation/                API PDFs + credentials — git-ignored, never committed
```

## Setup

Requires Node 18+.

```bash
npm install                      # installs both workspaces
cp server/.env.example server/.env   # then fill in Maris + LiDAT credentials
npm run dev                      # runs backend (:4000) and frontend (:5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend.

### Credentials

All secrets live in `server/.env` (git-ignored). See `server/.env.example` for the variables:
`MARIS_*`, `LIDAT_*`, `LIDAT_SYNC_CRON`, `FUEL_ARTICLE_CODES`.

## Backend API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/health` | Maris/LiDAT connectivity, DB stats, last sync |
| GET | `/api/machines` | Machines + mapping + LiDAT reading counts |
| GET | `/api/machines/:serial/series?from&to` | LiDAT cumulative series + Maris issuances |
| GET | `/api/comparison?from&to` | Per-machine + fleet comparison for a date range |
| POST | `/api/sync` | Trigger a LiDAT sync now |
| GET | `/api/sync/status` | Recent sync logs |
| GET/PUT | `/api/settings` | Fuel article codes |

## Production build

```bash
npm run build
npm start           # serves the API; build & host web/ behind any static server / reverse proxy
```

## Notes

- The first comparison over a period older than ~14 days will show LiDAT data only once the sync has
  been running long enough to have stored readings spanning that period.
- `lidatPartial` flag on a row means there was no stored reading before the range start, so consumption
  is a lower bound for that machine/period.
