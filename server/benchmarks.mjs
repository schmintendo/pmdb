import { InputError } from './input-error.mjs';
import { boundedText } from './submission.mjs';

const EMPTY = () => ({ measuredAt: null, speedTests: [], diskIo: [] });
const speedFields = ['mode', 'provider', 'location', 'send', 'receive', 'latency'];
const diskFields = ['blockSize', 'read', 'write', 'combined', 'readIops', 'writeIops', 'combinedIops', 'speedUnits'];

function list(value, label, limit) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > limit) throw new InputError(`${label} must be an array with at most ${limit} entries.`);
  return value;
}
function object(value, label, fields, strict) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${label} must be an object.`);
  if (strict) for (const key of Object.keys(value)) if (!fields.includes(key)) throw new InputError(`Unexpected ${label} field.`);
}
function metric(value, label) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new InputError(`${label} must be a nonnegative JSON number or null.`);
  return value;
}
function speed(value) {
  object(value, 'speed test', speedFields, true);
  const result = Object.fromEntries(speedFields.map(key => [key, boundedText(value[key], `Speed test ${key}`, key === 'provider' || key === 'location' ? 200 : 80, true)]));
  if (result.send == null && result.receive == null && result.latency == null) throw new InputError('Speed test contains no measurements.');
  return result;
}
function disk(value) {
  object(value, 'disk test', diskFields, true);
  const blockSize = boundedText(value.blockSize, 'Disk block size', 40);
  const speedUnits = boundedText(value.speedUnits, 'Disk speed units', 24, true);
  if (speedUnits != null && !['Bps', 'KBps', 'MBps', 'GBps', 'KiBps', 'MiBps', 'GiBps', 'B/s', 'KB/s', 'MB/s', 'GB/s', 'KiB/s', 'MiB/s', 'GiB/s'].includes(speedUnits)) throw new InputError('Unsupported disk speed units.');
  const measurements = Object.fromEntries(['read', 'write', 'combined', 'readIops', 'writeIops', 'combinedIops'].map(key => [key, metric(value[key], `Disk ${key}`)]));
  if (Object.values(measurements).every(value => value == null)) throw new InputError('Disk test contains no measurements.');
  return { blockSize, ...measurements, speedUnits };
}

export function normalizedBenchmarks(value) {
  if (value == null) return EMPTY();
  object(value, 'benchmarks', ['measuredAt', 'speedTests', 'diskIo'], true);
  let measuredAt = null;
  if (value.measuredAt != null) {
    if (typeof value.measuredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.measuredAt)) throw new InputError('Benchmark measuredAt must be a UTC ISO timestamp.');
    const date = new Date(value.measuredAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.measuredAt.slice(0, 19)) throw new InputError('Benchmark measuredAt is invalid.');
    measuredAt = date.toISOString();
  }
  return { measuredAt, speedTests: list(value.speedTests, 'Speed tests', 100).map(speed), diskIo: list(value.diskIo, 'Disk tests', 32).map(disk) };
}

export function yabsBenchmarks(data) {
  let measuredAt = null;
  if (data.runtime?.start != null) {
    const seconds = data.runtime.start;
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 253402300799) throw new InputError('YABS benchmark start time is invalid.');
    measuredAt = new Date(seconds * 1000).toISOString();
  }
  return normalizedBenchmarks({
    measuredAt,
    speedTests: list(data.iperf, 'YABS iperf tests', 100).map(test => {
      object(test, 'YABS iperf test', [], false);
      return { mode: test.mode, provider: test.provider, location: test.loc, send: test.send, receive: test.recv, latency: test.latency };
    }),
    diskIo: list(data.fio, 'YABS fio tests', 32).map(test => {
      object(test, 'YABS fio test', [], false);
      return { blockSize: test.bs, read: test.speed_r, write: test.speed_w, combined: test.speed_rw, readIops: test.iops_r, writeIops: test.iops_w, combinedIops: test.iops_rw, speedUnits: test.speed_units };
    }),
  });
}
