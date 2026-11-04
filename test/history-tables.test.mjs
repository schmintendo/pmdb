import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRuns, diskBlock, diskSpeed, networkEndpoints, networkMode } from '../src/history-tables.mjs';

test('disk display converts fio KiB/s stored as YABS KBps to terminal decimal units', () => {
  const samples = [
    ['4k', 450, 460.8, 'KB/s'],
    ['64k', 6377, 6.530048, 'MB/s'],
    ['512k', 34190, 35.01056, 'MB/s'],
    ['1m', 35625, 36.48, 'MB/s'],
  ];
  for (const [block, raw, expected, unit] of samples) {
    const converted = diskSpeed(raw, 'KBps', block);
    assert.equal(converted.units, unit);
    assert.ok(Math.abs(converted.value - expected) < 1e-9, `${block} throughput`);
  }
  assert.deepEqual(diskSpeed(0, 'KBps', '4k'), { value: 0, units: 'KB/s' });
  assert.equal(diskSpeed(null, 'KBps', '1m'), null);
  assert.deepEqual(diskSpeed(1000, 'KB/s', '64k'), { value: 1, units: 'MB/s' });
  assert.deepEqual(diskSpeed(1, 'MiBps', '1m'), { value: 1.048576, units: 'MB/s' });
  assert.deepEqual(diskSpeed(12, null, '64k'), { value: 12, units: '' });
  assert.equal(diskBlock(' 64 KiB '), '64k');
  assert.equal(diskBlock('1M'), '1m');
  assert.equal(diskBlock('8k'), '8k', 'raw API block sizes remain distinguishable');
});

test('provider columns retain endpoints across dates and separate locations and IP families', () => {
  const runs = [
    { id: 3, tests: [
      { mode: 'IPv4', provider: 'Provider A', location: 'Helsinki' },
      { mode: 'IPv4', provider: 'Provider A', location: 'London' },
      { mode: 'IPv6', provider: 'IPv6 only', location: 'Paris' },
    ] },
    { id: 2, tests: [
      { mode: 'ipv4', provider: 'Provider A', location: 'Helsinki' },
      { mode: 'IPv4', provider: 'Retired provider', location: 'New York' },
    ] },
  ];
  assert.deepEqual(networkEndpoints(runs, 'IPv4').map(({ provider, location }) => [provider, location]), [
    ['Provider A', 'Helsinki'], ['Provider A', 'London'], ['Retired provider', 'New York'],
  ]);
  assert.deepEqual(networkEndpoints(runs, 'IPv6').map(({ provider }) => provider), ['IPv6 only']);
  assert.equal(networkMode(' ipv6 '), 'IPv6');
  assert.equal(networkMode(null), 'Network');
});

test('appending older pages preserves loaded runs without duplicate date rows', () => {
  const previous = [{ id: 3 }, { id: 2 }];
  assert.deepEqual(appendRuns(previous, [{ id: 2 }, { id: 1 }, { id: 1 }]), [{ id: 3 }, { id: 2 }, { id: 1 }]);
  assert.equal(previous.length, 2);
});
