# Deploying node pages and submission history

Baseline: schmintendo/pmdb commit
5958d8f287d721f9f0d0460c7f6c24419d6eaef0, retrieved for this update.

## Included features

- Click a hostname in the catalog for its dynamic /nodes/<hostname> page.
- Friendly name, hardware, datacenter, OS and latest reported user count.
- Three panels: plan counts, network benchmark history and disk I/O history.
- A consistent contributor identifier, configured plan and reported user-count fields in the form.
- No replace checkbox: each node/username pair has one current plan entry.
- Distinct users on the same plan count separately. Identical repeated benchmark
  submissions by one username do not duplicate the benchmark history.
- The requested YABS command: curl -sL yabs.sh | bash -s -- -gw yabs.json
- A separate Copy control for the UID > 1000 account-count command.
- One private SQLite file per node, as requested, plus the existing catalog.
- A visible Back to all nodes control and direct-link support on node pages.
- 114 real service plans imported from Pulsed Media's public product feed.
  No account API key was required, used or embedded. Run npm run sync-plans
  to refresh the list later, or edit config/plans.json directly.

## Existing native production installation

1. Transfer pmdb-node-pages-update.zip to the VM, for example into /tmp.
2. Enter the application directory containing package.json.
3. Run npm run backup and keep that successful backup.
4. Stop the current Node application, using Ctrl+C for an interactive session
   or your existing process manager/systemd service.
5. Keep .env and all existing data files in place. Extract this patch into
   the application directory:

   unzip -o /tmp/pmdb-node-pages-update.zip

6. Run npm run build.
7. Start the app with npm start, or restart its existing service.
8. Hard-refresh the website with Ctrl+Shift+R.

No new npm dependencies, database recreation or Caddy changes are required.
Deploy all included modules together. Existing rows acquire empty node detail
files on startup; upload new data to populate the new fields and histories.
Previously discarded YABS benchmark results cannot be recovered automatically.

Stop the old app before starting the new version: this release changes the
SQLite journal mode to support transactional updates across the catalog and
per-node files. Keep the catalog and node directory on local disk with app-user
ownership. Default locations are data/servers.sqlite and data/nodes/.

The archive supplies changed source, new modules/configuration, examples,
documentation and tests. It contains no .env, database, backup, node_modules,
Git metadata or compiled dist directory. Merge any local edits made since the
baseline before overwriting the corresponding source files.

## Docker deployment

Back up the entire existing data volume while the old app is stopped, following
README.md. Extract this patch into the Docker build project, then deploy with:

   docker compose up -d --build

The updated Dockerfile includes the plan configuration and maintenance scripts.
Docker/HTTPS deployment itself was not exercised in this environment.

## Important operational details

- Backups now comprise BOTH a .sqlite catalog snapshot AND its companion
  .sqlite.nodes/ directory. Keep and restore the complete set together.
- New API submissions require username, plan and userCount. Update older raw
  API scripts; see examples/server-row.json and README.md.
- The identifier can be any nickname or label; it need not be an actual username.
  Use exactly the same case and spelling for all submissions. Public APIs/pages
  do not reveal identifiers. Uploads require no token, login or verification.
  Anyone using the same identifier on the same node can update its entry.
- Reported user count is the literal number of /etc/passwd entries with UID
  greater than 1000; it can include service accounts and excludes UID 1000.
  Plan counts represent contributors and may be lower than that account count.
- History remains until an administrator removes it. Network tests preserve
  busy/failed results; omitted tests create no fabricated measurements.
- Do not rename a catalog hostname using SQL alone now that its hash identifies
  a node file. With the app stopped and a complete backup made, use
  npm run rename-node -- OLD_HOSTNAME NEW_HOSTNAME to preserve node history.

## Validation

40 backend/integration tests pass, including plan deduplication, benchmark
history, per-node files, migration, request validation, public uploads, private-file
isolation, atomic rollback, complete backup/restore and offline renaming.
The production build passes. Rendered frontend checks pass against both mock
responses and the actual local API, including the form, command copying,
Browse-only file selection, direct routes, plan counts, history and Back link.
No changes were made to your live site or production databases.
