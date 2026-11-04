import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { InputError, datacenterFor } from './yabs.mjs';
import { nodeFilePath, initializeNodeFile, prepareNodeDirectory, writeNodeSubmission, readNodePage } from './node-store.mjs';

export function openDatabase(filename, { nodesPath } = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  const temporaryNodes = filename === ':memory:' && !nodesPath ? mkdtempSync(join(tmpdir(), 'pmdb-node-files-')) : null;
  const nodeDirectory = nodesPath || temporaryNodes || join(dirname(filename), 'nodes');
  prepareNodeDirectory(nodeDirectory);
  if (filename !== ':memory:' && process.platform !== 'win32') chmodSync(filename, 0o600);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;
    CREATE TABLE IF NOT EXISTS servers (
      server_name TEXT PRIMARY KEY,
      processor_name TEXT NOT NULL,
      core_count INTEGER NOT NULL CHECK(core_count > 0),
      processor_mhz REAL,
      ram_bytes INTEGER NOT NULL,
      storage_bytes INTEGER NOT NULL,
      swap_bytes INTEGER CHECK(swap_bytes >= 0),
      qsv INTEGER NOT NULL CHECK(qsv IN (0,1)),
      kvm INTEGER CHECK(kvm IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;`);
  // Existing databases retain their rows; missing SWAP is unknown, not zero.
  if (!db.prepare('PRAGMA table_info(servers)').all().some(column => column.name === 'swap_bytes')) {
    db.exec('ALTER TABLE servers ADD COLUMN swap_bytes INTEGER CHECK(swap_bytes >= 0)');
  }
  // Earlier uploads did not retain VM information; leave those rows unknown.
  if (!db.prepare('PRAGMA table_info(servers)').all().some(column => column.name === 'kvm')) {
    db.exec('ALTER TABLE servers ADD COLUMN kvm INTEGER CHECK(kvm IN (0,1))');
  }
  const select = db.prepare('SELECT * FROM servers ORDER BY server_name');
  const find = db.prepare('SELECT * FROM servers WHERE server_name = ?');
  const exists = db.prepare('SELECT 1 FROM servers WHERE server_name = ?');
  const insert = db.prepare(`INSERT INTO servers (server_name, processor_name, core_count, processor_mhz, ram_bytes, storage_bytes, swap_bytes, qsv, kvm, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_name) DO UPDATE SET processor_name=excluded.processor_name,
    core_count=excluded.core_count, processor_mhz=excluded.processor_mhz,
    ram_bytes=excluded.ram_bytes, storage_bytes=excluded.storage_bytes, swap_bytes=excluded.swap_bytes,
    qsv=excluded.qsv, kvm=excluded.kvm, updated_at=excluded.updated_at`);
  const publicRecord = row => ({
        serverName: row.server_name, processorName: row.processor_name,
        coreCount: row.core_count, processorMhz: row.processor_mhz,
        ramBytes: row.ram_bytes, storageBytes: row.storage_bytes, swapBytes: row.swap_bytes,
        datacenter: datacenterFor(row.server_name), qsv: Boolean(row.qsv),
        kvm: row.kvm == null ? null : Boolean(row.kvm),
      });
  function insertRecord(record, now) {
    insert.run(record.serverName, record.processorName, record.coreCount, record.processorMhz, record.ramBytes, record.storageBytes, record.swapBytes ?? null, Number(record.qsv), record.kvm == null ? null : Number(record.kvm), now, now);
  }
  function ensureNode(record, updatedAt) {
    const file = nodeFilePath(nodeDirectory, record.serverName);
    initializeNodeFile(file, { ...record, updatedAt });
    return file;
  }
  // Materialize one private node DB for each existing catalog row. Rollback
  // journals and FULL synchronization enable SQLite's attached-database
  // super-journal to commit catalog and node updates atomically on local disk.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of select.all()) {
      ensureNode(publicRecord(row), row.updated_at);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  return {
    list() { return select.all().map(publicRecord); },
    find(name) { const row = find.get(name); return row ? publicRecord(row) : null; },
    nodeDetails(name, pagination) {
      const row = find.get(name);
      if (!row) throw new InputError('Node not found.', 404);
      const record = publicRecord(row);
      const file = nodeFilePath(nodeDirectory, name);
      if (!existsSync(file)) {
        db.exec('BEGIN IMMEDIATE');
        try { ensureNode(record, row.updated_at); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      return readNodePage(file, record, pagination);
    },
    saveSubmission(record) {
      const file = nodeFilePath(nodeDirectory, record.serverName);
      // Schema initialization is separately protected by the catalog lock.
      // Attaching before the actual write transaction lets us explicitly set
      // the attached connection's synchronization level (not a file setting).
      db.exec('BEGIN IMMEDIATE');
      try { initializeNodeFile(file); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      db.prepare('ATTACH DATABASE ? AS node_data').run(file);
      try {
        db.exec('PRAGMA node_data.synchronous=FULL; BEGIN IMMEDIATE');
        try {
          const existing = Boolean(exists.get(record.serverName));
          const now = new Date().toISOString();
          insertRecord(record, now);
          writeNodeSubmission(db, record, now);
          db.exec('COMMIT');
          return { replaced: existing };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      } finally { db.exec('DETACH DATABASE node_data'); }
    },
    save(record, replace = false) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = Boolean(exists.get(record.serverName));
        if (existing && !replace) throw new InputError('This server already exists. Enable “Replace existing server” to update it.', 409);
        const now = new Date().toISOString();
        insertRecord(record, now);
        db.exec('COMMIT');
        return { replaced: existing };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); if (temporaryNodes) rmSync(temporaryNodes, { recursive: true, force: true }); },
  };
}
