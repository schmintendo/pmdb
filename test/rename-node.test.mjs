import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { nodeFilePath } from '../server/node-store.mjs';
import { renameNode } from '../scripts/rename-node.mjs';

const original = {
  serverName: 'le4-0-76-80arkstream', processorName: 'Example CPU', coreCount: 4,
  processorMhz: 2000, ramBytes: 1024 ** 3, storageBytes: 1024 ** 4,
  swapBytes: 0, kvm: false, qsv: true, username: 'alice', plan: 'Plan 1', userCount: 12,
  system: { distro: 'Debian' },
  benchmarks: { measuredAt: '2026-11-03T00:00:00.000Z', speedTests: [{ provider: 'Example', send: '1 Gbits/sec' }], diskIo: [] },
};

test('offline node rename preserves participants and benchmark history at the new hashed filename', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pmdb-rename-'));
  const databasePath = join(directory, 'catalog.sqlite'), nodesPath = join(directory, 'nodes');
  const newName = `${original.serverName}.pulsedmedia.com`;
  let db;
  try {
    db = openDatabase(databasePath);
    db.saveSubmission(original);
    db.saveSubmission({ ...original, username: 'bob' });
    const before = db.nodeDetails(original.serverName);
    db.close(); db = null;
    const result = renameNode({ databasePath, oldName: original.serverName, newName });
    assert.ok(existsSync(result.archivePath));
    assert.equal(existsSync(nodeFilePath(nodesPath, original.serverName)), false);
    assert.ok(existsSync(nodeFilePath(nodesPath, newName)));
    db = openDatabase(databasePath);
    assert.equal(db.find(original.serverName), null);
    const after = db.nodeDetails(newName);
    assert.equal(after.server.serverName, newName);
    assert.equal(after.friendlyName, 'arkstream');
    assert.equal(after.contributors, before.contributors);
    assert.deepEqual(after.plans, before.plans);
    assert.deepEqual(after.history, before.history);
    assert.deepEqual(after.system, before.system);
    assert.equal(after.userCount, before.userCount);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('offline node rename rejects hostname/file collisions and keeps the original intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pmdb-rename-collision-'));
  const databasePath = join(directory, 'catalog.sqlite');
  const newName = 'lt5-1-58-111alue.pulsedmedia.com';
  let db;
  try {
    db = openDatabase(databasePath);
    db.saveSubmission(original);
    db.saveSubmission({ ...original, serverName: newName });
    const before = db.nodeDetails(original.serverName);
    db.close(); db = null;
    assert.throws(() => renameNode({ databasePath, oldName: original.serverName, newName }), /already exists/);
    assert.throws(() => renameNode({ databasePath, oldName: original.serverName, newName: '../bad' }));
    db = openDatabase(databasePath);
    assert.equal(db.list().length, 2);
    assert.deepEqual(db.nodeDetails(original.serverName), before);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});
