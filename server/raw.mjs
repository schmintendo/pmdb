import { InputError, normalizeHostname } from './yabs.mjs';

const fields = new Set([
  'serverName', 'processorName', 'coreCount', 'processorMhz',
  'ramGiB', 'swapGiB', 'storageTiB', 'qsv', 'kvm', 'replace',
]);

function numeric(value, label, { integer = false, allowZero = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value > Number.MAX_SAFE_INTEGER || (allowZero ? value < 0 : value <= 0)
    || (integer && !Number.isSafeInteger(value))) {
    throw new InputError(`${label} must be a ${allowZero ? 'nonnegative' : 'positive'} ${integer ? 'integer' : 'JSON number'}.`);
  }
  return value;
}

function capacity(value, label, factor, allowZero = false) {
  const bytes = Math.round(numeric(value, label, { allowZero }) * factor);
  if (!Number.isSafeInteger(bytes) || (!allowZero && bytes === 0)) {
    throw new InputError(`${label} is outside the supported byte range.`);
  }
  return bytes;
}

export function parseRawSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Expected one server object.');
  for (const key of Object.keys(body)) if (!fields.has(key)) throw new InputError('Unexpected submission field.');
  const serverName = normalizeHostname(body.serverName);
  if (typeof body.processorName !== 'string' || !body.processorName.trim()
    || body.processorName.length > 300 || /[\x00-\x1f\x7f]/.test(body.processorName)) {
    throw new InputError('Processor name is missing or invalid.');
  }
  if (typeof body.qsv !== 'boolean') throw new InputError('Intel QuickSync (qsv) must be true or false.');
  if (body.kvm != null && typeof body.kvm !== 'boolean') throw new InputError('KVM (kvm) must be true, false, or null.');
  if (body.replace !== undefined && typeof body.replace !== 'boolean') throw new InputError('Replace must be true or false.');
  return {
    serverName,
    processorName: body.processorName.trim(),
    coreCount: numeric(body.coreCount, 'Core count', { integer: true }),
    processorMhz: body.processorMhz == null ? null : numeric(body.processorMhz, 'Processor MHz'),
    ramBytes: capacity(body.ramGiB, 'RAM (GiB)', 1024 ** 3),
    swapBytes: body.swapGiB == null ? null : capacity(body.swapGiB, 'SWAP (GiB)', 1024 ** 3, true),
    storageBytes: capacity(body.storageTiB, 'Total storage (TiB)', 1024 ** 4, true),
    qsv: body.qsv,
    kvm: body.kvm ?? null,
  };
}
