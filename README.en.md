# iOS Location Spoofer

**English** · [中文](README.md)

Use the HTTPS-decryption (MITM) feature of a proxy app to trick Apple's location service — and therefore Apple Maps — into placing your iPhone anywhere in the world.

> 📖 **New here?** The step-by-step walkthrough is Chinese-only for now → [使用教程.md](使用教程.md) (install, configure, verify, and troubleshooting).

## Credits

This project builds on the core research of [acheong08/ios-location-spoofer](https://github.com/acheong08/ios-location-spoofer). The original is a standalone iOS app written in Go that spoofs location with a self-hosted VPN + MITM proxy.

This repo re-implements that core logic in JavaScript and adapts it to five proxy platforms — Shadowrocket, Surge, Loon, Quantumult X, and Stash — so there's nothing to compile and no developer account required. Import and go.

### What this port adds over the original

- **Multi-platform support** — from a single iOS app to five proxy apps.
- **Cell-tower coordinate rewriting** — the Go original only rewrote Wi-Fi hotspot coordinates; the JS version also rewrites CellTower coordinates (fields 22/24).
- **Multiple response-format compatibility** — auto-detects Apple's response envelope (ARPC / synthetic / marker / bare) so the rewritten payload is still accepted by iOS.
- **Motion-state spoofing** — also rewrites `motionActivityType` and `motionActivityConfidence` to reduce the chance of detection.

## How it works

Your iPhone reads nearby Wi-Fi and cell signals, then asks Apple where those BSSIDs/towers are. Apple replies with a list of coordinates, and iOS computes its own position from them.

This project intercepts Apple's reply on the way back and rewrites every coordinate to the numbers you chose. iOS receives the altered coordinates and concludes it is exactly where you told it to be.

## Supported apps

| App | File | How to import | Status |
|-----|------|---------------|--------|
| Shadowrocket | `ios-location-spoofer.sgmodule` | Config → top-right `+` | ✅ Verified |
| Surge | `ios-location-spoofer-surge.sgmodule` | Home → Modules → Install New Module | ✅ Verified |
| Loon | `ios-location-spoofer.lnplugin` | Settings → Plugins → Add Plugin | ✅ Verified |
| Quantumult X | `ios-location-spoofer.snippet` | Settings → Rewrite → Add | 🟡 Untested |
| Stash | `ios-location-spoofer.stoverride` | Override → Install Override | ✅ Verified |

> Tested it? Please report results in Issues. If something doesn't work, PRs are welcome — at minimum include **which app, which version, which iOS, and the raw error log**.

## Usage

1. Turn on HTTPS decryption / MITM in your proxy app.
2. Install and trust the CA certificate (Settings → General → VPN & Device Management → install, then Certificate Trust Settings → enable).
3. Import the module file and enable it.
4. Reconnect the VPN and toggle Location Services off/on.
5. Open Maps to verify.

### MITM failed troubleshooting

If the proxy Request List shows `MITM failed`, this usually points to MITM hostname matching or iOS certificate full-trust state, not to the rewrite script having already failed. Please verify:

1. iOS has full trust enabled for the proxy CA under **Settings → General → About → Certificate Trust Settings**.
2. The failing Host in Request List is present in the module's `[MITM] hostname` list. Every module in this project includes `gs-loc.apple.com`, `gs-loc-cn.apple.com`, `gsp-ssl.ls.apple.com`, `bluedot.is.autonavi.com`, and `bluedot.is.autonavi.com.gds.alibabadns.com`.
3. If your log shows another `/clls/wloc` Host, please include the exact Host and path in the issue instead of using broad wildcards such as `*.apple.com` / `*.ls.apple.com`, which may MITM unrelated Apple requests.
4. If it still fails, try disabling QUIC/HTTP3-related options, reconnect the VPN, then toggle Location Services off/on.

### Loon notes

1. After importing `ios-location-spoofer.lnplugin`, open the plugin config page under **Settings → Plugins**.
2. You can enter **latitude / longitude** directly. **Address search** is resolved and cached by a cron task that runs every 15 minutes (for the first run, enter coordinates directly or save an address and wait one cron cycle).
3. You must enable Loon's **MITM** and trust the certificate, and the four domains in the plugin's `[mitm]` block must be active.
4. The plugin includes a **Prepare** request script (sets `Accept-Encoding: identity` to avoid gzip-induced `zip decompress error` / script timeouts).
5. After changing coordinates, toggle Location Services off/on. For debugging, enable **debug logging** and search Loon's log for `Location spoofer`.

> If the log shows `Evaluate script timeout` or `zip decompress error:-3`: update the plugin and reload Loon, and confirm all three scripts (Prepare / Response / Geocode cron) are enabled.

## Changing coordinates

Default is Apple Park (37.3349, -122.00902). Change it in the module arguments:

```
latitude=39.9042&longitude=116.4074
```

| Name | Default | Description |
|------|---------|-------------|
| `latitude` | 37.3349 | Target latitude |
| `longitude` | -122.00902 | Target longitude |
| `address` | (empty) | Address search (entered in the Loon plugin UI; resolved to coordinates online; takes precedence over manual lat/lng) |
| `horizontalAccuracy` | 39 | Horizontal accuracy |
| `verticalAccuracy` | 1000 | Vertical accuracy |
| `altitude` | 530 | Altitude |
| `failOpen` | true | Pass the original data through on error |
| `debug` | false | Debug logging |

## File map

```
ios-location-spoofer.sgmodule       # Shadowrocket
ios-location-spoofer-surge.sgmodule # Surge
ios-location-spoofer.lnplugin       # Loon
ios-location-spoofer.snippet        # Quantumult X
ios-location-spoofer.stoverride     # Stash
location-spoofer.js                 # Core script (shared by four platforms)
location-spoofer-qx.js              # Quantumult X-specific
location-spoofer-config.json        # Config sample
使用教程.md                         # Step-by-step tutorial (Chinese)
location-picker/                    # Optional: web map picker (Node or Cloudflare Worker)
location-picker/db.js               # SQLite layer (tokens / coords / logs / stats)
location-picker/admin.js            # Admin console API
location-picker/admin-page.js       # Admin console page
location-picker/worker/             # Cloudflare Worker version (no VPS; supports Loon configUrl)
location-picker/RAILWAY.md          # Railway deployment guide
```

## Optional: web map location picker

Change location often and tired of looking up coordinates by hand? The bundled [`location-picker/`](location-picker/) tool lets you tap a map to set your location: altitude is filled in automatically and accuracy is adjustable. Loon / Shadowrocket read it via `configUrl`.

**Four deployment options:**

| Option | Directory | Best for |
|--------|-----------|----------|
| **Cloudflare Worker — Wrangler CLI** (recommended) | [`location-picker/worker/`](location-picker/worker/) | No VPS, HTTPS included; comfortable with the CLI |
| **Cloudflare Worker — dashboard** | [`location-picker/cloudflare-webui/`](location-picker/cloudflare-webui/) | No VPS, HTTPS included; no npm/Wrangler — paste a single file |
| **Railway** | [`location-picker/RAILWAY.md`](location-picker/RAILWAY.md) | No VPS, HTTPS domain included; runs the full Node version instead of a Worker |
| Self-hosted Node | [`location-picker/server.js`](location-picker/server.js) | You have your own VPS / NAS |
| Docker | [`location-picker/Dockerfile`](location-picker/Dockerfile) | You have Docker |

Loon plugin **remote config URL** example:

```
https://your-worker.workers.dev/loc.json?token=YOUR_TOKEN
```

## Community

This project welcomes review and feedback from the LINUX DO community: [LINUX DO](https://linux.do)

## location-picker server configuration

`location-picker/server.js` is controlled by environment variables. **Node >= 24 is required** (it uses the built-in `node:sqlite`; still zero npm dependencies).

Tokens, coordinates, and access logs all live in SQLite (`app.db`, next to `DATA_FILE`). **`TOKEN` is now only a bootstrap**: at startup its values are seeded into the database, after which you create / disable / delete tokens from the admin page — effective immediately, no redeploy.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TOKEN` | one of two | none | User access token; must match the `token=` in the `configUrl` at the end of the proxy module's `argument=`. Generate with `openssl rand -hex 24`. **Accepts a comma-separated list** (`TOKEN=t1,t2,t3`); each token gets its own independent coordinates. Only seeded into the DB on first start. |
| `ADMIN_TOKEN` | one of two | empty | Admin console password. **Without it the whole `/admin` path does not exist (404)**, so the console is never advertised. Must differ from every user token or the process refuses to start. |
| `PORT` | No | `8080` | Listen port; ports below 1024 require root. |
| `CERT` | No | empty | HTTPS fullchain certificate path; HTTPS is used only when both `CERT` and `KEY` are set. |
| `KEY` | No | empty | HTTPS private key path; used only when both `CERT` and `KEY` are set. |
| `DATA_FILE` | No | `loc.json` next to `server.js` | Anchors the data directory; the database is created as `app.db` in the same folder. Point it inside a mounted volume (e.g. `/data/loc.json`) on Docker / Railway. |
| `TZ_OFFSET_MIN` | No | `480` | Timezone offset (minutes) used to bucket logs and dashboard stats by day/hour. Defaults to UTC+8. |
| `LOG_RETENTION_MONTHS` | No | `3` | Keep the last N **whole months** plus the current one in the table. Months rather than days, so archive files and the delete boundary line up exactly. |
| `LOG_MAX_ROWS` | No | `500000` | Hard cap on log rows; beyond it the oldest whole days are archived and deleted early. |
| `ARCHIVE_KEEP_MONTHS` | No | `24` | How many monthly archive files to keep; the oldest are removed beyond this. |
| `DAILY_RETENTION_DAYS` | No | `400` | Retention for the `daily` rollup table. It is tiny and kept longer than the raw detail, so pruning detail never breaks the dashboard's trend lines. |

At least one of `TOKEN` / `ADMIN_TOKEN` must be set: with neither, and an empty database, the process exits instead of idling uselessly.

### Admin console

With `ADMIN_TOKEN` set, open `https://your-domain/admin?token=<ADMIN_TOKEN>`. Three tabs:

- **Tokens** — create / rename / disable / delete; each row shows current coordinates, last-seen time, and today's request counts. Two one-tap copy buttons emit a ready-to-paste **Shadowrocket module** and **picker URL** with the token already spliced in (the domain is taken from the request headers, so renaming the service needs no code change).
- **Dashboard** — seven KPIs (total / active / disabled tokens, today's active users, fetches, location changes, errors) plus four charts: 7–30 day trend, today's 24-hour distribution, token activity ranking, and error breakdown. Any single IP with more than 10 `403`s in the window is flagged in red as a likely misconfigured token — **a mistyped token or a stray space in the module is by far the most common failure, and this pinpoints it instantly**.
- **Logs** — filter by token, date range, or errors only; paginated.
- **Archive** — storage overview (database size / log rows / archive total / process memory), range export as `.csv.gz`, archive download and delete, manual archive run, and `VACUUM` to reclaim disk.

**Disabling a token is not a denial of service**: `/loc.json` still returns 200 but with `enabled` set to `false`, so the script passes the original response through and the user gets their **real location back**; the picker page and `/set` return 403. A plain 403 would be worse — when the script cannot fetch the remote config it falls back to the coordinates hardcoded in the module `argument` (Apple Park by default), which looks broken rather than disabled.

The picker page's **place search** and **elevation lookup** rely on Nominatim / open-meteo, neither of which is reachable directly from mainland China. The page tries a direct request first (3.5s timeout) and automatically falls back to the server-side proxy endpoints `GET /geocode` and `GET /elevation` (both token-gated). `/geocode` is throttled to 1 request/second per Nominatim's usage policy and returns 429 beyond that.

### Log archiving

Logs past the retention window are not simply dropped — they are **archived first, deleted second, and only ever deleted once archiving succeeded** (a failed archive is skipped and retried later; wasting disk beats losing data):

1. Each whole month is exported to `<data dir>/archive/logs-YYYY-MM.csv.gz`
2. Only after that export succeeds are that month's rows deleted
3. When `LOG_MAX_ROWS` is exceeded, the granularity drops to whole days, appended to that month's `.gz` (gzip members concatenate, so the file still decompresses as one)

Measured at roughly **10.6 bytes per row** as gzipped CSV — about 12:1 compression. At a 15-user scale a monthly archive is typically 0.5–2 MB.

Both archiving and export walk the table with an id cursor in batches and yield to the event loop between them, so exporting hundreds of thousands of rows still leaves everyone else's `/loc.json` answering in milliseconds.

> SQLite's `DELETE` only marks pages reusable — **the file never shrinks**. In steady state you delete as much as you write, so `app.db` plateaus at the retention-window size instead of growing forever. Only if you deliberately shorten the retention window and want the disk back do you need the admin console's "compact database" button (`VACUUM`, which rewrites the whole file).

The server also exposes `GET /health` (**no token required**) for liveness probes, returning `{"ok":true,"persistent":true,"tokens":11,"admin":true,"rssMB":56,"uptimeMin":120}`.

Startup examples:

```bash
# first run: hand out a single user token
TOKEN=$(openssl rand -hex 24) PORT=8080 node server.js

# with the admin console: add people from the web UI afterwards
TOKEN=$(openssl rand -hex 24) ADMIN_TOKEN=$(openssl rand -hex 24) PORT=8080 node server.js

# https (reuse acme.sh certs; no restart needed on renewal — the process hot-reloads every 12 hours)
TOKEN=$(openssl rand -hex 24) PORT=8443 \
CERT=/root/cert/example.com/fullchain.pem \
KEY=/root/cert/example.com/privkey.pem \
node server.js
```

`app.db` is written next to `DATA_FILE` and is listed in `.gitignore`. **Upgrading from an older version needs no action**: the first start imports the tokens from `TOKEN` and any existing `loc.json` / `loc-<hash>.json` coordinates into the database.

> ⚠️ **Don't put `TOKEN` / `ADMIN_TOKEN` in your shell history.** Prefer systemd's `Environment=` or `.env` + `direnv` to avoid leaking it via `history` / `ps aux`.

### Docker

```bash
cd location-picker
{ echo "TOKEN=$(openssl rand -hex 24)"; echo "ADMIN_TOKEN=$(openssl rand -hex 24)"; } > .env
docker compose up -d
```

Based on `node:24-alpine`. Data volume mounts to current directory. `restart: unless-stopped`.

## Security note

The Cloudflare Worker versions and `server.js` all require a token on every endpoint (including the map page). Token comparison is constant-time, and `server.js` refuses to start without a `TOKEN`. Because MITM decryption sees all traffic to the intercepted Apple endpoints, only enable the module while you actively need it, and keep your CA private key on-device only.

## License

See [LICENSE](LICENSE).
