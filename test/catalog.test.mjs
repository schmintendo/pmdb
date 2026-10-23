import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../server/database.mjs';
import { parseYabs, parseSubmission, datacenterFor, normalizeHostname, parseLimitedJson } from '../server/yabs.mjs';

const example = JSON.parse(readFileSync(new URL('../examples/yabs-example.json', import.meta.url), 'utf8'));
const source = JSON.stringify(example);
const token = 'this-is-a-fixed-test-key-not-a-real-secret';
const payload = { serverName: 'le4-0-105-238louhi.pulsedmedia.com', qsv: true, yabsText: source };

test('user hostname examples and normalization', () => {
  assert.equal(datacenterFor('le4-0-105-238louhi.pulsedmedia.com'), 'le4');
  assert.equal(datacenterFor('lt5-1-58-111alue.pulsedmedia.com'), 'lt5');
  assert.equal(normalizeHostname(' LE4-01.Example.com. '), 'le4-01.example.com');
  assert.equal(datacenterFor('example.com'), 'Unknown');
  for (const name of ['', '../data', "a'; DROP TABLE servers;--", '<script>alert(1)</script>']) assert.throws(() => normalizeHostname(name));
});
test('extracts YABS JSON with numeric units and legacy df KB handling', () => {
  const result = parseYabs(source);
  assert.equal(result.processorName, example.cpu.model);
  assert.equal(result.coreCount, 20);
  assert.equal(result.processorMhz, 2100);
  assert.equal(result.ramBytes, 32 * 1024 ** 3);
  assert.equal(result.swapBytes, 8 * 1024 ** 3);
  assert.equal(result.storageBytes, example.mem.disk * 1024);
  assert.equal(parseYabs(JSON.stringify({ ...example, cpu: { ...example.cpu, freq: '2.1 GHz' } })).processorMhz, 2100);
  assert.equal(parseYabs(JSON.stringify({ ...example, cpu: { ...example.cpu, freq: '??? MHz' } })).processorMhz, null);
});
test('standard terminal output can also be imported', () => {
  const result = parseYabs('Processor  : Intel Xeon E-2288G\nCPU cores  : 16 @ 3700.000 MHz\nRAM        : 31.3 GiB\nSwap       : 2.5 GiB\nDisk       : 900.1 GiB');
  assert.equal(result.coreCount, 16); assert.equal(result.processorMhz, 3700);
  assert.equal(result.ramBytes, Math.round(31.3 * 1024 ** 3));
  assert.equal(result.swapBytes, 2.5 * 1024 ** 3);
});
test('SWAP distinguishes zero from missing and rejects invalid values and units', () => {
  const withSwap = (swap, swap_units = 'KiB') => JSON.stringify({ ...example, mem: { ...example.mem, swap, swap_units } });
  assert.equal(parseYabs(withSwap(0)).swapBytes, 0);
  assert.equal(parseYabs(withSwap(undefined)).swapBytes, null);
  for (const value of [-1, null, '', 'NaN', {}]) assert.throws(() => parseYabs(withSwap(value)));
  assert.throws(() => parseYabs(withSwap(10, 'bogus')));
  const text = 'Processor : Example CPU\nCPU cores : 4 @ 2000 MHz\nRAM : 8 GiB\nDisk : 1 TiB';
  assert.equal(parseYabs(text).swapBytes, null);
  assert.equal(parseYabs(text + '\nSwap : 0 KiB').swapBytes, 0);
});
test('existing database migrates without losing records and can update SWAP', () => {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-migration-'));
  const filename = join(directory, 'old.sqlite');
  let db;
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE servers (server_name TEXT PRIMARY KEY, processor_name TEXT NOT NULL,
      core_count INTEGER NOT NULL CHECK(core_count > 0), processor_mhz REAL, ram_bytes INTEGER NOT NULL,
      storage_bytes INTEGER NOT NULL, qsv INTEGER NOT NULL CHECK(qsv IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;`);
    legacy.prepare('INSERT INTO servers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(payload.serverName, 'Old CPU', 4, 2000, 8 * 1024 ** 3, 1024 ** 4, 1, 'before', 'before');
    legacy.close();
    db = openDatabase(filename);
    assert.equal(db.list()[0].swapBytes, null);
    assert.equal(db.list()[0].processorName, 'Old CPU');
    db.save(parseSubmission(payload), true);
    assert.equal(db.list()[0].swapBytes, 8 * 1024 ** 3);
    db.close(); db = openDatabase(filename);
    assert.equal(db.list().length, 1);
    assert.equal(db.list()[0].swapBytes, 8 * 1024 ** 3);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('rejects malformed, excessive, and invalid submissions', () => {
  for (const raw of ['{}', '[1,2]', '{bad}', 'hello', JSON.stringify({ ...example, cpu: { ...example.cpu, cores: -1 } }), JSON.stringify({ ...example, mem: { ...example.mem, ram_units: 'bogus' } })]) assert.throws(() => parseYabs(raw));
  assert.throws(() => parseSubmission({ ...payload, qsv: 'true' }));
  assert.throws(() => parseSubmission({ ...payload, extra: 'not accepted' }));
  assert.throws(() => parseLimitedJson('['.repeat(33) + '0' + ']'.repeat(33)));
  assert.deepEqual(parseLimitedJson('{"text":"brackets [ { inside a string"}'), { text: 'brackets [ { inside a string' });
});

async function running(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-test-'));
  const dbPath = resolve(directory, 'servers.sqlite');
  const distPath = resolve(directory, 'dist');
  const { mkdirSync } = await import('node:fs'); mkdirSync(distPath);
  writeFileSync(join(distPath, 'index.html'), '<h1>Test catalog</h1>');
  const app = createApp({ databasePath: dbPath, uploadToken: token, distPath, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true }); });
  return { app, url, dbPath, distPath };
}
const post = (url, body, headers = {}) => fetch(url + '/api/servers', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('API authentication, upload, nine fields, duplicate protection, replace, and persistence', async t => {
  const { app, url, dbPath, distPath } = await running(t);
  assert.equal((await post(url, payload, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post(url, payload)).status, 201);
  assert.equal((await post(url, payload)).status, 409);
  let rows = await (await fetch(url + '/api/servers')).json();
  assert.equal(rows.length, 1); assert.equal(Object.keys(rows[0]).length, 9); assert.equal(rows[0].datacenter, 'le4');
  assert.equal(rows[0].swapBytes, 8 * 1024 ** 3);
  assert.equal((await post(url, { ...payload, qsv: false, replace: true })).status, 200);
  rows = await (await fetch(url + '/api/servers')).json(); assert.equal(rows[0].qsv, false);
  // A second application instance reads the same persisted SQLite database.
  const second = createApp({ databasePath: dbPath, uploadToken: token, distPath });
  await new Promise(resolve => second.server.listen(0, '127.0.0.1', resolve));
  const result = await fetch(`http://127.0.0.1:${second.server.address().port}/api/servers`);
  assert.equal((await result.json())[0].serverName, payload.serverName);
  await second.close();
});
test('API refuses malformed uploads, wrong content type, oversized/deep JSON, and extra fields', async t => {
  const { url } = await running(t);
  assert.equal((await post(url, '{bad}')).status, 400);
  assert.equal((await post(url, payload, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(url, { ...payload, qsv: 'yes' })).status, 400);
  assert.equal((await post(url, { ...payload, privileged: true })).status, 400);
  assert.equal((await post(url, JSON.stringify({ ...payload, yabsText: 'x'.repeat(1024 * 1024) }))).status, 413);
  assert.equal((await post(url, '['.repeat(40) + '0' + ']'.repeat(40))).status, 400);
});
test('database and credentials are not served; stored text remains inert JSON', async t => {
  const { url } = await running(t);
  for (const path of ['/data/servers.sqlite', '/.env', '/server/index.mjs', '/%2e%2e%2fserver/index.mjs']) assert.equal((await fetch(url + path)).status, 404);
  const malicious = JSON.stringify({ ...example, cpu: { ...example.cpu, model: "<script>alert('x')</script>'); DROP TABLE servers;--" } });
  assert.equal((await post(url, { ...payload, yabsText: malicious })).status, 201);
  const response = await fetch(url + '/api/servers');
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await response.json())[0].processorName, JSON.parse(malicious).cpu.model);
});
test('upload rate limiting and disabled uploads', async t => {
  const { url } = await running(t, { uploadLimit: 2 });
  await post(url, payload, { Authorization: 'wrong' }); await post(url, payload, { Authorization: 'wrong' });
  const response = await post(url, payload); assert.equal(response.status, 429); assert.ok(response.headers.get('retry-after'));
  const disabled = await running(t, { uploadToken: '' });
  assert.equal((await post(disabled.url, payload)).status, 503);
});
