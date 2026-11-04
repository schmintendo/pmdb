import { InputError } from './input-error.mjs';

export function boundedText(value, label, max = 200, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new InputError(`${label} is missing or invalid.`);
  const text = value.trim();
  if (!text && !nullable) throw new InputError(`${label} is required.`);
  return text || null;
}

export function submissionIdentity(body) {
  // This is a contributor-chosen identifier, not a verified node account.
  // Keep its original case and punctuation so existing entries still match.
  const username = boundedText(body.username, 'Submission identifier', 64);
  const plan = typeof body.plan === 'string' && !body.plan.trim() ? null : boundedText(body.plan, 'Plan', 100, true);
  const userCount = body.userCount == null || (typeof body.userCount === 'string' && !body.userCount.trim()) ? null : body.userCount;
  if (userCount !== null && (!Number.isSafeInteger(userCount) || userCount < 0 || userCount > 10_000_000)) throw new InputError('Reported user count must be an integer from 0 to 10000000.');
  return { username, plan, userCount };
}

// Only the Intel N100 is established as supporting QuickSync in this catalog.
// Token boundaries prevent names such as N1000 from inheriting that status.
export function inferQuickSync(processorName) {
  return typeof processorName === 'string'
    && /(?:^|[^a-z0-9])intel(?=$|[^a-z0-9])/i.test(processorName)
    && /(?:^|[^a-z0-9])n100(?=$|[^a-z0-9])/i.test(processorName);
}

export function systemInformation(value, strict = false) {
  if (value == null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new InputError('System information must be an object.');
  const fields = { distro: 200, kernel: 200, arch: 64, vm: 64 };
  if (strict) for (const key of Object.keys(value)) if (!Object.hasOwn(fields, key)) throw new InputError('Unexpected system information field.');
  return Object.fromEntries(Object.entries(fields).map(([key, max]) => [key, boundedText(value[key], `System ${key}`, max, true)]));
}
