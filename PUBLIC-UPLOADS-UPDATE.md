# Public uploads and consistent contributor identifiers

This updated package includes the complete node-pages update plus public uploads.

## Changes

- Removed upload-key verification from both POST /api/servers and /api/servers/raw.
- Removed the password field and Authorization header from the upload form.
- Missing .env no longer disables uploads. Old UPLOAD_TOKEN values are ignored.
- Docker Compose no longer requires an upload token or .env file.
- The modal prominently explains that the identifier does not have to be an
  actual username, and must be reused exactly for all of a contributor's submissions.
- Any printable identifier up to 64 characters is accepted, including spaces,
  punctuation and Unicode. Blank values and control characters remain invalid.
- The API field is still named username and the existing database keys are
  retained, so previous submissions continue to match when the same value is used.

Identifiers are case-sensitive. They match repeat submissions but do not prove
identity or ownership. Anyone using the same identifier on the same node can
update that plan entry. Identifiers are not published on the website or public API.
If you have already submitted data, keep using that same identifier; changing
it creates a separate contributor entry rather than renaming the old one.

## Deployment

From your existing project directory:

1. Run npm run backup and retain both the catalog backup and node-backup folder.
2. Stop the Node application.
3. Extract the updated pmdb-node-pages-update.zip into the project directory.
4. Run npm run build.
5. Restart with npm start or your existing application service.
6. Refresh the browser with Ctrl+Shift+R.

No database migration or new dependency is required for this change. Existing
.env, data, plan memberships and benchmark histories remain in place. You may
remove the obsolete UPLOAD_TOKEN line from .env; it has no effect now. For fresh
local testing, npm run dev works without any .env file. See NODE-PAGES-UPDATE.md
for a first upgrade from the older catalog-only version.

For Docker, extract the update into the build project and run
docker compose up -d --build. An existing Docker environment variable for the
old token is harmless, but the updated Compose file removes the requirement.

## Unchanged limits

| Limit | Setting |
| --- | --- |
| Upload rate | 30 attempts per connection IP per 10 minutes, shared by both POST APIs |
| API request body | 1 MiB |
| Browser file selection | 800 KiB |
| JSON nesting | 32 levels |
| Request/header timeouts | 30 / 15 seconds |
| Benchmark arrays per submission | 100 network results and 32 disk results |
| Node-history page size | Default 20, maximum 100 runs |
| Public GET requests | No application-level rate limiter |

The upload limiter uses the immediate connection IP, not forwarded headers or
CF-Connecting-IP. Behind Caddy, visitors generally share the proxy's bucket.
Cloudflare protection does not change this application behavior. Invalid
submissions count toward the limit. Buckets are held in memory and reset when
Node restarts. A blocked upload returns HTTP 429 with Retry-After.

Input validation, parameterized SQL, private-file isolation, body/depth limits
and rate limiting remain enabled. All 40 tests, the production build and rendered
frontend interaction checks pass, including uploads without credentials and
safe plan deduplication for identifiers with spaces and punctuation.
