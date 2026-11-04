import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PLAN_CATALOG_URL, normalizePlanNames, mergePlanNames, syncPlans, parsePlanSelection, promptForPlans } from '../scripts/sync-plans.mjs';

const feed = {
  schema_version: 1, generated_at: '2026-11-03T02:45:01+00:00', products: [
    { id: 1, type: 'hostingaccount', name: 'M10G S', available: true },
    { id: 2, type: 'hostingaccount', name: 'Sold-out node plan', available: false },
    { id: 3, type: 'server', name: 'Dedicated hardware', available: false },
    { id: 4, type: 'other', name: 'AI Credits', available: true },
    { id: 5, type: 'hostingaccount', name: 'M10G S', available: true },
    ...['ZEN MiniDedi', 'MD1: i5-7500t/16G/250GB NVMe', 'MD32: hardware', 'F19-MDS-12T', 'F22-MDS-ZEN-8TB', 'Dell C1100 10G Unmetered', 'QCS210 Storage 10G Unmetered', 'New Dedicated Server'].map((name, index) => ({ id: index + 10, type: 'hostingaccount', name })),
  ],
};
const reply = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const candidates = ['Plan A', 'Plan B', 'Plan C', 'Plan D'];

async function fileFixture(t, content = '["Retired plan"]\n') {
  const directory = await mkdtemp(join(tmpdir(), 'pmdb-plans-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'plans.json');
  await writeFile(outputPath, content);
  return { directory, outputPath, content };
}

test('catalog excludes dedicated plans even when misclassified as hostingaccount', () => {
  assert.deepEqual(normalizePlanNames(feed), ['M10G S', 'Sold-out node plan']);
  assert.deepEqual(normalizePlanNames({ ...feed, products: [{ id: 1, type: 'server', name: 'Dedicated' }] }), []);
  for (const invalid of [null, {}, { ...feed, schema_version: 2 }, { ...feed, products: [] }, { ...feed, products: [{ id: 1, type: 'hostingaccount', name: 'x'.repeat(101) }] }]) assert.throws(() => normalizePlanNames(invalid));
});

test('approved list retains existing order and retired/custom entries; only new selections append', () => {
  assert.deepEqual(mergePlanNames(['Retired plan', 'M10G S'], ['Sold-out node plan', 'M10G S']), ['Retired plan', 'M10G S', 'Sold-out node plan']);
  assert.deepEqual(mergePlanNames(['Plan 1', 'Custom plan'], ['M10G S']), ['Plan 1', 'Custom plan', 'M10G S']);
  assert.throws(() => mergePlanNames(['bad\nname'], ['M10G S']));
  assert.throws(() => mergePlanNames(['Duplicate', 'Duplicate'], ['M10G S']));
});

test('admin can select individual numbers, ranges, all or none', () => {
  assert.deepEqual(parsePlanSelection('1,3-4', candidates), ['Plan A', 'Plan C', 'Plan D']);
  assert.deepEqual(parsePlanSelection('1 1,2', candidates), ['Plan A', 'Plan B']);
  assert.deepEqual(parsePlanSelection('ALL', candidates), candidates);
  for (const answer of ['', 'none', 'n', 'no']) assert.deepEqual(parsePlanSelection(answer, candidates), []);
  for (const answer of ['0', '5', '2-1', '1-999999', '-1', '1.5', 'yes', '1;2']) assert.throws(() => parsePlanSelection(answer, candidates));
});

test('prompt displays candidates, reprompts invalid choices and requires a final yes', async () => {
  let output = '';
  const questions = [], answers = ['99', '1,3', 'yes'];
  const approved = await promptForPlans(candidates, { output: { write: text => { output += text; } }, ask: async question => { questions.push(question); return answers.shift(); } });
  assert.deepEqual(approved, ['Plan A', 'Plan C']);
  assert.match(output, /1\. Plan A/);
  assert.match(output, /4\. Plan D/);
  assert.match(output, /Choose numbers from 1 to 4/);
  assert.match(questions.at(-1), /\[y\/N\]/);
  assert.deepEqual(await promptForPlans(candidates, { output: { write() {} }, ask: async () => '' }), []);
  const declined = ['all', 'no'];
  assert.deepEqual(await promptForPlans(candidates, { output: { write() {} }, ask: async () => declined.shift() }), []);
});

test('noninteractive runs cannot automatically approve new plans', async t => {
  await assert.rejects(promptForPlans(candidates, { input: { isTTY: false }, output: { isTTY: false, write() {} } }), /interactive terminal/);
  const { outputPath, content } = await fileFixture(t);
  await assert.rejects(syncPlans({ outputPath, fetchImpl: async () => reply(feed), approveNewPlans: plans => promptForPlans(plans, { input: { isTTY: false }, output: { isTTY: false } }) }), /interactive terminal/);
  assert.equal(await readFile(outputPath, 'utf8'), content);
});

test('sync discovers eligible new plans and writes only the admin-approved subset', async t => {
  const { directory, outputPath } = await fileFixture(t);
  const result = await syncPlans({ outputPath, fetchImpl: async (url, options) => {
    assert.equal(url, PLAN_CATALOG_URL);
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(Object.keys(options.headers).length, 1);
    return reply(feed);
  }, approveNewPlans: async plans => {
    assert.deepEqual(plans, ['M10G S', 'Sold-out node plan']);
    return ['M10G S'];
  } });
  assert.equal(result.addedCount, 1);
  assert.equal(result.count, 2);
  assert.equal(result.newCount, 2);
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), ['Retired plan', 'M10G S']);
  assert.deepEqual(await readdir(directory), ['plans.json']);
});

test('declines, cancellation and no-new-plan runs leave the exact original file intact', async t => {
  const { directory, outputPath, content } = await fileFixture(t, '[\n  "Sold-out node plan",\n  "M10G S"\n]\n');
  const result = await syncPlans({ outputPath, fetchImpl: async () => reply(feed), approveNewPlans: async () => { throw new Error('Should not prompt'); } });
  assert.equal(result.changed, false);
  assert.equal(result.newCount, 0);
  assert.equal(await readFile(outputPath, 'utf8'), content);
  await writeFile(outputPath, '["M10G S"]\n');
  const declined = await syncPlans({ outputPath, fetchImpl: async () => reply(feed), approveNewPlans: async () => [] });
  assert.equal(declined.changed, false);
  assert.equal(await readFile(outputPath, 'utf8'), '["M10G S"]\n');
  await assert.rejects(syncPlans({ outputPath, fetchImpl: async () => reply(feed), approveNewPlans: async () => { throw new Error('Cancelled'); } }), /Cancelled/);
  assert.equal(await readFile(outputPath, 'utf8'), '["M10G S"]\n');
  assert.deepEqual(await readdir(directory), ['plans.json']);
});

test('sync refuses unlisted approvals and detects admin edits made during review', async t => {
  const { outputPath, content } = await fileFixture(t);
  await assert.rejects(syncPlans({ outputPath, fetchImpl: async () => reply(feed), approveNewPlans: async () => ['MiniDedi'] }), /Only listed/);
  assert.equal(await readFile(outputPath, 'utf8'), content);
  await assert.rejects(syncPlans({ outputPath, fetchImpl: async () => reply(feed), approveNewPlans: async () => {
    await writeFile(outputPath, '["Manual edit"]\n'); return ['M10G S'];
  } }), /changed during approval/);
  assert.equal(await readFile(outputPath, 'utf8'), '["Manual edit"]\n');
});

test('failed, malformed or oversized feeds retain the existing valid file', async t => {
  const { directory, outputPath, content } = await fileFixture(t);
  const replies = [
    () => new Response('Unavailable', { status: 503 }),
    () => new Response('<html>Error</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{bad}', { headers: { 'Content-Type': 'application/json' } }),
    () => reply({ ...feed, products: [] }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const create of replies) {
    await assert.rejects(syncPlans({ outputPath, fetchImpl: async () => create() }));
    assert.equal(await readFile(outputPath, 'utf8'), content);
  }
  assert.deepEqual(await readdir(directory), ['plans.json']);
});
