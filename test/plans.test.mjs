import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PLAN_CATALOG_URL, normalizePlanNames, mergePlanNames, syncPlans } from '../scripts/sync-plans.mjs';

const feed = {
  schema_version: 1, generated_at: '2026-11-03T02:45:01+00:00', products: [
    { id: 1, type: 'hostingaccount', name: 'M10G S', available: true },
    { id: 2, type: 'hostingaccount', name: 'Sold-out node plan', available: false },
    { id: 3, type: 'server', name: 'MiniDedi', available: false },
    { id: 4, type: 'other', name: 'AI Credits', available: true },
    { id: 5, type: 'hostingaccount', name: 'M10G S', available: true },
  ],
};
const reply = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });

test('public catalog selects hosting plans, keeps sold-out services, excludes credits and deduplicates names', () => {
  assert.deepEqual(normalizePlanNames(feed), ['M10G S', 'MiniDedi', 'Sold-out node plan']);
  for (const invalid of [null, {}, { ...feed, schema_version: 2 }, { ...feed, products: [] }, { ...feed, products: [{ id: 1, type: 'hostingaccount', name: 'x'.repeat(101) }] }]) {
    assert.throws(() => normalizePlanNames(invalid));
  }
});

test('plan refresh retains retired/custom plans and removes only the lone development placeholder', () => {
  assert.deepEqual(mergePlanNames(['Plan 1'], ['M10G S']), ['M10G S']);
  assert.deepEqual(mergePlanNames(['Retired plan', 'M10G S'], ['M10G S', 'MiniDedi']), ['M10G S', 'MiniDedi', 'Retired plan']);
  assert.deepEqual(mergePlanNames(['Plan 1', 'Custom plan'], ['M10G S']), ['Custom plan', 'M10G S', 'Plan 1']);
  assert.throws(() => mergePlanNames(['bad\nname'], ['M10G S']));
});

test('plan sync uses the fixed public endpoint without credentials and atomically updates the file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pmdb-plans-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'plans.json');
  await writeFile(outputPath, '["Plan 1"]\n');
  const result = await syncPlans({ outputPath, fetchImpl: async (url, options) => {
    assert.equal(url, PLAN_CATALOG_URL);
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(Object.keys(options.headers).length, 1);
    return reply(feed);
  } });
  assert.equal(result.count, 3);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), ['M10G S', 'MiniDedi', 'Sold-out node plan']);
  assert.deepEqual(await readdir(directory), ['plans.json']);
});

test('failed, malformed or oversized plan feeds retain the existing valid file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pmdb-plans-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'plans.json');
  const original = '["Retired plan"]\n';
  await writeFile(outputPath, original);
  const replies = [
    () => new Response('Unavailable', { status: 503 }),
    () => new Response('<html>Error</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{bad}', { headers: { 'Content-Type': 'application/json' } }),
    () => reply({ ...feed, products: [] }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const create of replies) {
    await assert.rejects(syncPlans({ outputPath, fetchImpl: async () => create() }));
    assert.equal(await readFile(outputPath, 'utf8'), original);
  }
  assert.deepEqual(await readdir(directory), ['plans.json']);
});
