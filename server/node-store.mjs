import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export function nodeFilePath(directory, hostname) {
  return join(directory, `${createHash('sha256').update(hostname).digest('hex')}.sqlite`);
}

export function friendlyName(hostname) {
  const label = hostname.split('.')[0];
  return label.match(/^[^-]+-(?:\d+-)*\d+([a-z][a-z0-9-]*)$/i)?.[1] || label;
}

export function initializeNodeFile(filename, initialRecord = null) {
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;
      CREATE TABLE IF NOT EXISTS node_state (
        id INTEGER PRIMARY KEY CHECK(id=1),
        server_name TEXT NOT NULL,
        user_count INTEGER CHECK(user_count >= 0),
        system_json TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS participants (
        username TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS benchmark_runs (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        measured_at TEXT,
        submitted_at TEXT NOT NULL,
        speed_json TEXT NOT NULL,
        disk_json TEXT NOT NULL,
        UNIQUE(username, fingerprint)
      ) STRICT;`);
    if (initialRecord) {
      db.prepare(`INSERT OR IGNORE INTO node_state VALUES (1, ?, NULL, '{}', ?, ?)`)
        .run(initialRecord.serverName, JSON.stringify(initialRecord), initialRecord.updatedAt);
    }
  } finally { db.close(); }
  if (process.platform !== 'win32') chmodSync(filename, 0o600);
}

export function prepareNodeDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

// The caller attaches the node file under this fixed alias and holds a catalog
// write transaction, so catalog hardware and node data commit together normally.
export function writeNodeSubmission(db, record, now) {
  db.prepare(`INSERT INTO node_data.node_state VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET server_name=excluded.server_name,
    user_count=excluded.user_count, system_json=excluded.system_json,
    record_json=excluded.record_json, updated_at=excluded.updated_at`)
    .run(record.serverName, record.userCount, JSON.stringify(record.system || {}), JSON.stringify(record), now);
  db.prepare(`INSERT INTO node_data.participants VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET plan=excluded.plan, updated_at=excluded.updated_at`)
    .run(record.username, record.plan, now);
  const benchmarks = record.benchmarks || {};
  const speed = benchmarks.speedTests || [];
  const disk = benchmarks.diskIo || [];
  if (!speed.length && !disk.length) return;
  const measuredAt = benchmarks.measuredAt || null;
  const speedJson = JSON.stringify(speed), diskJson = JSON.stringify(disk);
  const fingerprint = createHash('sha256').update(JSON.stringify({ measuredAt, speed, disk })).digest('hex');
  db.prepare(`INSERT OR IGNORE INTO node_data.benchmark_runs
    (username, fingerprint, measured_at, submitted_at, speed_json, disk_json)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(record.username, fingerprint, measuredAt, now, speedJson, diskJson);
}

export function readNodePage(filename, server, { limit = 20, offset = 0 } = {}) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; BEGIN');
    const state = db.prepare('SELECT * FROM node_state WHERE id=1').get();
    const plans = db.prepare('SELECT plan AS name, count(*) AS count FROM participants GROUP BY plan ORDER BY count(*) DESC, plan').all();
    const contributors = db.prepare('SELECT count(*) AS total FROM participants').get().total;
    const totalRuns = db.prepare('SELECT count(*) AS total FROM benchmark_runs').get().total;
    const runs = db.prepare('SELECT id, measured_at, submitted_at, speed_json, disk_json FROM benchmark_runs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
    const history = { speedTests: [], diskIo: [] };
    for (const run of runs) {
      const common = { id: run.id, measuredAt: run.measured_at, submittedAt: run.submitted_at };
      const speed = JSON.parse(run.speed_json), disk = JSON.parse(run.disk_json);
      if (speed.length) history.speedTests.push({ ...common, tests: speed });
      if (disk.length) history.diskIo.push({ ...common, tests: disk });
    }
    db.exec('COMMIT');
    return {
      server, friendlyName: friendlyName(server.serverName),
      system: state ? JSON.parse(state.system_json) : {},
      userCount: state?.user_count ?? null, updatedAt: state?.updated_at ?? null,
      contributors, plans, history, pagination: { limit, offset, totalRuns },
    };
  } finally { db.close(); }
}
