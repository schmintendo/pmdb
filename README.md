# pmdb.fyi

A dark React + TanStack Table website with uploads, a Node.js API, and SQLite storage. Exactly ten columns:

1. Server Name — the hostname supplied in the upload form
2. Processor name — YABS
3. Core count — YABS
4. Processor MHz — YABS
5. RAM — YABS, displayed in GiB
6. SWAP — YABS, displayed in GiB
7. Total storage — YABS, displayed in TiB
8. Datacenter — the prefix before the first regular hyphen in the hostname
9. KVM — ✓ for KVM, × for NONE, or — when unknown
10. Intel QuickSync — Yes/No, chosen manually during upload

`le4-0-105-238louhi.pulsedmedia.com` produces `le4`; `lt5-1-58-111alue.pulsedmedia.com` produces `lt5`. Hostnames are lowercased, with an optional trailing dot removed. A hostname without a hyphen displays Unknown for datacenter.

## Try it locally (Node.js 24 or newer)

Extract into a new folder; this version replaces the static JSON catalog. It starts with an empty database. It does not import the old inventory examples.

Open a terminal in the folder containing package.json:

```sh
npm install
```

Copy `.env.example` to `.env`. In PowerShell:

```powershell
Copy-Item .env.example .env
```

On Linux:

```sh
cp .env.example .env
chmod 600 .env
```

Generate your upload key:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Replace the placeholder after `UPLOAD_TOKEN=` in `.env` with that value. Keep it private. The same key is entered in the website's upload form; the browser does not save it in local storage. Uploads are disabled when the environment variable is missing. The example placeholder and keys shorter than 24 characters are rejected at startup. A memorable passphrase of several unrelated words can be easier to share with your Discord members while meeting this length requirement.

Then run:

```sh
npm run dev
```

Open the Vite localhost URL, usually http://127.0.0.1:5173. This starts both the frontend and the API on localhost. Ctrl+C stops them. Node.js 24+ is required for the built-in SQLite backend.

## Upload a server

Generate JSON on the server being cataloged:

```sh
curl -sL yabs.sh | bash -s -- -figw yabs.json
```

Download `yabs.json` to your computer. In the website, choose **Upload YABS**, enter the full server hostname, choose the file, select Intel QuickSync Yes or No, and enter your upload key. Save the server. The database is updated immediately and the table reloads. There is no GitHub commit or redeploy involved.

Standard YABS text output is also accepted in `.txt` or `.log` files, provided it includes Processor, CPU cores, RAM, and Disk lines. JSON is preferred for precision. The file is read as text and parsed; it is never executed or installed on the VM. An intentionally fictional upload fixture is included at `examples/yabs-example.json`.

Re-uploading the same normalized hostname requires **Replace existing server with this name**. That updates its hardware values and manually chosen Intel QuickSync value. There is one current row per hostname; this version does not retain benchmark history. Other visitors see new data when they reload or click Refresh.

Intel QuickSync is a manual assertion, not verification that the GPU is exposed or usable. YABS cores are the logical cores/vCPUs it reports. Frequency is the value YABS reports, not a live clock measurement; unknown frequency is shown as a dash. Storage follows YABS's mounted-filesystem total, not an independent physical-drive inventory. Its legacy JSON `disk_units: "KB"` comes from df's default 1024-byte blocks and is interpreted accordingly. RAM, SWAP, and storage are stored numerically in bytes and sorted numerically.

## KVM status

The sortable **KVM** column reads the `os.vm` field from YABS JSON:

| YABS report | KVM column | API value |
| --- | --- | --- |
| `"os": { "vm": "KVM" }` | ✓ | `"kvm": true` |
| `"os": { "vm": "NONE" }` | × | `"kvm": false` |
| Missing or unrecognized VM type | — | `"kvm": null` |

Matching ignores case and surrounding spaces. The CPU's `virt` flag is not
used: it reports virtualization support rather than whether this node is
running under KVM. Standard text uploads can supply a `VM Type : KVM` or
`VM Type : NONE` line as well. Other hypervisor names remain unclassified in
this KVM-specific column. The symbols have accessible text labels and tooltips.

Existing records initially show **—** because earlier uploads did not retain
VM information. Re-upload the YABS file with **Replace existing server with
this name**, or replace the full row through the raw API with an explicit
`kvm` value, to populate it. Merely refreshing cannot recover discarded data.

## Submit a row directly with the API

You can submit one server as JSON without a YABS file:

```text
POST https://pmdb.fyi/api/servers/raw
Content-Type: application/json
Authorization: Bearer YOUR_UPLOAD_KEY
```

Save your row as `server-row.json`. An example is included at
`examples/server-row.json`:

```json
{
  "serverName": "le4-0-105-238louhi.pulsedmedia.com",
  "processorName": "Intel(R) Core(TM) i7-12700",
  "coreCount": 20,
  "processorMhz": 2100,
  "ramGiB": 32,
  "swapGiB": 8,
  "storageTiB": 4,
  "qsv": true,
  "kvm": false,
  "replace": false
}
```

Submit from Linux/macOS with the same upload key used by the website:

```sh
read -rsp 'Upload key: ' PMDB_UPLOAD_KEY
printf '\n'
curl --fail-with-body --show-error \
  --request POST 'https://pmdb.fyi/api/servers/raw' \
  --header "Authorization: Bearer $PMDB_UPLOAD_KEY" \
  --header 'Content-Type: application/json' \
  --data-binary @server-row.json
unset PMDB_UPLOAD_KEY
```

For the included example, use `--data-binary @examples/server-row.json`. In
PowerShell, use `curl.exe` and supply the same URL, headers, and JSON file.

| Field | Required | Format |
| --- | --- | --- |
| `serverName` | Yes | Hostname; normalized to lowercase |
| `processorName` | Yes | Nonempty text, at most 300 characters |
| `coreCount` | Yes | Positive integer (reported logical cores/vCPUs) |
| `processorMhz` | No | Positive number in MHz; omit or use `null` if unknown |
| `ramGiB` | Yes | Positive number in GiB |
| `swapGiB` | No | Nonnegative number in GiB; `0` means no swap, omitted/`null` means unknown |
| `storageTiB` | Yes | Nonnegative number in TiB |
| `qsv` | Yes | JSON `true` or `false` for Intel QuickSync |
| `kvm` | No | JSON `true` for KVM, `false` for NONE; omitted/`null` means unknown |
| `replace` | No | Boolean, defaults to `false` |

Numeric fields must be JSON numbers, not quoted strings or values with units.
Capacities accept decimals and are rounded to the nearest byte, within the
safe integer range. No extra fields or arrays are accepted. Datacenter and
the highlighted friendly name continue to be derived from the hostname.

New rows return HTTP `201` and `{"replaced":false,"serverName":"..."}`.
Submitting an existing hostname returns `409` unless you set `"replace": true`.
Replacement returns `200` with `"replaced":true`. Replacement supplies the
entire row; it is not a partial edit, and omitted optional values become
unknown. `replace: true` also creates a row if the hostname does not yet exist.
YABS uploads and direct rows refer to the same records, so either method can
explicitly replace a row created by the other method.

Invalid fields or malformed JSON return `400`; an invalid/missing upload key
returns `401`; wrong content type returns `415`; oversized requests return
`413`; rate limiting returns `429`; disabled uploads return `503`. Errors have
the JSON shape `{"error":"..."}`. Both submission endpoints share the same
authentication, request/depth limits and rate-limit bucket. Reads remain
public. These manually supplied values are validated but not independently
verified against hardware. Click Refresh on the website to see the row.

The existing `POST /api/servers` YABS endpoint and website upload form work as
before. This addition is for scripts, curl, or other API clients; it does not
add a manual-entry form to the website.

To deploy the current version on an existing installation, follow the KVM
update instructions below. New raw clients can supply `kvm`; older clients
that omit it still work and store an unknown status. Full-row replacement
without `kvm` also resets that status to unknown, like the other optional fields.

## Updating to the KVM column

1. Back up your existing SQLite database with `npm run backup`.
2. Copy the updated application files into your project while keeping your
   existing `.env` and database. In particular, deploy the YABS parser, raw
   parser, database module, frontend entry and `src/upload.css` together.
3. Run `npm run build` to rebuild the table.
4. Restart the running Node process to load the backend changes. For an
   interactive `npm start` session, stop it with Ctrl+C and run `npm start`
   again. For systemd or another process manager, restart the app's service.
5. Hard-refresh the website. Re-upload older records to populate KVM status.

On startup, SQLite automatically gains a nullable `kvm` column without
deleting existing rows. Its values are `1`, `0`, or `NULL`. No new dependencies
or Caddy changes are needed. Docker installations instead deploy with
`docker compose up -d --build`, which builds the frontend and restarts the app.

## Deploy on a Linux VM with Docker Compose

Install Docker Engine and the Compose plugin on your VM. Create `.env` and an upload key as above, then:

```sh
docker compose up -d --build
```

The app listens on **127.0.0.1:3000** on the VM. The named Docker volume `catalog-data` persists SQLite across restarts and container rebuilds. Do not use `docker compose down -v` unless you intend to delete the database.

Put Caddy or your existing reverse proxy in front of it. `Caddyfile.example` contains a hostname, a request size limit, and a reverse proxy to localhost:3000. Replace the example hostname with yours, point DNS at the VM, and load that configuration in Caddy. With correct DNS and ports 80/443 reachable, Caddy can obtain and renew HTTPS certificates. Expose only the reverse proxy, not the Node port.

The container runs as a nonroot user, drops Linux capabilities, has no-new-privileges enabled, uses a read-only root filesystem, and has memory/process limits. SQLite's data volume remains writable. The production container does not contain frontend build dependencies.

After changing application code, run `docker compose up -d --build` again. Uploading a server never requires rebuilding the container.

## Deploy without Docker

Install Node.js 24+, then:

```sh
npm ci
npm run build
npm start
```

Open http://127.0.0.1:3000 locally, or put the same HTTPS reverse proxy in front of it. Run it as a dedicated, unprivileged OS user under systemd or your process manager; give that user write access only to its database directory. Do not run the Node process as root. `HOST` defaults to loopback, `PORT` to 3000; both can be set in `.env`.

This VM edition needs a Node process and writable storage. GitHub Pages cannot host the backend. The previous Pages deployment workflow has been removed.

## Updating from the previous VM edition

Back up your database first. Replace the application files while keeping your existing `.env` and database (or Docker data volume), then rebuild/restart the app. Startup automatically adds the SWAP column without deleting records. Older rows show a dash for SWAP until re-uploaded. Zero swap displays as 0 GiB.

## Persistence and backups

The default file is `data/servers.sqlite`; set `DATABASE_PATH` to use another location. No database setup or SQL credentials are required. SQLite has no network listener or database port to expose. New database files use mode 0600 on Linux; new data directories use mode 0700. Keep the database on a local disk rather than a shared network filesystem.

For a native deployment, create a consistent online backup:

```sh
npm run backup -- backups/catalog.sqlite
```

Choose a new destination filename each time; existing backups are not overwritten. The helper uses SQLite VACUUM INTO, which includes committed WAL data. Do not just copy the active .sqlite file while the app is writing.

For Docker, stop the catalog and copy the database from the stopped container's volume:

```sh
docker compose stop catalog
docker compose cp catalog:/app/data/servers.sqlite ./catalog-backup.sqlite
docker compose start catalog
```

For restore, stop the app, preserve the existing database, and restore a backup into the same data directory with ownership matching the app user. When replacing a database, remove its old `-wal` and `-shm` sidecars only while the app is stopped. Keep backups off the VM and restrict access to them.

## Internet-facing protections

- Uploads require a server-side bearer key. It is checked with a constant-time comparison, excluded from the frontend bundle, and not written to browser storage or logs. Reads are public by design; anyone who can reach the site can read the ten displayed fields.
- Each API submission endpoint accepts only its expected fields, with a real boolean for Intel QuickSync. Hostnames, required hardware fields, units, numbers, and lengths are validated server-side. Direct row submissions use explicit GiB/TiB field names and strict JSON number types. Unknown YABS fields are ignored; only the extracted hardware fields and timestamps are persisted. Original upload files and unrelated YABS output are not kept.
- JSON request bodies are limited to 1 MiB, JSON nesting to 32 levels, and the browser file chooser to 800 KiB. HTTP request/header timeouts are configured. Native JSON parsing is used; there is no eval, shell execution, or downloading URLs supplied by users.
- Upload attempts are limited to 30 per source connection IP per 10 minutes, including failed authentication. Forwarded IP headers are not trusted. Behind a reverse proxy, clients share that proxy's bucket. Limits are in memory and reset on restart; this is basic abuse protection, not protection from a large distributed attack.
- Every SQL value uses a prepared statement. Only fixed application SQL runs. SQLite strict columns, transactions, uniqueness, and duplicate-upload checks protect data consistency. SQLite schema trust is disabled.
- The static server serves only dist/. Credentials, server source, and SQLite files cannot be downloaded through it. API responses use no-store, security headers, and a restrictive content security policy. The UI renders uploaded text through React's escaped text nodes, never as HTML. Cross-origin access is not enabled.
- The Docker and proxy configuration provides a deployment starting point. HTTPS, VM updates, dependency updates, backups, and key rotation remain operational responsibilities. No audit establishes that an app is invulnerable.

If many people need independent access or anonymous public uploads, replace the shared key with user accounts and roles. For trusted administrators, the shared upload key keeps this version small. Changing UPLOAD_TOKEN and restarting the app rotates it.

## Verification

```sh
npm test
npm run build
npm audit
```

The tests exercise YABS and direct row parsing, KVM detection and migration, both datacenter examples, numeric conversions, invalid data, authentication, cross-format replacements, duplicates, persistence, size/depth limits, shared rate limiting, and isolation of credentials/database files. The code includes example deployment files; an actual VM, domain, and Docker deployment must be verified in your environment.
