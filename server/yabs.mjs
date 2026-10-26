export class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

export function parseLimitedJson(text) {
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') { if (++depth > 32) throw new InputError('JSON nesting exceeds the limit of 32 levels.'); }
    else if (char === '}' || char === ']') depth--;
  }
  return JSON.parse(text);
}

export function normalizeHostname(value) {
  if (typeof value !== 'string') throw new InputError('Server Name is required. Use the server hostname.');
  const name = value.trim().toLowerCase().replace(/\.$/, '');
  if (name.length > 253 || !name || !name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new InputError('Server Name must be a valid hostname, such as le0-000-000name.pulsedmedia.com.');
  }
  return name;
}

export function datacenterFor(hostname) {
  const split = hostname.indexOf('-');
  return split > 0 ? hostname.slice(0, split) : 'Unknown';
}

function number(value, label, { integer = false, allowZero = false } = {}) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0) || (integer && !Number.isSafeInteger(n))) throw new InputError(`YABS ${label} is missing or invalid.`);
  return n;
}

function mhz(value) {
  if (value == null || /^(?:\?+(?:\s*MHz)?|unknown|n\/a|\s*)$/i.test(String(value).trim())) return null;
  if (typeof value === 'number') return number(value, 'processor MHz');
  const match = String(value).trim().match(/^([\d.]+)\s*(MHz|GHz|kHz|Hz)?$/i);
  if (!match) throw new InputError('YABS processor frequency is invalid. Expected MHz or GHz.');
  const factor = { mhz: 1, ghz: 1000, khz: .001, hz: .000001 }[(match[2] || 'MHz').toLowerCase()];
  return number(Number(match[1]) * factor, 'processor MHz');
}

function bytes(value, unit, label, legacyDisk = false) {
  const n = number(value, label, { allowZero: ['total storage', 'SWAP'].includes(label) });
  // Upstream YABS labels df's 1024-byte blocks as "KB" in disk JSON.
  const units = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: legacyDisk ? 1024 : 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4 };
  const factor = units[String(unit || '').trim().toLowerCase()];
  if (!factor) throw new InputError(`YABS ${label} has an unsupported or missing unit.`);
  const result = Math.round(n * factor);
  if (!Number.isSafeInteger(result)) throw new InputError(`YABS ${label} is too large.`);
  return result;
}

function textSize(value, label) {
  const match = value?.trim().match(/^([\d.]+)\s*(B|[KMGT]i?B)$/i);
  if (!match) throw new InputError(`YABS ${label} is missing or invalid.`);
  return bytes(match[1], match[2], label);
}

function kvmStatus(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 64 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new InputError('YABS VM type is invalid.');
  }
  const type = value.trim().toUpperCase();
  // Only these explicit reports establish the meaning of the KVM column.
  return type === 'KVM' ? true : type === 'NONE' ? false : null;
}

export function parseYabs(source) {
  if (typeof source !== 'string' || !source.trim()) throw new InputError('Choose a YABS JSON or text results file.');
  const clean = source.replace(/^\uFEFF/, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  let processorName, coreCount, processorMhz, ramBytes, storageBytes, swapBytes = null, kvm = null;
  if (clean.startsWith('{') || clean.startsWith('[')) {
    let data;
    try { data = parseLimitedJson(clean); } catch { throw new InputError('The YABS JSON file is malformed. Upload the file created with -w yabs.json.'); }
    if (!data || Array.isArray(data) || !data.cpu || !data.mem) throw new InputError('This JSON file is not a YABS result: cpu and mem are required.');
    processorName = data.cpu.model;
    coreCount = number(data.cpu.cores, 'core count', { integer: true });
    processorMhz = mhz(data.cpu.freq);
    ramBytes = bytes(data.mem.ram, data.mem.ram_units, 'RAM');
    if (data.mem.swap !== undefined) swapBytes = bytes(data.mem.swap, data.mem.swap_units, 'SWAP');
    storageBytes = bytes(data.mem.disk, data.mem.disk_units, 'total storage', true);
    kvm = kvmStatus(data.os?.vm);
  } else {
    const field = pattern => clean.match(pattern)?.[1];
    processorName = field(/^\s*(?:Processor|CPU Model)\s*:\s*(.+)$/im);
    const cpu = clean.match(/^\s*CPU cores\s*:\s*(\d+)\s*@\s*(.*?)\s*$/im);
    coreCount = number(cpu?.[1], 'core count', { integer: true });
    processorMhz = mhz(cpu?.[2]);
    ramBytes = textSize(field(/^\s*RAM\s*:\s*(.+)$/im), 'RAM');
    const swap = field(/^\s*Swap\s*:\s*(.+)$/im);
    if (swap !== undefined) swapBytes = textSize(swap, 'SWAP');
    storageBytes = textSize(field(/^\s*Disk\s*:\s*(.+)$/im), 'total storage');
    kvm = kvmStatus(field(/^[ \t]*VM Type[ \t]*:[ \t]*(.*)$/im));
  }
  if (typeof processorName !== 'string' || !processorName.trim() || processorName.length > 300 || /[\x00-\x1f]/.test(processorName)) throw new InputError('YABS processor name is missing or invalid.');
  return { processorName: processorName.trim(), coreCount, processorMhz, ramBytes, storageBytes, swapBytes, kvm };
}

export function parseSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Expected a submission object.');
  for (const key of Object.keys(body)) if (!['serverName', 'qsv', 'yabsText', 'replace'].includes(key)) throw new InputError('Unexpected submission field.');
  const serverName = normalizeHostname(body.serverName);
  if (typeof body.qsv !== 'boolean') throw new InputError('Choose Yes or No for Intel QuickSync.');
  if (body.replace !== undefined && typeof body.replace !== 'boolean') throw new InputError('Replace must be true or false.');
  return { serverName, qsv: body.qsv, ...parseYabs(body.yabsText) };
}
