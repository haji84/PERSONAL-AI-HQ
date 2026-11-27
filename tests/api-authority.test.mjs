import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apiAuthorityFile, readApiAuthority} from '../app/api-authority.mjs';

const now = Date.parse('2026-11-27T08:10:00Z');
const example = {
  version: 1, organization: 'org-fixture', providerProject: 'proj_fixture', defaultModel: 'fixture-model-2026-11-27',
  reservationAuthorityId: 'personal-ai-hq-local', ledgerBinding: 'a'.repeat(64),
  credit: {organization: 'org-fixture', observedAt: '2026-11-27T08:09:30Z', safeUntil: '2026-12-19T00:00:00Z',
    availableCreditUsd: 15, checkoutConfirmed: true, purchasedCreditUsd: 0, paidBillingEnabled: false, autoRechargeEnabled: false},
  models: [{id: 'fixture-model-2026-11-27', contextTokens: 16000, outputTokens: 2000,
    inputUsdPerMillion: 2, outputUsdPerMillion: 8, reasoningEfforts: ['low']}],
  projects: {'fixture-project': {files: [{path: 'src/demo.mjs', writable: true}], testPaths: ['test/demo.test.mjs']}},
};

test('authority accepts only a fresh same-organization credit-only observation', {skip: process.platform === 'win32'}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hq-api-authority-'));
  const file = join(directory, apiAuthorityFile);
  t.after(async () => rm(directory, {recursive: true, force: true}));
  assert.throws(() => readApiAuthority(directory, now), {code: 'API_AUTHORITY_MISSING'});
  await writeFile(file, JSON.stringify(example), {mode: 0o600});
  assert.deepEqual(readApiAuthority(directory, now), example);
  assert.throws(() => readApiAuthority(directory, now + 360000), {code: 'API_CREDIT_UNVERIFIED'});
  assert.deepEqual(readApiAuthority(directory, now + 360000, {forDispatch: false}), example);
  for (const fields of [{organization: 'org-other'}, {purchasedCreditUsd: 0.01}, {paidBillingEnabled: true},
    {autoRechargeEnabled: true}, {checkoutConfirmed: 'true'}]) {
    await writeFile(file, JSON.stringify({...example, credit: {...example.credit, ...fields}}));
    assert.throws(() => readApiAuthority(directory, now), {code: 'API_CREDIT_UNVERIFIED'});
  }
});

test('owner-only mode does not hide a macOS access control list', {skip: process.platform !== 'darwin'}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hq-api-acl-'));
  t.after(async () => rm(directory, {recursive: true, force: true}));
  const file = join(directory, apiAuthorityFile);
  await writeFile(file, JSON.stringify(example), {mode: 0o600});
  execFileSync('/bin/chmod', ['+a', 'everyone deny write', file]);
  assert.throws(() => readApiAuthority(directory, now), {code: 'API_AUTHORITY_UNSAFE'});
  execFileSync('/bin/chmod', ['-N', file]);
  execFileSync('/bin/chmod', ['+a', 'everyone deny write', directory]);
  assert.throws(() => readApiAuthority(directory, now), {code: 'API_AUTHORITY_UNSAFE'});
  execFileSync('/bin/chmod', ['-N', directory]);
});

test('symlinks and files readable by another local account cannot enable the API', {skip: process.platform === 'win32'}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hq-api-private-'));
  t.after(async () => rm(directory, {recursive: true, force: true}));
  const file = join(directory, apiAuthorityFile);
  await writeFile(file, JSON.stringify(example), {mode: 0o644});
  assert.throws(() => readApiAuthority(directory, now), {code: 'API_AUTHORITY_UNSAFE'});
  await rm(file);
  const other = join(directory, 'other.json');
  await writeFile(other, JSON.stringify(example), {mode: 0o600});
  await symlink(other, file);
  assert.throws(() => readApiAuthority(directory, now), {code: 'API_AUTHORITY_UNSAFE'});
});
