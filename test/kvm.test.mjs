import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/index.mjs';
import { openDatabase } from '../server/database.mjs';
import { parseYabs, parseSubmission } from '../server/yabs.mjs';
import { parseRawSubmission } from '../server/raw.mjs';

const example = JSON.parse(readFileSync(new URL('../examples/yabs-example.json', import.meta.url), 'utf8'));
const raw = JSON.parse(readFileSync(new URL('../examples/server-row.json', import.meta.url), 'utf8'));
const token = 'kvm-api-fixed-test-key-not-a-real-secret';
const source = vm => JSON.stringify({ ...example, os: { ...example.os, vm }, cpu: { ...example.cpu, virt: true } });

test('KVM is derived from os.vm, independently of CPU virtualization support', () => {
  assert.equal(parseYabs(source('KVM')).kvm, true);
  assert.equal(parseYabs(source('NONE')).kvm, false);
  assert.equal(parseYabs(source(' kvm ')).kvm, true);
  assert.equal(parseYabs(source('none')).kvm, false);
  for (const vm of [undefined, null, '', 'UNKNOWN', 'VMWARE']) assert.equal(parseYabs(source(vm)).kvm, null);
  const noOS = { ...example }; delete noOS.os;
  assert.equal(parseYabs(JSON.stringify(noOS)).kvm, null);
  assert.equal(parseYabs(JSON.stringify({ ...example, os: null })).kvm, null);
  for (const vm of [true, 0, [], {}, 'x'.repeat(65), 'KVM\n']) assert.throws(() => parseYabs(source(vm)));
});

test('standard YABS text can report KVM or NONE and missing VM type stays unknown', () => {
  const text = 'Processor : Example CPU\nCPU cores : 4 @ 2000 MHz\nRAM : 8 GiB\nDisk : 1 TiB';
  assert.equal(parseYabs(text + '\nVM Type : KVM').kvm, true);
  assert.equal(parseYabs(text + '\r\nVM Type : NONE\r\n').kvm, false);
  assert.equal(parseYabs(text).kvm, null);
  assert.equal(parseYabs(text + '\nVM Type :').kvm, null);
});

test('raw KVM field accepts explicit booleans and keeps older clients compatible', () => {
  assert.equal(parseRawSubmission({ ...raw, kvm: true }).kvm, true);
  assert.equal(parseRawSubmission({ ...raw, kvm: false }).kvm, false);
  assert.equal(parseRawSubmission({ ...raw, kvm: null }).kvm, null);
  const missing = { ...raw }; delete missing.kvm;
  assert.equal(parseRawSubmission(missing).kvm, null);
  for (const kvm of ['KVM', 'NONE', 'true', 'false', 0, 1, [], {}]) assert.throws(() => parseRawSubmission({ ...raw, kvm }));
});

test('KVM migration preserves existing hardware, swap, QuickSync and timestamps', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pmdb-kvm-migrate-'));
  const filename = join(directory, 'servers.sqlite');
  let db;
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE servers (
      server_name TEXT PRIMARY KEY, processor_name TEXT NOT NULL,
      core_count INTEGER NOT NULL CHECK(core_count > 0), processor_mhz REAL,
      ram_bytes INTEGER NOT NULL, storage_bytes INTEGER NOT NULL,
      swap_bytes INTEGER CHECK(swap_bytes >= 0), qsv INTEGER NOT NULL CHECK(qsv IN (0,1)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;`);
    legacy.prepare('INSERT INTO servers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(raw.serverName, 'Original CPU', 4, 2000, 8 * 1024 ** 3, 1024 ** 4, 2 * 1024 ** 3, 1, 'original-created', 'original-updated');
    legacy.close();
    db = openDatabase(filename);
    assert.deepEqual(db.list(), [{
      serverName: raw.serverName, processorName: 'Original CPU', coreCount: 4,
      processorMhz: 2000, ramBytes: 8 * 1024 ** 3, storageBytes: 1024 ** 4,
      swapBytes: 2 * 1024 ** 3, qsv: true, datacenter: 'le4', kvm: null,
    }]);
    db.close(); db = openDatabase(filename);
    assert.equal(db.list()[0].kvm, null); // Reopening an already-migrated DB is safe.
    db.save(parseSubmission({ serverName: raw.serverName, qsv: true, yabsText: source('KVM') }), true);
    assert.equal(db.list()[0].kvm, true);
    db.close(); db = openDatabase(filename);
    assert.equal(db.list()[0].kvm, true);
    db.save(parseRawSubmission({ ...raw, kvm: false }), true);
    assert.equal(db.list()[0].kvm, false);
    const inspected = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(inspected.prepare('SELECT created_at FROM servers').get().created_at, 'original-created');
      assert.equal(inspected.prepare('SELECT count(*) AS total FROM servers').get().total, 1);
    } finally { inspected.close(); }
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('API persists KVM from YABS and raw rows through replacement without manual YABS overrides', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pmdb-kvm-api-'));
  const app = createApp({ databasePath: join(directory, 'servers.sqlite'), uploadToken: token });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (body, path = '/api/servers') => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const records = async () => (await fetch(base + '/api/servers')).json();
  const submission = { serverName: raw.serverName, qsv: true, yabsText: source('KVM') };
  assert.equal((await post(submission)).status, 201);
  assert.equal((await records())[0].kvm, true);
  assert.equal((await post({ ...submission, yabsText: source('NONE'), replace: true })).status, 200);
  assert.equal((await records())[0].kvm, false);
  assert.equal((await post({ ...submission, kvm: true, replace: true })).status, 400);
  assert.equal((await records())[0].kvm, false);
  assert.equal((await post({ ...raw, replace: true, kvm: true }, '/api/servers/raw')).status, 200);
  assert.equal((await records())[0].kvm, true);
  assert.equal((await post({ ...raw, replace: true, kvm: 'false' }, '/api/servers/raw')).status, 400);
  assert.equal((await records())[0].kvm, true);
  const missing = { ...raw, replace: true }; delete missing.kvm;
  assert.equal((await post(missing, '/api/servers/raw')).status, 200);
  assert.equal((await records())[0].kvm, null);
});
