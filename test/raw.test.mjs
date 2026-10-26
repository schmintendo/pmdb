import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { openDatabase } from '../server/database.mjs';
import { parseRawSubmission } from '../server/raw.mjs';

const row = JSON.parse(readFileSync(new URL('../examples/server-row.json', import.meta.url), 'utf8'));
const yabsText = readFileSync(new URL('../examples/yabs-example.json', import.meta.url), 'utf8');
const token = 'raw-api-fixed-test-key-not-a-real-secret';
const yabs = { serverName: row.serverName, qsv: false, yabsText };

async function running(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pmdb-raw-'));
  const databasePath = join(directory, 'servers.sqlite');
  const app = createApp({ databasePath, uploadToken: token, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (body, { path = '/api/servers/raw', headers = {} } = {}) => fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { base, post, databasePath };
}

test('direct rows normalize hostnames and convert explicit GiB/TiB units', () => {
  const parsed = parseRawSubmission({ ...row, serverName: ' LE4-0-105-238LOUHI.PULSEDMEDIA.COM. ', processorName: ' Example CPU ' });
  assert.equal(parsed.serverName, row.serverName);
  assert.equal(parsed.processorName, 'Example CPU');
  assert.equal(parsed.coreCount, 20);
  assert.equal(parsed.processorMhz, 2100);
  assert.equal(parsed.ramBytes, 32 * 1024 ** 3);
  assert.equal(parsed.swapBytes, 8 * 1024 ** 3);
  assert.equal(parsed.storageBytes, 4 * 1024 ** 4);
  assert.equal(parsed.qsv, true);
  assert.equal(parseRawSubmission({ ...row, ramGiB: 31.3 }).ramBytes, Math.round(31.3 * 1024 ** 3));
  assert.equal(parseRawSubmission({ ...row, storageTiB: 1.5 }).storageBytes, 1.5 * 1024 ** 4);
  const missing = parseRawSubmission({ ...row, processorMhz: undefined, swapGiB: undefined });
  assert.equal(missing.processorMhz, null);
  assert.equal(missing.swapBytes, null);
  assert.equal(parseRawSubmission({ ...row, processorMhz: null, swapGiB: null }).swapBytes, null);
  const zero = parseRawSubmission({ ...row, swapGiB: 0, storageTiB: 0 });
  assert.equal(zero.swapBytes, 0);
  assert.equal(zero.storageBytes, 0);
});

test('direct rows reject missing fields, coercions, unsafe numbers and extra fields', () => {
  for (const body of [null, [], [row], 'row', {}, { ...row, extra: true }, { ...row, datacenter: 'lt5' }, { ...row, yabsText }]) {
    assert.throws(() => parseRawSubmission(body));
  }
  for (const field of ['serverName', 'processorName', 'coreCount', 'ramGiB', 'storageTiB', 'qsv']) {
    const missing = { ...row }; delete missing[field];
    assert.throws(() => parseRawSubmission(missing), field);
  }
  for (const field of ['coreCount', 'processorMhz', 'ramGiB', 'swapGiB', 'storageTiB']) {
    for (const value of ['32', '32 GiB', '', true, [], {}, -1, NaN, Infinity, 1e100]) {
      assert.throws(() => parseRawSubmission({ ...row, [field]: value }), `${field}: ${String(value)}`);
    }
  }
  for (const field of ['coreCount', 'processorMhz', 'ramGiB']) assert.throws(() => parseRawSubmission({ ...row, [field]: 0 }));
  assert.throws(() => parseRawSubmission({ ...row, coreCount: 1.5 }));
  assert.throws(() => parseRawSubmission({ ...row, ramGiB: Number.MIN_VALUE }));
  assert.throws(() => parseRawSubmission({ ...row, storageTiB: Number.MAX_SAFE_INTEGER }));
  for (const processorName of ['', '   ', 'x'.repeat(301), 'bad\nCPU', null, 32]) assert.throws(() => parseRawSubmission({ ...row, processorName }));
  for (const value of ['true', 1, null]) {
    assert.throws(() => parseRawSubmission({ ...row, qsv: value }));
    assert.throws(() => parseRawSubmission({ ...row, replace: value }));
  }
});

test('raw API authenticates, inserts, rejects duplicates, explicitly replaces and persists', async t => {
  const { base, post, databasePath } = await running(t);
  assert.equal((await post(row, { headers: { Authorization: '' } })).status, 401);
  assert.equal((await post(row, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const inserted = await post(row);
  assert.equal(inserted.status, 201);
  assert.deepEqual(await inserted.json(), { replaced: false, serverName: row.serverName });
  assert.equal((await post({ ...row, serverName: row.serverName.toUpperCase() })).status, 409);
  const replaced = await post({ ...row, replace: true, qsv: false, ramGiB: 64, swapGiB: 0 });
  assert.equal(replaced.status, 200);
  assert.deepEqual(await replaced.json(), { replaced: true, serverName: row.serverName });
  const records = await (await fetch(base + '/api/servers')).json();
  assert.equal(records.length, 1);
  assert.equal(Object.keys(records[0]).length, 10);
  assert.equal(records[0].datacenter, 'le4');
  assert.equal(records[0].ramBytes, 64 * 1024 ** 3);
  assert.equal(records[0].swapBytes, 0);
  assert.equal(records[0].qsv, false);
  const db = openDatabase(databasePath);
  try { assert.deepEqual(db.list(), records); } finally { db.close(); }
  // Explicit replacement also creates a hostname that is not yet present.
  assert.equal((await post({ ...row, serverName: 'lt5-1-58-111alue.pulsedmedia.com', replace: true })).status, 201);
});

test('YABS uploads and direct rows share duplicate and replacement behavior', async t => {
  const { base, post } = await running(t);
  assert.equal((await post(yabs, { path: '/api/servers' })).status, 201);
  assert.equal((await post(row)).status, 409);
  assert.equal((await post({ ...row, replace: true })).status, 200);
  assert.equal((await post(yabs, { path: '/api/servers' })).status, 409);
  assert.equal((await post({ ...yabs, replace: true }, { path: '/api/servers' })).status, 200);
  const records = await (await fetch(base + '/api/servers')).json();
  assert.equal(records.length, 1);
  assert.equal(records[0].qsv, false);
});

test('raw API enforces request validation and size/depth limits without writing bad rows', async t => {
  const { base, post } = await running(t);
  for (const body of ['{bad}', [row], { ...row, qsv: 'yes' }, { ...row, ramGiB: '32' }, { ...row, privileged: true }, { ...row, serverName: '<script>bad</script>' }]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal((await post(row, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post({ ...row, processorName: 'x'.repeat(1024 * 1024) })).status, 413);
  assert.equal((await post('['.repeat(40) + '0' + ']'.repeat(40))).status, 400);
  assert.equal((await post(row, { path: '/api/servers' })).status, 400);
  assert.deepEqual(await (await fetch(base + '/api/servers')).json(), []);
  const text = "<script>alert('x')</script>'); DROP TABLE servers;--";
  assert.equal((await post({ ...row, processorName: text })).status, 201);
  const response = await fetch(base + '/api/servers');
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await response.json())[0].processorName, text);
  assert.equal((await post({ ...row, replace: true, processorMhz: null, swapGiB: null })).status, 200);
  const updated = await (await fetch(base + '/api/servers')).json();
  assert.equal(updated[0].processorMhz, null);
  assert.equal(updated[0].swapBytes, null);
});

test('raw endpoint shares failed-auth rate limits with YABS and respects disabled uploads', async t => {
  const { post } = await running(t, { uploadLimit: 2 });
  assert.equal((await post(row, { headers: { Authorization: 'wrong' } })).status, 401);
  assert.equal((await post(yabs, { path: '/api/servers', headers: { Authorization: 'wrong' } })).status, 401);
  const limited = await post(row);
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  const disabled = await running(t, { uploadToken: '' });
  assert.equal((await disabled.post(row)).status, 503);
});
