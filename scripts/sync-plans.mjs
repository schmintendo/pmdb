import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

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

function sortedNames(names, allowEmpty = false) {
  const unique = [...new Set(names)];
  if ((!unique.length && !allowEmpty) || unique.length > MAX_PLANS) throw new Error('The plan list must contain 1–1000 names.');
  return unique.sort(new Intl.Collator('en', { numeric: true }).compare);
}

export function isDedicatedServerPlan(product) {
  // The public feed currently calls dedicated machines "hostingaccount" too.
  // Exclude its dedicated product families as well as correctly typed servers.
  return product.type === 'server'
    || /\bMiniDedi\b|^MD\d+\b|^F\d+-MDS(?:[-\s]|$)|^Dell C1100\b|^QCS210 Storage\b|\bdedicated[\s-]+(?:servers?|nodes?|boxes?)\b/i.test(product.name);
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
    if (!['hostingaccount', 'server'].includes(product.type)) continue;
    const name = planName(product.name);
    if (!isDedicatedServerPlan({ ...product, name })) names.push(name);
  }
  // Sold-out products remain selectable: current users can still have those plans.
  return sortedNames(names, true);
}

function existingNames(current) {
  if (!Array.isArray(current) || current.length > MAX_PLANS) throw new Error('The existing plan list is invalid.');
  const previous = current.map(planName);
  if (new Set(previous).size !== previous.length) throw new Error('The existing plan list contains duplicate names.');
  return previous;
}

export function mergePlanNames(current, approved) {
  const previous = existingNames(current);
  const known = new Set(previous);
  const additions = sortedNames(approved.map(planName), true).filter(name => !known.has(name));
  const result = [...previous, ...additions];
  if (!result.length || result.length > MAX_PLANS) throw new Error('The plan list must contain 1–1000 names.');
  return result;
}

export function parsePlanSelection(answer, candidates) {
  const text = answer.trim().toLowerCase();
  if (['', 'none', 'n', 'no'].includes(text)) return [];
  if (text === 'all') return [...candidates];
  const indexes = new Set();
  for (const token of text.split(/[\s,]+/)) {
    const match = token.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error('Enter plan numbers, ranges such as 2-4, all, or none.');
    const start = Number(match[1]), end = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > candidates.length) {
      throw new Error(`Choose numbers from 1 to ${candidates.length}.`);
    }
    for (let index = start; index <= end; index++) indexes.add(index - 1);
  }
  return candidates.filter((_, index) => indexes.has(index));
}

export async function promptForPlans(candidates, { input = process.stdin, output = process.stdout, ask } = {}) {
  if (!candidates.length) return [];
  if (!ask && (!input.isTTY || !output.isTTY)) {
    throw new Error('New plans require admin approval. Run npm run sync-plans in an interactive terminal; no plans were added.');
  }
  const terminal = ask ? null : createInterface({ input, output });
  const cancelled = new AbortController();
  terminal?.once('close', () => cancelled.abort());
  const question = ask || (text => terminal.question(text, { signal: cancelled.signal }));
  try {
    output.write(`\nFound ${candidates.length} new eligible plan(s):\n`);
    candidates.forEach((name, index) => output.write(`  ${index + 1}. ${name}\n`));
    let selected;
    for (;;) {
      const answer = await question('Which plans should be added? Enter numbers (1,3 or 2-4), all, or press Enter for none: ');
      try { selected = parsePlanSelection(answer, candidates); break; }
      catch (error) { output.write(`${error.message}\n`); }
    }
    if (!selected.length) return [];
    output.write(`\nSelected plans:\n${selected.map(name => `  - ${name}`).join('\n')}\n`);
    const confirmation = (await question(`Add these ${selected.length} plan(s) to plans.json? [y/N] `)).trim();
    return /^(?:y|yes)$/i.test(confirmation) ? selected : [];
  } finally { terminal?.close(); }
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

export async function syncPlans({ outputPath = process.env.PLANS_PATH || resolve(ROOT, 'config/plans.json'), fetchImpl = fetch, approveNewPlans = promptForPlans } = {}) {
  const destination = resolve(outputPath);
  const response = await fetchImpl(PLAN_CATALOG_URL, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000), redirect: 'error',
  });
  const feed = await limitedJson(response);
  const incoming = normalizePlanNames(feed);
  let original = null;
  try { original = await readFile(destination, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const existing = existingNames(original == null ? [] : JSON.parse(original));
  const known = new Set(existing);
  const candidates = incoming.filter(name => !known.has(name));
  const approved = candidates.length ? await approveNewPlans([...candidates]) : [];
  if (!Array.isArray(approved) || approved.some(name => !candidates.includes(name))) throw new Error('Only listed new plans can be approved.');
  const result = {
    count: existing.length, fetchedCount: incoming.length, newCount: candidates.length,
    addedCount: new Set(approved).size, changed: false,
    generatedAt: typeof feed.generated_at === 'string' ? feed.generated_at : null,
  };
  if (!approved.length) return result;
  const names = mergePlanNames(existing, approved);
  // A second administrator may have edited the list while this prompt was open.
  let current = null;
  try { current = await readFile(destination, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== original) throw new Error('plans.json changed during approval. Rerun sync-plans to review the current list.');
  await mkdir(dirname(destination), { recursive: true });
  const temporary = resolve(dirname(destination), `.plans-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(names, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { ...result, count: names.length, changed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await syncPlans();
    if (result.changed) console.log(`Added ${result.addedCount} approved plan(s). Saved ${result.count} plan names.`);
    else console.log(`No changes. ${result.count} approved plan names retained; ${result.newCount} new eligible plan(s) found.`);
  } catch (error) {
    console.error(`Plan sync failed; existing plan list retained: ${error.message}`);
    process.exitCode = 1;
  }
}
