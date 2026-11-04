# pmdb.fyi

A React + TanStack Table website with uploads, a Node.js API, and SQLite storage. It receives its data from the [yabs.sh](https://github.com/masonr/yet-another-bench-script) uploads that users supply.

Data Fields:

1. Server Name — the hostname supplied in the upload form
2. Processor name — yabs.sh
3. Core count — yabs.sh
4. KVM — ✓ for KVM, × for NONE, or — when unknown
5. Processor MHz — yabs.sh
6. RAM — yabs.sh, displayed in GiB
7. SWAP — yabs.sh, displayed in GiB
8. Total storage — yabs.sh, displayed in TiB
9. Datacenter — the prefix before the first regular hyphen in the hostname.  Realistically all of the nodes are in the [Lauttasaari](https://en.wikipedia.org/wiki/Lauttasaari) datacenter, but the prefix tells us the rack the node is in.
10. Intel QuickSync — Yes for Intel N100 processors (so far), No for other processors

`le4-0-105-238louhi.pulsedmedia.com` produces `le4`; `lt5-1-58-111alue.pulsedmedia.com` produces `lt5`. Hostnames are lowercased, with an optional trailing dot removed. Bare node names such as `lt5-1-58-111alue` automatically receive `.pulsedmedia.com` in both upload APIs. Other complete domains are retained. A hostname without a hyphen displays Unknown for datacenter.

## Try it locally (Node.js 24 or newer)

Extract into a new folder; this version replaces the static JSON catalog. It starts with an empty database. It does not import the old inventory examples.

Open a terminal in the folder containing package.json:

```sh
npm install
```

No `.env` is required. If you want to customize the port or data
paths, copy `.env.example` to `.env`. In PowerShell:

```powershell
Copy-Item .env.example .env
```

On Linux:

```sh
cp .env.example .env
chmod 600 .env
npm run dev
```

Open the Vite localhost URL, usually http://127.0.0.1:5173. This starts both the frontend and the API on localhost. Ctrl+C stops them. Node.js 24+ is required for the built-in SQLite backend.

## Uploading

Generate JSON on the server being cataloged:

```sh
curl -sL yabs.sh | bash -s -- -gw yabs.json
```

This skips Geekbench and includes network and disk I/O benchmarks. Download
`yabs.json` to your computer. Choose **Upload YABS** and supply the server
hostname (a bare node name is accepted), your **submission identifier**, and the
YABS file. **PulsedMedia plan** and **Number of users** are optional. QuickSync
is inferred from the processor; there is no manual selection or upload-key field.
The identifier does not have to be your actual username: choose any nickname
or label and use exactly the same one for all your submissions.

Run this separate command on the node and paste its integer output into
**Number of users**:

```sh
awk -F: '$3 > 1000 && $3 != 65534 {n++} END {print n+0}' /etc/passwd
```

It counts UIDs greater than 1000, excluding `nobody` (UID 65534). Root (UID 0)
and UID 1000 are not counted. Other service accounts above the threshold are
included. This is a reported account count, not currently logged-in sessions.
Zero is valid; leave the field blank if unknown.

Saving updates the table immediately, with no GitHub commit or redeployment.

Standard YABS text output is also accepted in `.txt` or `.log` files, provided
it includes Processor, CPU cores, RAM, and Disk lines. Text uploads populate
hardware and recognizable OS details, but benchmark history is extracted only
from structured JSON. An intentionally fictional fixture is included at
`examples/yabs-example.json`. Uploads are parsed as data and never executed.

There is no authentication or ownership verification. An identifier matches
repeat submissions; it is not proof of identity. Anyone using the same identifier
on the same node can update that entry. Identifiers are not returned in public
API responses or displayed on the node page. The API field remains `username`
for compatibility with existing records and scripts.

## Individual node pages

Click a hostname in the main table to open `/nodes/<hostname>`. Each node page
shows its friendly name (for example `louhi`), full hostname, datacenter,
hardware, OS/kernel/architecture, and the latest reported user count. A visible
**Back to all nodes** control returns to the catalog.

Three panels show aggregated **Pulsed Media plans**, **Historical speed tests**,
and **Historical disk I/O**. Plan counts cover submitting identifiers, not all
accounts on the node, and may differ from the reported user count. The same
identifier on two different nodes is counted independently on each node.

YABS JSON `iperf` and `fio` data is stored with original units and its run
timestamp (`runtime.start`), plus the submission time. If a test was skipped,
no fake result is inserted. `busy` and `failed` network results remain visible.
The JSON does not contain YABS's terminal-only `dd` fallback; if `fio` is absent,
the disk-history panel stays empty. Missing measurements display a dash.
Hardware-only uploads still work. Speed history has one row per run and one
column per provider/location, with Send, Receive and Latency in each cell.
IPv4 and IPv6 results appear in separate tables when present. Columns are built
from the submitted endpoints so a provider change does not discard old results.
Disk history has a date column and 4k, 64k, 512k and 1m columns. Each cell shows
Read, Write and Total throughput alongside their IOPS. YABS `KBps` values remain
KB/s for 4k; the other sizes are converted to MB/s to match YABS's display.
YABS labels fio's KiB/s as `KBps` in JSON: decimal KB/s is `raw × 1024 / 1000`
and MB/s is `raw × 1024 / 1000000`, matching its `format_speed` conversion.
The stored numbers are unchanged. Explicit non-YABS units from raw submissions
are converted according to their declared unit.

Genuinely different runs are appended; repeating identical parsed benchmark
data with the same timestamp and username does not duplicate it. History is
ordered by newest submission. Older history loads automatically as you scroll;
there are no Newer/Older controls or submission-range counter. The API still
supports pages of up to 100 runs. Updating a plan does not erase previous benchmark runs.

As requested, each catalog entry receives its own SQLite file under
`data/nodes/`, using a SHA-256 hostname filename. Existing nodes receive empty
detail databases automatically at startup. Earlier versions discarded OS,
user-count, participant and benchmark data, so these sections need a new
submission to populate them. The main catalog's hardware remains available.

## Pulsed Media plan list

`config/plans.json` contains the dropdown's approved plan names. The shipped
list is the administrator-supplied 74-plan baseline. The sync script checks
Pulsed Media's **public** product catalog at
<https://pulsedmedia.com/data/v1/products.json> for new eligible plans. Dedicated
servers and credits-only products are excluded. Some dedicated products are
misclassified as `hostingaccount` in the feed, so the script also excludes the
MiniDedi, MD-series, F*-MDS, Dell C1100 and QCS210 dedicated families. Sold-out
shared plans remain eligible for current customers. The public catalog requires no API key.
No customer-services API key is stored in this project or sent to browsers.

Refresh it manually from the project directory:

```sh
npm run sync-plans
```

Run this in an interactive terminal. If new eligible plans are found, the script
lists them with numbers. Select numbers or ranges (for example `1,3-5`), `all`,
or press Enter for none. Review the selected names and answer `y` to the final
confirmation before anything is added. Declines, cancellation and fetch errors
leave the file unchanged. Noninteractive runs refuse to add new plans.

Existing approved names, custom/retired entries and their order are retained;
only approved additions are appended. If there are no new plans, the file is
not rewritten. A changed file is replaced atomically, and edits by another
admin during the prompt cause an abort instead of overwriting that work. You
can also edit the JSON array directly. A valid list has 1–1000 unique strings
of at most 100 characters each.
The running server reloads it for config and submission requests; refresh the
website to load new options. `PLANS_PATH` can select a different file. Docker
users can bind-mount a maintained list over `/app/config/plans.json`, or rebuild
the image after editing it. The sync command is a manual maintenance action,
not a scheduled task.

Intel QuickSync is inferred using this catalog's current rule: only Intel N100 processors qualify. Existing rows use the same rule without re-uploading. This does not test GPU access inside a particular container or VM. Update `inferQuickSync` in `server/submission.mjs` if the supported processor list changes. YABS cores are the logical cores/vCPUs it reports. Frequency is the value YABS reports, not a live clock measurement; unknown frequency is shown as a dash. Storage follows YABS's mounted-filesystem total, not an independent physical-drive inventory. Its legacy JSON `disk_units: "KB"` comes from df's default 1024-byte blocks and is interpreted accordingly. RAM, SWAP, and storage are stored numerically in bytes and sorted numerically.

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
VM information. Re-upload the YABS file with the same hostname and your
submission identifier, or submit a full row through the raw API with an explicit
`kvm` value, to populate it. Merely refreshing cannot recover discarded data.

## Submit a row directly with the API

You can submit one server as JSON without a YABS file:

```text
POST https://pmdb.fyi/api/servers/raw
Content-Type: application/json
```

Save your row as `server-row.json`. An example is included at
`examples/server-row.json`:

```json
{
  "serverName": "le4-0-105-238louhi.pulsedmedia.com",
  "username": "exampleuser",
  "plan": "M10G S",
  "userCount": 24,
  "processorName": "Intel(R) Core(TM) i7-12700",
  "coreCount": 20,
  "processorMhz": 2100,
  "ramGiB": 32,
  "swapGiB": 8,
  "storageTiB": 4,
  "kvm": false
}
```

Submit from Linux/macOS:

```sh
curl --fail-with-body --show-error \
  --request POST 'https://pmdb.fyi/api/servers/raw' \
  --header 'Content-Type: application/json' \
  --data-binary @server-row.json
```

For the included example, use `--data-binary @examples/server-row.json`. In
PowerShell, use `curl.exe` and supply the same URL, headers, and JSON file.

| Field | Required | Format |
| --- | --- | --- |
| `serverName` | Yes | Hostname; lowercased, with `.pulsedmedia.com` added to bare node names |
| `username` | Yes | Any consistent identifier, max 64 characters; case-sensitive; not necessarily a real username |
| `plan` | No | One of the configured dropdown options; omit, `null` or blank to retain the previous plan |
| `userCount` | No | Integer 0–10000000; omit, `null` or blank to retain the previous reported count |
| `processorName` | Yes | Nonempty text, at most 300 characters |
| `coreCount` | Yes | Positive integer (reported logical cores/vCPUs) |
| `processorMhz` | No | Positive number in MHz; omit or use `null` if unknown |
| `ramGiB` | Yes | Positive number in GiB |
| `swapGiB` | No | Nonnegative number in GiB; `0` means no swap, omitted/`null` means unknown |
| `storageTiB` | Yes | Nonnegative number in TiB |
| `qsv` | No | Legacy boolean accepted for compatibility; ignored because QuickSync is inferred from `processorName` |
| `kvm` | No | JSON `true` for KVM, `false` for NONE; omitted/`null` means unknown |
| `system` | No | Object with optional `distro`, `kernel`, `arch`, `vm` strings |
| `benchmarks` | No | Normalized benchmark object described below |

Numeric fields must be JSON numbers, not quoted strings or values with units.
Capacities accept decimals and are rounded to the nearest byte, within the
safe integer range. No extra fields or arrays are accepted. Datacenter and
the highlighted friendly name continue to be derived from the hostname.

New nodes return HTTP `201` and `{"replaced":false,"serverName":"..."}`.
Any existing hostname updates automatically, returning `200` with
`"replaced":true`. The `replace` flag is accepted for older clients but ignored;
it cannot create a duplicate plan entry. Full hardware rows are still required,
and omitted optional hardware/system values become unknown. YABS and raw
submissions share node history and username-based plan slots.

Both APIs require `username`; `plan` and `userCount` are optional. For structured
YABS, use `POST /api/servers` with `serverName`, `username`, and `yabsText`
containing the JSON file as a string, plus any optional metadata. The raw endpoint
continues to accept human-readable GiB/TiB field names.

Optional raw `benchmarks` has `{ "measuredAt": "2026-11-02T12:00:00Z",
"speedTests": [...], "diskIo": [...] }`. `measuredAt` may be null. Speed entries
allow `mode`, `provider`, `location`, `send`, `receive`, and `latency` (bounded
strings or null). Disk entries allow `blockSize`, `read`, `write`, `combined`,
`readIops`, `writeIops`, `combinedIops`, and `speedUnits`. Metrics are nonnegative
JSON numbers or null; speed units must be recognized byte-per-second units.
Limits are 100 speed endpoints and 32 disk tests per submission. Unknown raw
nested fields are rejected. Refer to `server/benchmarks.mjs` for exact bounds.

`GET /api/nodes/<hostname>?limit=20&offset=0` returns the node summary, plan
counts, and history. Limit must be 1–100 and offset a nonnegative integer.
`GET /api/config` returns `uploadsEnabled` and `plans`; `GET /api/servers`
retains the main table's ten existing fields. No contributor identifiers are
returned. `uploadsEnabled` is always true when configuration loads normally.

Older short-name records remain readable. If a submission collides with an
existing short-name row, the API returns `409` with an offline rename instruction;
it does not create a second node or silently merge histories. Use
`npm run rename-node -- SHORT_NAME FULL_HOSTNAME` with the app stopped and a
complete backup retained. If both names already exist, resolve that collision
first. See `HISTORY-TABLES-UPDATE.md` for this release's deployment steps.

Invalid fields or malformed JSON return `400`; wrong content type returns
`415`; oversized requests return `413`; rate limiting returns `429`. Errors
have the JSON shape `{"error":"..."}`. Both submission endpoints are public and
share the same request/depth limits and rate-limit bucket. Reads remain
public. These manually supplied values are validated but not independently
verified against hardware. Click Refresh on the website to see the row.

The existing `POST /api/servers` YABS endpoint and website upload form work as
before. This addition is for scripts, curl, or other API clients; it does not
add a manual-entry form to the website.

To deploy this version, see **Updating to node pages** below. Full-row updates
without `kvm` reset that status to unknown, like the other optional fields.

## Updating to node pages

1. Back up your existing SQLite database with `npm run backup`.
2. Stop the old Node process before starting the new version. Keep the existing
   `.env`, catalog SQLite file and its original data directory intact.
3. Deploy all the supplied `server/`, `src/`, `scripts/`, `config/`, Dockerfile,
   package files, examples and tests together. Do not mix old parsers with the
   new form. Existing systemd service names and Caddy config can stay as they are.
4. Run `npm run build` to build the catalog and node pages.
5. Restart the Node process to load the backend changes. For an
   interactive `npm start` session, stop it with Ctrl+C and run `npm start`
   again. For systemd or another process manager, restart the app's service.
6. Hard-refresh the website. Existing nodes get pages immediately; new fields
   and benchmark history populate from subsequent uploads.

The catalog's existing rows remain intact. Per-node databases are initialized
automatically, and older catalog schemas still migrate SWAP/KVM fields. No new
npm dependencies or Caddy changes are needed. Docker installations deploy with
`docker compose up -d --build`, which builds the frontend and restarts the app.

## Deploy on a Linux VM with Docker Compose

Install Docker Engine and the Compose plugin on your VM, then run (no `.env`
or upload token is required):

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

The catalog defaults to `data/servers.sqlite`; `DATABASE_PATH` changes that
location. Node detail files default to the sibling `nodes/` directory;
`NODE_DATABASE_DIR` overrides it. Keep both on local disk owned by the app user.
New files use mode 0600 and directories mode 0700 on Linux. SQLite has no
network listener, port, SQL password, or external database service.

Catalog and attached node writes use one transaction with rollback journals
(`journal_mode=DELETE`) and `synchronous=FULL`, enabling SQLite's multi-file
commit protection. Stop the old app before upgrading from its earlier WAL
mode, and avoid changing journal modes manually. Filesystem durability and
correct OS locking are still necessary. See SQLite's ATTACH documentation:
<https://www.sqlite.org/lang_attach.html>.

For a native deployment, create a consistent online backup:

```sh
npm run backup -- backups/catalog.sqlite
```

This creates **two parts**: `backups/catalog.sqlite` and the companion
`backups/catalog.sqlite.nodes/` directory, containing snapshots of all node
databases and a manifest. Keep both parts. The helper takes a catalog writer
lock while making consistent `VACUUM INTO` snapshots. Briefly blocked
submissions may wait during a large backup. Use a new destination each time;
existing backups are never overwritten. Backups can be partial if the command
fails, so use only a set produced by a successful command.

Do not copy active database files directly while the app is writing. A backup
of only the main database cannot restore plan participants or benchmark history.

For Docker, stop the catalog and copy the **entire** data directory:

```sh
docker compose stop catalog
docker compose cp catalog:/app/data ./catalog-data-backup
docker compose start catalog
```

For restore, stop the app and preserve its current data directory first. Restore
the catalog snapshot to `DATABASE_PATH` and the companion node snapshots to
`NODE_DATABASE_DIR` (by default `data/nodes/`), with ownership matching the app
user. Restore the complete set together. Remove old sidecars only while stopped;
do not delete a hot journal from a database you intend to recover. Keep backups
off the VM and restrict access to them.

## Renaming or removing a node

Because detail filenames are hashes of hostnames, changing `server_name` with
SQL alone would disconnect its plan/history file. With the app **stopped** and
a complete backup made, use the maintenance helper instead:

```sh
npm run rename-node -- old-hostname.pulsedmedia.com new-hostname.pulsedmedia.com
```

The helper preserves node participants and history and refuses to overwrite an
existing target. See its output for the retained original file. Restart the app
afterward. Direct SQL edits to ordinary hardware fields in the catalog still
appear on refresh; node OS and user counts belong in the per-node detail file.
Deleting a catalog row hides its page but does not erase the old node file.

## Internet-facing protections

- Uploads and reads are public, with no token or verification step. An arbitrary identifier links repeat submissions, but does not authenticate its owner. Catalog and node details are public, including reported counts, plan aggregates and benchmark measurements. Contributor identifiers are private to the stored data and backups.
- Each API submission endpoint accepts only its expected fields, with real booleans for KVM and any legacy QuickSync input. QuickSync is inferred from the processor. Hostnames, submission identifiers, configured plans, reported user counts, hardware, OS details and benchmark fields are validated server-side. YABS extracts only the allowed fields; unrelated data such as IP information and Geekbench results is discarded. Original upload files are not kept. The normalized record is retained privately for node state and history.
- JSON request bodies are limited to 1 MiB, JSON nesting to 32 levels, and the browser file chooser to 800 KiB. HTTP request/header timeouts are configured. Native JSON parsing is used; there is no eval, shell execution, or downloading URLs supplied by users.
- Upload attempts are limited to 30 per source connection IP per 10 minutes, including invalid submissions. Forwarded IP headers are not trusted. Behind a reverse proxy, clients share that proxy's bucket. Limits are in memory and reset on restart; this is basic abuse protection, not protection from a large distributed attack.
- Every SQL value uses a prepared statement. Only fixed application SQL runs. SQLite strict columns, transactions, uniqueness, and duplicate-upload checks protect data consistency. SQLite schema trust is disabled.
- The static server serves only dist/. Credentials, server source, and SQLite files cannot be downloaded through it. API responses use no-store, security headers, and a restrictive content security policy. The UI renders uploaded text through React's escaped text nodes, never as HTML. Cross-origin access is not enabled.
- The Docker and proxy configuration provides a deployment starting point. HTTPS, VM updates, dependency updates and backups remain operational responsibilities. No audit establishes that an app is invulnerable.

If ownership verification is needed later, it would require an actual login or
another proof of control. Public identifiers alone provide submission matching.

## Verification

```sh
npm test
npm run build
npm audit
```

The tests exercise YABS and direct row parsing, node pages, same-user plan
updates, separate users/nodes, history deduplication and pagination, per-node
files, migration, backup/restore, plan-feed validation, invalid fields, public uploads,
request limits and private-file isolation. Docker and domain/proxy deployment
still need verification on your VM.
