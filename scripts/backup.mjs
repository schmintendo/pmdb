import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.DATABASE_PATH || resolve(root, 'data/servers.sqlite');
const nodes = process.env.NODE_DATABASE_DIR || join(dirname(source), 'nodes');
const destination = resolve(process.argv[2] || `backups/servers-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
const nodeDestination = `${destination}.nodes`;
if (!existsSync(source)) throw new Error('The source database does not exist.');
if (existsSync(destination) || existsSync(nodeDestination)) throw new Error('Choose a new backup path; existing backups are not overwritten.');
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
mkdirSync(nodeDestination, { mode: 0o700 });

function snapshot(from, to) {
  const database = new DatabaseSync(from, { readOnly: true });
  try { database.prepare('VACUUM INTO ?').run(to); }
  finally { database.close(); }
  if (process.platform !== 'win32') chmodSync(to, 0o600);
}

// Every application submission first takes this catalog write lock, including
// writes to attached node DBs. Hold it while all read-only snapshots are made.
// Public reads may continue while this reserved lock blocks new submissions.
const lock = new DatabaseSync(source);
let locked = false;
try {
  lock.exec('PRAGMA busy_timeout=30000; BEGIN IMMEDIATE');
  locked = true;
  snapshot(source, destination);
  const files = existsSync(nodes) ? readdirSync(nodes).filter(name => /^[a-f0-9]{64}\.sqlite$/.test(name)).sort() : [];
  for (const name of files) snapshot(join(nodes, name), join(nodeDestination, name));
  writeFileSync(join(nodeDestination, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), catalog: destination, nodeFiles: files }, null, 2) + '\n', { mode: 0o600 });
  console.log(`Database backup created: ${destination}`);
  console.log(`Node database backups created: ${nodeDestination} (${files.length} files)`);
} finally {
  if (locked) lock.exec('ROLLBACK');
  lock.close();
}
