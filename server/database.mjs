import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { InputError, datacenterFor } from './yabs.mjs';

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:' && process.platform !== 'win32') chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;
    CREATE TABLE IF NOT EXISTS servers (
      server_name TEXT PRIMARY KEY,
      processor_name TEXT NOT NULL,
      core_count INTEGER NOT NULL CHECK(core_count > 0),
      processor_mhz REAL,
      ram_bytes INTEGER NOT NULL,
      storage_bytes INTEGER NOT NULL,
      swap_bytes INTEGER CHECK(swap_bytes >= 0),
      qsv INTEGER NOT NULL CHECK(qsv IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;`);
  // Existing databases retain their rows; missing SWAP is unknown, not zero.
  if (!db.prepare('PRAGMA table_info(servers)').all().some(column => column.name === 'swap_bytes')) {
    db.exec('ALTER TABLE servers ADD COLUMN swap_bytes INTEGER CHECK(swap_bytes >= 0)');
  }
  const select = db.prepare('SELECT * FROM servers ORDER BY server_name');
  const exists = db.prepare('SELECT 1 FROM servers WHERE server_name = ?');
  const insert = db.prepare(`INSERT INTO servers (server_name, processor_name, core_count, processor_mhz, ram_bytes, storage_bytes, swap_bytes, qsv, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_name) DO UPDATE SET processor_name=excluded.processor_name,
    core_count=excluded.core_count, processor_mhz=excluded.processor_mhz,
    ram_bytes=excluded.ram_bytes, storage_bytes=excluded.storage_bytes, swap_bytes=excluded.swap_bytes,
    qsv=excluded.qsv, updated_at=excluded.updated_at`);
  return {
    list() {
      return select.all().map(row => ({
        serverName: row.server_name, processorName: row.processor_name,
        coreCount: row.core_count, processorMhz: row.processor_mhz,
        ramBytes: row.ram_bytes, storageBytes: row.storage_bytes, swapBytes: row.swap_bytes,
        datacenter: datacenterFor(row.server_name), qsv: Boolean(row.qsv),
      }));
    },
    save(record, replace = false) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = Boolean(exists.get(record.serverName));
        if (existing && !replace) throw new InputError('This server already exists. Enable “Replace existing server” to update it.', 409);
        const now = new Date().toISOString();
        insert.run(record.serverName, record.processorName, record.coreCount, record.processorMhz, record.ramBytes, record.storageBytes, record.swapBytes ?? null, Number(record.qsv), now, now);
        db.exec('COMMIT');
        return { replaced: existing };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
