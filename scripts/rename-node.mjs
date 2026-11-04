import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/database.mjs';
import { nodeFilePath } from '../server/node-store.mjs';
import { normalizeHostname } from '../server/yabs.mjs';

// Offline administrative operation: stop the app and take a complete backup
// first. A SQL-only hostname change would leave history at the old file hash.
export function renameNode({ databasePath, nodesPath, oldName, newName }) {
  const oldHost = normalizeHostname(oldName), newHost = normalizeHostname(newName);
  if (oldHost === newHost) throw new Error('Old and new hostnames are the same.');
  if (!existsSync(databasePath)) throw new Error('The catalog database does not exist.');
  const directory = nodesPath || join(dirname(databasePath), 'nodes');
  // Bring a pre-feature catalog up to date, including empty node DBs.
  openDatabase(databasePath, { nodesPath: directory }).close();
  const sourcePath = nodeFilePath(directory, oldHost), targetPath = nodeFilePath(directory, newHost);
  const catalog = new DatabaseSync(databasePath);
  let source, transaction = false, attached = false, created = false, committed = false;
  try {
    catalog.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; BEGIN EXCLUSIVE');
    transaction = true;
    const get = catalog.prepare('SELECT * FROM servers WHERE server_name=?');
    const before = get.get(oldHost);
    if (!before) throw new Error('The original hostname does not exist in the catalog.');
    if (get.get(newHost) || existsSync(targetPath)) throw new Error('The target hostname or its node database already exists; no data was merged.');
    source = new DatabaseSync(sourcePath, { readOnly: true });
    const version = source.prepare('PRAGMA data_version').get().data_version;
    source.prepare('VACUUM INTO ?').run(targetPath);
    created = true;
    if (process.platform !== 'win32') chmodSync(targetPath, 0o600);
    catalog.exec('COMMIT');
    transaction = false;
    // Synchronization must be set on this attached connection outside a txn.
    catalog.prepare('ATTACH DATABASE ? AS renamed_node').run(targetPath);
    attached = true;
    catalog.exec('PRAGMA renamed_node.synchronous=FULL; BEGIN EXCLUSIVE');
    transaction = true;
    if (JSON.stringify(get.get(oldHost)) !== JSON.stringify(before)
      || get.get(newHost) || source.prepare('PRAGMA data_version').get().data_version !== version) {
      throw new Error('Data changed during the operation. Stop the app and retry after taking a backup.');
    }
    const state = catalog.prepare('SELECT * FROM renamed_node.node_state WHERE id=1').get();
    if (!state || state.server_name !== oldHost) throw new Error('The source node database does not match the original hostname.');
    const record = JSON.parse(state.record_json);
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('The node snapshot is invalid.');
    record.serverName = newHost;
    const now = new Date().toISOString();
    catalog.prepare('UPDATE servers SET server_name=?, updated_at=? WHERE server_name=?').run(newHost, now, oldHost);
    catalog.prepare('UPDATE renamed_node.node_state SET server_name=?, record_json=?, updated_at=? WHERE id=1').run(newHost, JSON.stringify(record), now);
    catalog.exec('COMMIT');
    transaction = false;
    committed = true;
  } finally {
    if (transaction) catalog.exec('ROLLBACK');
    if (attached) catalog.exec('DETACH DATABASE renamed_node');
    source?.close();
    catalog.close();
    // Only this invocation's new copy is removed on failure. The original
    // node file is untouched until the catalog and copied node commit.
    if (created && !committed) {
      for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(targetPath + suffix, { force: true });
    }
  }
  const retired = join(directory, 'retired');
  const archivePath = join(retired, `${oldHost}-${randomUUID()}.sqlite`);
  try {
    mkdirSync(retired, { recursive: true, mode: 0o700 });
    renameSync(sourcePath, archivePath);
    return { oldName: oldHost, newName: newHost, archivePath };
  } catch (error) {
    return { oldName: oldHost, newName: newHost, archivePath: null,
      warning: `Rename committed successfully, but the original node file remains at ${sourcePath}. Archive it before reusing the old hostname: ${error.message}` };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [oldName, newName, ...extra] = process.argv.slice(2);
  if (!oldName || !newName || extra.length) throw new Error('Usage: npm run rename-node -- OLD_HOSTNAME NEW_HOSTNAME (stop the app and back up first)');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = renameNode({ databasePath: process.env.DATABASE_PATH || resolve(root, 'data/servers.sqlite'),
    nodesPath: process.env.NODE_DATABASE_DIR, oldName, newName });
  console.log(`Node renamed: ${result.oldName} -> ${result.newName}`);
  if (result.archivePath) console.log(`Original node database archived: ${result.archivePath}`);
  if (result.warning) console.warn(result.warning);
}
