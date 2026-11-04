import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const PLAN_CATALOG_URL = 'https://pulsedmedia.com/data/v1/products.json';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_PLANS = 1000;

function planName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('The plan catalog contains an invalid plan name.');
  }
  return value.trim().normalize('NFC');
}

function sortedNames(names) {
  const unique = [...new Set(names)];
  if (!unique.length || unique.length > MAX_PLANS) throw new Error('The plan list must contain 1–1000 names.');
  return unique.sort(new Intl.Collator('en', { numeric: true }).compare);
}

export function normalizePlanNames(feed) {
  if (!feed || typeof feed !== 'object' || feed.schema_version !== 1 || !Array.isArray(feed.products)
    || !feed.products.length || feed.products.length > 2000) {
    throw new Error('The public product catalog has an unsupported schema.');
  }
  const names = [];
  for (const product of feed.products) {
    if (!product || typeof product !== 'object' || Array.isArray(product)
      || !Number.isSafeInteger(product.id) || product.id <= 0 || typeof product.type !== 'string') {
      throw new Error('The public product catalog contains an invalid product.');
    }
    // Hosting/dedicated plans can live on nodes; AI credits and other add-ons cannot.
    if (['hostingaccount', 'server'].includes(product.type)) names.push(planName(product.name));
  }
  // Sold-out products remain selectable: current users can still have those plans.
  return sortedNames(names);
}

export function mergePlanNames(current, incoming) {
  if (!Array.isArray(current) || current.length > MAX_PLANS) throw new Error('The existing plan list is invalid.');
  const previous = current.map(planName);
  // Discard the original development placeholder only when it is the entire old list.
  const retained = previous.length === 1 && previous[0] === 'Plan 1' ? [] : previous;
  return sortedNames([...retained, ...incoming.map(planName)]);
}

async function limitedJson(response) {
  if (!response.ok) throw new Error(`Public product catalog request failed (HTTP ${response.status}).`);
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    throw new Error('The public product catalog did not return JSON.');
  }
  if (Number(response.headers.get('content-length')) > MAX_FEED_BYTES || !response.body) throw new Error('The public product catalog is too large or empty.');
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) throw new Error('The public product catalog is too large.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function syncPlans({ outputPath = process.env.PLANS_PATH || resolve(ROOT, 'config/plans.json'), fetchImpl = fetch } = {}) {
  const destination = resolve(outputPath);
  const response = await fetchImpl(PLAN_CATALOG_URL, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000), redirect: 'error',
  });
  const feed = await limitedJson(response);
  const incoming = normalizePlanNames(feed);
  let existing = [];
  try { existing = JSON.parse(await readFile(destination, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const names = mergePlanNames(existing, incoming);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = resolve(dirname(destination), `.plans-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(names, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { count: names.length, fetchedCount: incoming.length, generatedAt: typeof feed.generated_at === 'string' ? feed.generated_at : null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await syncPlans();
    console.log(`Saved ${result.count} plan names (${result.fetchedCount} from the public catalog${result.generatedAt ? `, generated ${result.generatedAt}` : ''}).`);
  } catch (error) {
    console.error(`Plan sync failed; existing plan list retained: ${error.message}`);
    process.exitCode = 1;
  }
}
