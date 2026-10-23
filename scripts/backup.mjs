import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.DATABASE_PATH || resolve(root, 'data/servers.sqlite');
const destination = resolve(process.argv[2] || `backups/servers-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(source, { readOnly: true });
try { db.prepare('VACUUM INTO ?').run(destination); }
finally { db.close(); }
if (process.platform !== 'win32') chmodSync(destination, 0o600);
console.log(`Database backup created: ${destination}`);
