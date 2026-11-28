import assert from 'node:assert/strict';
import {link, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import * as deliveryRecords from '../app/delivery-records.mjs';

const record = (status, extra = {}) => ({version: 1, status,
  goal: {id: 'owned-goal', title: 'Inspect the saved artifact'},
  tasks: [{id: 'verify', status: 'pending', actionable: true, depends_on: []}], ...extra});
const name = 'autonomy-state.json';

async function fixture(t) {
  const checkout = await mkdtemp(join(await realpath(tmpdir()), 'hq-lifecycle-hold-'));
  t.after(() => rm(checkout, {recursive: true, force: true}));
  return {checkout, folder: join(checkout, '.codex'), file: join(checkout, '.codex', name)};
}

test('recorded lifecycle holds take effect from saved workspace state without a Git commit', async t => {
  const {readProjectLifecycleHold: hold} = deliveryRecords;
  const {checkout, folder, file} = await fixture(t);
  assert.equal(hold(checkout), null);
  assert.equal(hold(join(checkout,'missing-checkout')), 'unverified');
  await mkdir(folder);
  const statuses = {active: null, paused: 'paused', cancelled: 'blocked', awaiting_approval: 'approval',
    resource_limited: 'limit', blocked: 'blocked', complete: 'complete', unknown: 'unverified'};
  for (const [status, expected] of Object.entries(statuses)) {
    await writeFile(file, JSON.stringify(record(status)));
    assert.equal(hold(checkout), expected, status);
  }
  await writeFile(join(checkout, 'PLAN.md'), 'Updated planning record');
  await writeFile(file, JSON.stringify(record('paused', {source: {path: 'PLAN.md', sha256: '0'.repeat(64)}})));
  assert.equal(hold(checkout), 'paused');
  assert.equal(await deliveryRecords.readProjectForecastState(checkout), null);
  await writeFile(file, JSON.stringify(record('paused', {tasks: [{id: 'incomplete-metadata'}]})));
  assert.equal(hold(checkout), 'unverified');
  await writeFile(file, JSON.stringify(record('paused', {goal: {title: 'Missing project goal ID'}})));
  assert.equal(hold(checkout), 'unverified');
  await writeFile(file, JSON.stringify(record('paused', {extra: 'a'.repeat(128 * 1024)})));
  assert.equal(hold(checkout), 'unverified');
});

test('lifecycle hold reader rejects linked files and aliased workspace paths', async t => {
  const {readProjectLifecycleHold: hold} = deliveryRecords;
  const {checkout, folder, file} = await fixture(t);
  const outside = join(checkout, 'other-scope');
  const source = join(outside, name);
  await mkdir(outside);
  await writeFile(source, JSON.stringify(record('paused')));
  await symlink(outside, folder, 'junction');
  assert.equal(hold(checkout), 'unverified');
  await unlink(folder);
  await mkdir(folder);
  await link(source, file);
  assert.equal(hold(checkout), 'unverified');
  await unlink(file);
  if (process.platform !== 'win32') {
    await symlink(source, file);
    assert.equal(hold(checkout), 'unverified');
    await unlink(file);
  }
  await writeFile(file, JSON.stringify(record('paused')));
  const alias = join(outside, 'linked-checkout');
  await symlink(checkout, alias, 'junction');
  assert.equal(hold(alias), 'unverified');
  await unlink(alias);
  assert.equal(hold(checkout), 'paused');
});
