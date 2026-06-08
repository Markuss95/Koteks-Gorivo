# Deployment — Netlify (frontend) + Render (backend)

This hosts the app so the LiDAT history sync runs **continuously** (the key requirement —
LiDAT only serves 14 days, so the backend must stay running to accumulate longer history).

```
Browser ──> Netlify (React static site) ──HTTPS──> Render (Node API + SQLite on a persistent disk)
                                                      │
                                          every 6h ──> LiDAT + Maris
```

## 0. Prerequisites
- Push this repo to GitHub (or GitLab/Bitbucket).
- Have the Maris + LiDAT credentials ready (currently in `server/.env`, which is git-ignored).

## 1. Backend on Render
1. **New → Blueprint**, select this repo. Render reads [`render.yaml`](render.yaml) and creates:
   - a **Starter** (always-on) web service `koteks-gorivo-api`
   - a **1 GB persistent disk** mounted at `/data` (the SQLite DB lives here, so it survives deploys)
2. When prompted, fill the **secret** env vars (the blueprint marks these `sync:false`):
   - `MARIS_CLIENT_ID`, `MARIS_CLIENT_SECRET`
   - `LIDAT_USERNAME` (e.g. `Osi_Osi_HR\aempservice`), `LIDAT_PASSWORD`
   - `CORS_ORIGIN` — leave blank for now; set it in step 3 once you have the Netlify URL.
3. Deploy. Note the service URL, e.g. `https://koteks-gorivo-api.onrender.com`.
4. Check health: open `https://koteks-gorivo-api.onrender.com/api/health` — `maris.ok` and `lidat.ok`
   should be `true`. The first sync runs on startup; `db.readingCount` should climb.

> **Plan note:** the **Starter** plan (~$7/mo) is required — the Free plan spins down after
> 15 min idle, which would stop the scheduled sync and create gaps. The disk is ~$0.25/GB·mo.

## 2. Frontend on Netlify
1. **Add new site → Import an existing project**, select this repo. Netlify reads
   [`web/netlify.toml`](web/netlify.toml) (base `web`, publish `dist`).
2. Add a build environment variable:
   - `VITE_API_BASE_URL = https://koteks-gorivo-api.onrender.com` (your Render URL from step 1)
3. Deploy. Note the site URL, e.g. `https://koteks-gorivo.netlify.app`.

## 3. Lock CORS to your site
1. Back in Render → the API service → **Environment**, set
   `CORS_ORIGIN = https://koteks-gorivo.netlify.app` and save (it redeploys).
2. Reload the Netlify site — the dashboard should load data from the backend.

## 4. Verify
- Netlify site loads, the two health dots (Maris / LiDAT) are green.
- Over the next days, `readingCount` grows and older date ranges become comparable.

## ⚠️ One thing to confirm: Maris reachability from Render
LiDAT (`lidatexternal.liebherr.com`) is a public service — reachable from Render with no extra
setup. **Maris (`portal.osijek-koteks.hr`) may be restricted to the company network/IP range.**
If `maris.ok` is `false` on Render (but works locally), the portal is likely firewalled:
- On Render Starter you get a **static outbound IP** (service → Settings → Outbound IPs).
- Ask whoever administers the Maris portal to **allow-list that IP**.

## Notes
- The Maris server omits its TLS intermediate cert; the fix (`server/certs/sectigo-intermediate.pem`
  + an undici Agent) is in the code and works on Render too.
- Short outages are self-healing: on restart the backend re-pulls the last ~13 days. Only an outage
  **longer than ~13 days** creates an unrecoverable gap (LiDAT's 14-day limit).
- To change the sync frequency, edit `LIDAT_SYNC_CRON` in Render env (default every 6 hours).
