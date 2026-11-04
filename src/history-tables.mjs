export const DISK_BLOCKS = ['4k', '64k', '512k', '1m'];

export function networkMode(value) {
  const mode = String(value || '').trim();
  if (/^ipv[46]$/i.test(mode)) return mode.toUpperCase().replace('IPV', 'IPv');
  return mode || 'Network';
}

export function networkEndpoints(runs, mode) {
  const endpoints = new Map();
  for (const run of runs) for (const test of run.tests || []) {
    if (networkMode(test.mode) !== mode) continue;
    const provider = String(test.provider || '').trim() || 'Test endpoint';
    const location = String(test.location || '').trim();
    const key = JSON.stringify([provider, location]);
    if (!endpoints.has(key)) endpoints.set(key, { key, provider, location });
  }
  return [...endpoints.values()];
}

export function endpointKey(test) {
  return JSON.stringify([String(test.provider || '').trim() || 'Test endpoint', String(test.location || '').trim()]);
}

export function diskBlock(value) {
  const block = String(value || '').trim();
  const normalized = block.toLowerCase().replace(/\s/g, '');
  const canonical = normalized.match(/^(4|64|512)(?:k|kb|kib)$/)?.[1];
  if (canonical) return `${canonical}k`;
  if (/^1(?:m|mb|mib)$/.test(normalized)) return '1m';
  return block || 'Disk test';
}

// YABS labels the raw fio KiB/s measurements "KBps" in its JSON. Convert
// those binary source units into the decimal KB/s and MB/s shown here.
const bytesPerUnit = {
  Bps: 1, KBps: 1024, MBps: 1e6, GBps: 1e9,
  KiBps: 1024, MiBps: 1024 ** 2, GiBps: 1024 ** 3,
  'B/s': 1, 'KB/s': 1000, 'MB/s': 1e6, 'GB/s': 1e9,
  'KiB/s': 1024, 'MiB/s': 1024 ** 2, 'GiB/s': 1024 ** 3,
};

export function diskSpeed(value, units, blockSize) {
  if (value == null) return null;
  const factor = bytesPerUnit[units];
  if (!factor) return { value, units: units || '' };
  const small = diskBlock(blockSize) === '4k';
  return { value: value * factor / (small ? 1000 : 1e6), units: small ? 'KB/s' : 'MB/s' };
}

export function appendRuns(previous = [], incoming = []) {
  const seen = new Set(previous.map(run => run.id));
  return [...previous, ...incoming.filter(run => {
    if (seen.has(run.id)) return false;
    seen.add(run.id);
    return true;
  })];
}
