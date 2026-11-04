import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYabs, parseSubmission } from '../server/yabs.mjs';
import { parseRawSubmission } from '../server/raw.mjs';
import { normalizedBenchmarks } from '../server/benchmarks.mjs';

const example = JSON.parse(readFileSync(new URL('../examples/yabs-example.json', import.meta.url), 'utf8'));
const raw = JSON.parse(readFileSync(new URL('../examples/server-row.json', import.meta.url), 'utf8'));
const submission = { serverName: raw.serverName, username: 'Node_User', plan: 'Plan 1', userCount: 0, qsv: true, yabsText: JSON.stringify(example) };

test('submissions require a consistent arbitrary identifier, plan and a strict reported user count', () => {
  const parsed = parseSubmission({ ...submission, username: '  Node_User  ', plan: ' Plan 1 ' });
  assert.equal(parsed.username, 'Node_User');
  assert.equal(parsed.plan, 'Plan 1');
  assert.equal(parsed.userCount, 0);
  for (const field of ['username', 'plan', 'userCount']) {
    const body = { ...submission }; delete body[field];
    assert.throws(() => parseSubmission(body), field);
    const row = { ...raw }; delete row[field];
    assert.throws(() => parseRawSubmission(row), field);
  }
  for (const username of ['', '   ', 'x'.repeat(65), 'bad\n', 'bad\0identifier', null, 123]) assert.throws(() => parseSubmission({ ...submission, username }));
  for (const username of ['user.one', 'User_2', 'seed-box', 'svc$', 'my nickname', 'a@host', '../not-a-filename', 'ユーザー']) {
    assert.equal(parseSubmission({ ...submission, username }).username, username);
    assert.equal(parseRawSubmission({ ...raw, username }).username, username);
  }
  for (const userCount of ['0', -1, 0.5, null, true, NaN, Infinity, 10_000_001]) assert.throws(() => parseSubmission({ ...submission, userCount }));
  assert.throws(() => parseSubmission({ ...submission, plan: 'x'.repeat(101) }));
  assert.throws(() => parseSubmission({ ...submission, privileged: true }));
});

test('YABS output retains only allowed OS details and normalized benchmark measurements', () => {
  const parsed = parseYabs(JSON.stringify({ ...example, os: { ...example.os, private: 'discarded' }, ip_info: { ip: 'discarded' } }));
  assert.deepEqual(parsed.system, { distro: example.os.distro, kernel: example.os.kernel, arch: 'x64', vm: 'NONE' });
  assert.equal(parsed.benchmarks.measuredAt, new Date(example.runtime.start * 1000).toISOString());
  assert.deepEqual(parsed.benchmarks.speedTests[0], { mode: 'IPv4', provider: 'Example test provider', location: 'Example location', send: '1.20 Gbits/sec', receive: '1.15 Gbits/sec', latency: '12.5 ms' });
  assert.deepEqual(parsed.benchmarks.diskIo[0], { blockSize: '4k', read: 50000, write: 51000, combined: 101000, readIops: 12500, writeIops: 12750, combinedIops: 25250, speedUnits: 'KBps' });
  assert.equal('ip_info' in parsed, false);
  const skipped = { ...example }; delete skipped.iperf; delete skipped.fio; delete skipped.runtime; delete skipped.os;
  assert.deepEqual(parseYabs(JSON.stringify(skipped)).benchmarks, { measuredAt: null, speedTests: [], diskIo: [] });
  const localTimeOnly = { ...skipped, time: '20261102-123456' };
  assert.equal(parseYabs(JSON.stringify(localTimeOnly)).benchmarks.measuredAt, null);
});

test('benchmark parsing preserves zero, missing measurements, busy and failed results', () => {
  const data = { ...example, iperf: [{ mode: 'IPv6', send: 'busy ', recv: 'failed', latency: null }], fio: [{ bs: '64k', speed_r: 0, speed_units: 'KBps' }] };
  const result = parseYabs(JSON.stringify(data)).benchmarks;
  assert.equal(result.speedTests[0].send, 'busy');
  assert.equal(result.speedTests[0].receive, 'failed');
  assert.equal(result.speedTests[0].latency, null);
  assert.equal(result.diskIo[0].read, 0);
  assert.equal(result.diskIo[0].write, null);
  const text = 'Processor : Example CPU\nCPU cores : 4 @ 2000 MHz\nRAM : 8 GiB\nDisk : 1 TiB\nDistro : Example Linux\nVM Type : KVM';
  const parsed = parseYabs(text);
  assert.equal(parsed.system.distro, 'Example Linux');
  assert.equal(parsed.system.vm, 'KVM');
  assert.equal(parsed.kvm, true);
  assert.deepEqual(parsed.benchmarks, { measuredAt: null, speedTests: [], diskIo: [] });
});

test('raw API accepts the same normalized system and benchmark contract', () => {
  const yabs = parseYabs(JSON.stringify(example));
  const parsed = parseRawSubmission({ ...raw, system: yabs.system, benchmarks: yabs.benchmarks });
  assert.deepEqual(parsed.system, yabs.system);
  assert.deepEqual(parsed.benchmarks, yabs.benchmarks);
  assert.equal(parsed.username, raw.username);
  assert.deepEqual(parseRawSubmission(raw).benchmarks, { measuredAt: null, speedTests: [], diskIo: [] });
  assert.throws(() => parseRawSubmission({ ...raw, system: { secret: 'no' } }));
  assert.throws(() => parseRawSubmission({ ...raw, benchmarks: { secret: 'no' } }));
});

test('benchmarks reject excessive arrays, malformed metrics and invalid measurement timestamps', () => {
  for (const benchmarks of [[], 'not an object', { speedTests: Array(101).fill({}) }, { diskIo: Array(33).fill({}) }, { speedTests: [null] }, { diskIo: [{ blockSize: '4k', read: '20' }] }, { diskIo: [{ blockSize: '4k', write: -1 }] }, { diskIo: [{ blockSize: '4k', combined: Infinity }] }, { diskIo: [{ blockSize: '4k', speedUnits: 'nonsense' }] }, { speedTests: [{ send: 'x'.repeat(81) }] }, { speedTests: [{ send: 'bad\n' }] }]) assert.throws(() => normalizedBenchmarks(benchmarks));
  for (const measuredAt of ['not a date', '2026-02-30T12:00:00Z', '2026-11-02 12:00:00', '2026-11-02T12:00:00+01:00', 123]) assert.throws(() => normalizedBenchmarks({ measuredAt }));
  assert.equal(normalizedBenchmarks({ measuredAt: '2026-11-02T12:00:00Z' }).measuredAt, '2026-11-02T12:00:00.000Z');
  for (const runtime of [{ start: '123' }, { start: -1 }, { start: 1e100 }, { start: 1.2 }]) assert.throws(() => parseYabs(JSON.stringify({ ...example, runtime })));
});
