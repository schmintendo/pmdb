import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/index.mjs';
import { openDatabase } from '../server/database.mjs';
import { parseRawSubmission } from '../server/raw.mjs';
import { nodeFilePath } from '../server/node-store.mjs';

const hostname = 'le4-0-105-238louhi.pulsedmedia.com';
const row = {
  serverName: hostname, processorName: 'Example CPU', coreCount: 8,
  processorMhz: 2500, ramGiB: 32, swapGiB: 8, storageTiB: 4,
  qsv: true, kvm: false, username: 'member-private-a', plan: 'Plan 1', userCount: 24,
};
function yabs(at = 1700000000) {
  return JSON.stringify({
    os: { distro: 'Debian 12', kernel: '6.1.0', arch: 'x64', vm: 'NONE' },
    cpu: { model: 'Example CPU', cores: 8, freq: '2500 MHz' },
    mem: { ram: 32, ram_units: 'GiB', swap: 8, swap_units: 'GiB', disk: 4, disk_units: 'TiB' },
    runtime: { start: at },
    iperf: [{ mode: 'IPv4', provider: 'Test provider', loc: 'Helsinki', send: '1.2 Gbits/sec', recv: '900 Mbits/sec', latency: '12 ms' }],
    fio: [{ bs: '4k', speed_r: 10000, speed_w: 9000, speed_rw: 19000, iops_r: 2500, iops_w: 2250, iops_rw: 4750, speed_units: 'KBps' }],
  });
}
const submission = (extra = {}) => ({ serverName: hostname, qsv: true, username: row.username, plan: row.plan, userCount: row.userCount, yabsText: yabs(), ...extra });

async function running(t, options = {}, prepare) {
  const directory = mkdtempSync(join(tmpdir(), 'pmdb-nodes-'));
  const databasePath = join(directory, 'servers.sqlite');
  const distPath = join(directory, 'dist');
  mkdirSync(distPath);
  writeFileSync(join(distPath, 'index.html'), '<h1>Node application</h1>');
  if (prepare) prepare(databasePath);
  const app = createApp({ databasePath, distPath, plans: ['Plan 1', 'Plan 2'], ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (body, path = '/api/servers') => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const detail = async (suffix = '', server = hostname) => {
    const response = await fetch(base + '/api/nodes/' + encodeURIComponent(server) + suffix);
    return { response, body: await response.json() };
  };
  return { app, base, post, detail, directory, databasePath, distPath };
}

test('node submissions aggregate plans by node and username, retaining distinct benchmark runs', async t => {
  const { post, detail, directory } = await running(t);
  assert.equal((await post(submission())).status, 201);
  let node = (await detail()).body;
  assert.equal(node.friendlyName, 'louhi');
  assert.equal(node.server.datacenter, 'le4');
  assert.equal(node.userCount, 24);
  assert.equal(node.system.distro, 'Debian 12');
  assert.deepEqual(node.plans, [{ name: 'Plan 1', count: 1 }]);
  assert.equal(node.contributors, 1);
  assert.equal(node.history.speedTests.length, 1);
  assert.equal(node.history.diskIo.length, 1);
  assert.equal(node.history.speedTests[0].tests[0].send, '1.2 Gbits/sec');
  assert.equal(node.history.diskIo[0].tests[0].read, 10000);
  assert.ok(!JSON.stringify(node).includes(row.username));
  assert.equal(readdirSync(join(directory, 'nodes')).filter(name => name.endsWith('.sqlite')).length, 1);

  assert.equal((await post(submission())).status, 200);
  node = (await detail()).body;
  assert.equal(node.contributors, 1);
  assert.equal(node.history.speedTests.length, 1, 'identical same-user file is not a new run');
  await post(submission({ plan: 'Plan 2', userCount: 25, yabsText: yabs(1700000100) }));
  node = (await detail()).body;
  assert.deepEqual(node.plans, [{ name: 'Plan 2', count: 1 }]);
  assert.equal(node.contributors, 1);
  assert.equal(node.userCount, 25);
  assert.equal(node.history.speedTests.length, 2);
  await post(submission({ username: 'member-private-b', plan: 'Plan 2', yabsText: yabs(1700000200) }));
  node = (await detail()).body;
  assert.deepEqual(node.plans, [{ name: 'Plan 2', count: 2 }]);
  assert.equal(node.contributors, 2);
  assert.equal(node.history.speedTests.length, 3);

  await post({ ...row, username: 'member-private-a', plan: 'Plan 1', coreCount: 16 }, '/api/servers/raw');
  node = (await detail()).body;
  assert.deepEqual(node.plans, [{ name: 'Plan 1', count: 1 }, { name: 'Plan 2', count: 1 }]);
  assert.equal(node.server.coreCount, 16);
  assert.equal(node.contributors, 2);
  assert.equal(node.history.speedTests.length, 3, 'hardware-only submission does not invent a speed test');
});

test('same username on different nodes has independent plan membership and database files', async t => {
  const { post, detail, directory } = await running(t);
  await post(submission());
  const other = 'lt5-1-58-111alue.pulsedmedia.com';
  await post(submission({ serverName: other }));
  const second = (await detail('', other)).body;
  assert.equal(second.friendlyName, 'alue');
  assert.equal(second.contributors, 1);
  assert.deepEqual(second.plans, [{ name: 'Plan 1', count: 1 }]);
  assert.equal((await detail()).body.contributors, 1);
  assert.equal(readdirSync(join(directory, 'nodes')).filter(name => name.endsWith('.sqlite')).length, 2);
});

test('arbitrary private identifiers safely deduplicate and update plans without credentials', async t => {
  const { post, detail, directory } = await running(t);
  const identifier = "My nickname / '; DROP TABLE participants;--";
  assert.equal((await post(submission({ username: identifier }))).status, 201);
  assert.equal((await post(submission({ username: `  ${identifier}  `, plan: 'Plan 2' }))).status, 200);
  let node = (await detail()).body;
  assert.equal(node.contributors, 1);
  assert.deepEqual(node.plans, [{ name: 'Plan 2', count: 1 }]);
  assert.equal(node.pagination.totalRuns, 1);
  assert.ok(!JSON.stringify(node).includes(identifier));
  assert.equal(readdirSync(join(directory, 'nodes')).filter(name => name.endsWith('.sqlite')).length, 1);
  assert.equal((await post(submission({ username: identifier.toLowerCase() }))).status, 200);
  node = (await detail()).body;
  assert.equal(node.contributors, 2, 'identifiers preserve case to match existing entries');
});

test('existing catalog records automatically receive empty node databases and public detail pages', async t => {
  const { base, detail, directory } = await running(t, {}, filename => {
    const db = openDatabase(filename);
    try { db.save(parseRawSubmission(row)); } finally { db.close(); }
  });
  assert.equal(readdirSync(join(directory, 'nodes')).filter(name => name.endsWith('.sqlite')).length, 1);
  const node = (await detail()).body;
  assert.equal(node.server.serverName, hostname);
  assert.equal(node.userCount, null);
  assert.equal(node.contributors, 0);
  assert.deepEqual(node.history.speedTests, []);
  assert.deepEqual(node.history.diskIo, []);
  const direct = await fetch(base + '/nodes/' + hostname);
  assert.equal(direct.status, 200);
  assert.match(direct.headers.get('content-type'), /text\/html/);
  assert.match(await direct.text(), /Node application/);
  for (const file of readdirSync(join(directory, 'nodes'))) {
    assert.equal((await fetch(base + '/data/nodes/' + file)).status, 404);
  }
});

test('node detail validates missing nodes, query bounds, submissions and plan choices', async t => {
  const { base, post, detail, directory } = await running(t);
  assert.equal((await detail()).response.status, 404);
  assert.equal(readdirSync(join(directory, 'nodes')).length, 0);
  for (const extra of [{ username: '' }, { username: 'bad\0identifier' }, { userCount: -1 }, { userCount: '24' }, { userCount: 1.5 }, { plan: 'Unlisted plan' }]) {
    assert.equal((await post(submission(extra))).status, 400);
  }
  const missing = submission(); delete missing.username;
  assert.equal((await post(missing)).status, 400);
  assert.equal((await detail()).response.status, 404);
  assert.deepEqual(await (await fetch(base + '/api/servers')).json(), []);
  await post(submission());
  for (const query of ['?limit=0', '?limit=101', '?limit=abc', '?offset=-1', '?offset=1.5']) {
    assert.equal((await detail(query)).response.status, 400, query);
  }
  assert.equal((await fetch(base + '/api/nodes/' + encodeURIComponent('../servers.sqlite'))).status, 400);
  const configuration = await (await fetch(base + '/api/config')).json();
  assert.deepEqual(configuration.plans, ['Plan 1', 'Plan 2']);
});

test('node benchmark history paginates newest-first and survives process restart', async t => {
  const { app, base, post, detail, databasePath, distPath } = await running(t);
  for (const at of [1700000000, 1700000100, 1700000200]) await post(submission({ yabsText: yabs(at) }));
  const first = (await detail('?limit=1&offset=0')).body;
  const second = (await detail('?limit=1&offset=1')).body;
  assert.equal(first.pagination.totalRuns, 3);
  assert.equal(first.history.speedTests.length, 1);
  assert.equal(first.history.diskIo.length, 1);
  assert.notEqual(first.history.speedTests[0].id, second.history.speedTests[0].id);
  assert.ok(first.history.speedTests[0].measuredAt > second.history.speedTests[0].measuredAt);
  const other = createApp({ databasePath, distPath, plans: ['Plan 1', 'Plan 2'] });
  await new Promise(resolve => other.server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${other.server.address().port}/api/nodes/${hostname}`);
    const reopened = await response.json();
    assert.equal(reopened.contributors, 1);
    assert.equal(reopened.pagination.totalRuns, 3);
    assert.equal(reopened.history.diskIo.length, 3);
  } finally { await other.close(); }
});

test('backup captures the catalog plus participant and benchmark data and restores both', async t => {
  const { post, databasePath, directory, distPath } = await running(t);
  await post(submission());
  await post(submission({ username: 'member-private-b', yabsText: yabs(1700000100) }));
  const target = join(directory, 'backup.sqlite');
  const result = spawnSync(process.execPath, ['scripts/backup.mjs', target], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATABASE_PATH: databasePath, NODE_DATABASE_DIR: join(directory, 'nodes') }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(target + '.nodes', 'manifest.json'), 'utf8'));
  assert.equal(manifest.nodeFiles.length, 1);
  const restored = createApp({ databasePath: target, nodesPath: target + '.nodes', distPath, plans: ['Plan 1', 'Plan 2'] });
  await new Promise(resolve => restored.server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${restored.server.address().port}/api/nodes/${hostname}`);
    const node = await response.json();
    assert.equal(node.contributors, 2);
    assert.deepEqual(node.plans, [{ name: 'Plan 1', count: 2 }]);
    assert.equal(node.pagination.totalRuns, 2);
    assert.equal(node.history.diskIo.length, 2);
  } finally { await restored.close(); }
  const repeat = spawnSync(process.execPath, ['scripts/backup.mjs', target], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, DATABASE_PATH: databasePath }, encoding: 'utf8',
  });
  assert.notEqual(repeat.status, 0, 'existing backups must never be overwritten');
});

test('a failed node write rolls back catalog hardware and node data together', async t => {
  const { base, post, detail, directory } = await running(t);
  await post(submission());
  const filename = nodeFilePath(join(directory, 'nodes'), hostname);
  const nodeDb = new DatabaseSync(filename);
  nodeDb.exec("CREATE TRIGGER reject_participant BEFORE INSERT ON participants BEGIN SELECT RAISE(ABORT, 'test write rejection'); END;");
  nodeDb.close();
  const response = await post({ ...row, coreCount: 99, userCount: 80, plan: 'Plan 2' }, '/api/servers/raw');
  assert.equal(response.status, 500);
  assert.equal((await (await fetch(base + '/api/servers')).json())[0].coreCount, 8);
  const node = (await detail()).body;
  assert.equal(node.userCount, 24);
  assert.deepEqual(node.plans, [{ name: 'Plan 1', count: 1 }]);
  assert.equal(node.pagination.totalRuns, 1);
  const repaired = new DatabaseSync(filename);
  repaired.exec('DROP TRIGGER reject_participant'); repaired.close();
  assert.equal((await post({ ...row, coreCount: 16 }, '/api/servers/raw')).status, 200);
});
