import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {chmod, mkdtemp, readdir, readFile, rename, rm, stat, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createPlanAuth, PLAN_AUTH_CALLBACK_PATH} from '../app/chatgpt-plan-auth.mjs';

const origin = 'http://127.0.0.1:4328';
const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const client = 'oaiapp_fixture';
const owner = 'synthetic-owner-session';
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'fixture-key', alg: 'RS256', use: 'sig'};
const mac = {skip: process.platform !== 'darwin' && 'The protected store requires macOS FileVault'};

function idToken(nonce, claims = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = {
    iss: issuer, aud: client, sub: 'fixture-user', exp: Math.floor(Date.now() / 1000) + 3600,
    nonce, ...claims
  };
  const input = encode({alg: 'RS256', kid: jwk.kid}) + '.' + encode(payload);
  return input + '.' + sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hq-auth-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const requests = [];
  let nextGrant;
  const fetchImpl = async (url, options) => {
    requests.push({url: String(url), ...options});
    assert.equal(options.redirect, 'error');
    if (String(url) === issuer + '/.well-known/jwks.json') return Response.json({keys: [jwk]});
    assert.equal(String(url), issuer + '/api/accounts/oauth/token');
    assert.equal(options.method, 'POST');
    const grant = typeof nextGrant === 'function' ? await nextGrant() : nextGrant;
    return grant instanceof Response ? grant : Response.json(grant);
  };
  const reopen = () => createPlanAuth({directory, fetchImpl});
  const auth = reopen();
  const validGrant = (nonce, overrides = {}, claims) => ({
    access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer',
    expires_in: 3600, scope, id_token: idToken(nonce, claims), ...overrides
  });
  async function begin(source = auth) {
    const authorize = new URL(await source.begin(origin, owner));
    const {searchParams: params} = authorize;
    const query = new URLSearchParams({state: params.get('state'), code: 'fixture-code', client_id: client});
    nextGrant = validGrant(params.get('nonce'));
    return {authorize, params, query};
  }
  const setGrant = value => { nextGrant = value; };
  return {auth, begin, reopen, directory, requests, setGrant, validGrant};
}

test('rejects callback tampering without contacting the provider', mac, async t => {
  const {auth, begin, requests} = await fixture(t);
  const {query} = await begin();
  await assert.rejects(auth.complete(origin, 'other-owner-session', query), {code: 'INVALID_CALLBACK'});
  await assert.rejects(auth.complete('http://127.0.0.1:4329', owner, query), {code: 'INVALID_CALLBACK'});
  const wrongState = new URLSearchParams(query);
  wrongState.set('state', 'mismatch');
  await assert.rejects(auth.complete(origin, owner, wrongState), {code: 'INVALID_CALLBACK'});
  for (const key of ['state', 'code', 'scope', 'client_id']) {
    const duplicate = new URLSearchParams(query);
    duplicate.append(key, 'one');
    duplicate.append(key, 'two');
    await assert.rejects(auth.complete(origin, owner, duplicate), {code: 'INVALID_CALLBACK'});
  }
  assert.equal(requests.length, 0);
  await assert.rejects(auth.begin('http://localhost:4328', owner), {code: 'INVALID_ORIGIN'});
  await assert.rejects(auth.begin(origin + '/wrong', owner), {code: 'INVALID_ORIGIN'});
  await assert.rejects(auth.begin('http://127.0.0.1:99999', owner), {code: 'INVALID_ORIGIN'});
});

test('uses the official loopback public client flow and keeps only safe status public', mac, async t => {
  const {auth, begin, reopen, requests, directory} = await fixture(t);
  assert.deepEqual(await auth.status(), {configured: false, status: 'disconnected'});
  const {authorize, params, query} = await begin();
  assert.equal(authorize.origin + authorize.pathname, issuer + '/api/accounts/authorize');
  assert.equal(params.get('client_id'), 'dynamic_agent_client');
  assert.equal(params.get('agent_name_hint'), 'Personal AI HQ');
  assert.match(params.get('ext_agent_host_id'), /^urn:uuid:/);
  assert.equal(params.get('redirect_uri'), origin + PLAN_AUTH_CALLBACK_PATH);
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('resource'), resource);
  assert.equal(params.get('scope'), scope);
  const result = await auth.complete(origin, owner, query);
  assert.equal(result.status, 'connected');
  assert.deepEqual(Object.keys(result).sort(), ['configured', 'expiresAt', 'status']);
  const fields = new URLSearchParams(requests[0].body);
  assert.equal(fields.get('client_id'), client);
  assert.equal(fields.get('redirect_uri'), params.get('redirect_uri'));
  assert.equal(fields.get('resource'), resource);
  assert.equal(createHash('sha256').update(fields.get('code_verifier')).digest('base64url'), params.get('code_challenge'));
  await assert.rejects(auth.complete(origin, owner, query), {code: 'INVALID_CALLBACK'});
  assert.equal(await reopen().accessToken(), 'fixture-access');
  const entries = await readdir(directory);
  const record = entries.find(file => file.endsWith('.json'));
  assert.ok(record);
  assert.equal((await stat(join(directory, record))).mode & 0o777, 0o600);
  const returning = await begin(reopen());
  assert.equal(returning.params.get('client_id'), client);
  assert.equal(returning.params.has('agent_name_hint'), false);
  assert.equal(returning.params.has('id_token_hint'), false);
  assert.equal(returning.params.get('ext_agent_host_id'), params.get('ext_agent_host_id'));
});

test('rejects missing permission and unverified identity without replacing an active authorization', mac, async t => {
  const {auth, begin, setGrant, validGrant} = await fixture(t);
  const first = await begin();
  await auth.complete(origin, owner, first.query);
  for (const [overrides, claims, code] of [
    [{scope: 'openid offline_access resource.invoke'}, {}, 'PLAN_SCOPE_REQUIRED'],
    [{expires_in: 0}, {}, 'INVALID_GRANT'],
    [{}, {nonce: 'wrong-nonce'}, 'INVALID_IDENTITY'],
    [{}, {sub: 'different-owner'}, 'INVALID_IDENTITY'],
    [{}, {aud: 'oaiapp_other'}, 'INVALID_IDENTITY'],
    [{}, {exp: 0}, 'INVALID_IDENTITY'],
    [{}, {iss: 'https://example.invalid'}, 'INVALID_IDENTITY'],
    [{id_token: 'not.a.signature'}, {}, 'INVALID_IDENTITY']
  ]) {
    const {params, query} = await begin();
    setGrant(validGrant(params.get('nonce'), overrides, claims));
    await assert.rejects(auth.complete(origin, owner, query), {code});
    assert.equal(await auth.accessToken(), 'fixture-access');
  }
});

test('serialized refresh rotates the entire record and survives reopening', mac, async t => {
  const {auth, begin, reopen, requests, setGrant, validGrant} = await fixture(t);
  const {query, params} = await begin();
  setGrant(validGrant(params.get('nonce'), {expires_in: 1}));
  await auth.complete(origin, owner, query);
  setGrant({access_token: 'fixture-rotated', refresh_token: 'fixture-new-refresh', token_type: 'Bearer', expires_in: 3600, scope});
  const resumed = reopen();
  assert.deepEqual(await Promise.all([resumed.accessToken(), resumed.accessToken()]), ['fixture-rotated', 'fixture-rotated']);
  const refreshes = requests.map(request => new URLSearchParams(request.body)).filter(fields => fields.get('grant_type') === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].get('client_id'), client);
  assert.equal(refreshes[0].get('refresh_token'), 'fixture-refresh');
  assert.equal(refreshes[0].get('resource'), resource);
  assert.equal(refreshes[0].has('scope'), false);
  assert.equal(await reopen().accessToken(), 'fixture-rotated');
});

test('refuses unsafe credential directories without changing their permissions', mac, async t => {
  const {auth, directory, requests} = await fixture(t);
  await chmod(directory, 0o755);
  assert.deepEqual(await auth.status(), {configured: false, status: 'storage_unavailable'});
  await assert.rejects(auth.begin(origin, owner), {code: 'STORAGE_UNAVAILABLE'});
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
  assert.equal(requests.length, 0);
});

test('refuses a credential symlink and preserves its target', mac, async t => {
  const {auth, begin, directory} = await fixture(t);
  const {query} = await begin();
  await auth.complete(origin, owner, query);
  const entries = await readdir(directory);
  const file = join(directory, entries.find(entry => entry.endsWith('.json')));
  const before = await readFile(file);
  const target = join(directory, 'target');
  await rename(file, target);
  await symlink(target, file);
  await assert.rejects(auth.accessToken(), {code: 'STORAGE_UNAVAILABLE'});
  assert.deepEqual(await readFile(target), before);
});

test('refuses persistent credentials on unverified platforms', {skip: process.platform === 'darwin'}, async t => {
  const {auth, directory, requests} = await fixture(t);
  assert.deepEqual(await auth.status(), {configured: false, status: 'storage_unavailable'});
  await assert.rejects(auth.begin(origin, owner), {code: 'STORAGE_UNAVAILABLE'});
  assert.deepEqual(await readdir(directory), []);
  assert.equal(requests.length, 0);
});

test('authorization denial consumes the attempt and never exchanges the code', mac, async t => {
  const {auth, begin, requests} = await fixture(t);
  const {query} = await begin();
  const denied = new URLSearchParams({state: query.get('state'), error: 'access_denied'});
  await assert.rejects(auth.complete(origin, owner, denied), {code: 'AUTHORIZATION_DENIED'});
  await assert.rejects(auth.complete(origin, owner, query), {code: 'INVALID_CALLBACK'});
  assert.equal(requests.length, 0);
});

test('returning registration rejects a changed client ID and accepts omission', mac, async t => {
  const {auth, begin, requests} = await fixture(t);
  const first = await begin();
  await auth.complete(origin, owner, first.query);
  const changed = await begin();
  changed.query.set('client_id', 'oaiapp_other');
  const before = requests.length;
  await assert.rejects(auth.complete(origin, owner, changed.query), {code: 'INVALID_CALLBACK'});
  assert.equal(requests.length, before);
  const omitted = await begin();
  omitted.query.delete('client_id');
  assert.equal((await auth.complete(origin, owner, omitted.query)).status, 'connected');
});

test('terminal refresh rejection clears credentials but retains the account registration', mac, async t => {
  const {auth, begin, directory, reopen, requests, setGrant, validGrant} = await fixture(t);
  const {query, params} = await begin();
  setGrant(validGrant(params.get('nonce'), {expires_in: 1}));
  await auth.complete(origin, owner, query);
  setGrant(Response.json({error: 'invalid_grant', error_description: 'synthetic private detail'}, {status: 400}));
  await assert.rejects(auth.accessToken(), {code: 'AUTHORIZATION_REQUIRED'});
  const before = requests.length;
  const resumed = reopen();
  await assert.rejects(resumed.accessToken(), {code: 'AUTHORIZATION_REQUIRED'});
  assert.equal((await resumed.status()).status, 'reauthorization_required');
  assert.equal(requests.length, before);
  const record = await readFile(join(directory, 'chatgpt-plan-auth.json'), 'utf8');
  assert.equal(record.includes('fixture-refresh'), false);
  assert.equal(record.includes('fixture-access'), false);
  assert.equal(JSON.parse(record).grant.clientId, client);
  assert.equal((await begin(resumed)).params.get('client_id'), client);
});

test('rejects canonical JWT encoding with an invalid cryptographic signature', mac, async t => {
  const {auth, begin, setGrant, validGrant} = await fixture(t);
  const {query, params} = await begin();
  const grant = validGrant(params.get('nonce'));
  const [header, payload, signature] = grant.id_token.split('.');
  const altered = Buffer.from(signature, 'base64url');
  altered[0] ^= 1;
  setGrant({...grant, id_token: [header, payload, altered.toString('base64url')].join('.')});
  await assert.rejects(auth.complete(origin, owner, query), {code: 'INVALID_IDENTITY'});
  assert.equal((await auth.status()).status, 'disconnected');
});

test('separate auth instances cannot race a rotating refresh grant', mac, async t => {
  const {auth, begin, reopen, requests, setGrant, validGrant} = await fixture(t);
  const {query, params} = await begin();
  setGrant(validGrant(params.get('nonce'), {expires_in: 1}));
  await auth.complete(origin, owner, query);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  setGrant(async () => {
    entered.resolve();
    await finish.promise;
    return {access_token: 'EXAMPLE_replacement', refresh_token: 'fixture-new-refresh', token_type: 'Bearer', expires_in: 3600, scope};
  });
  const first = auth.accessToken();
  try {
    await entered.promise;
    await assert.rejects(reopen().accessToken(), {code: 'AUTH_BUSY'});
  } finally {
    finish.resolve();
  }
  assert.equal(await first, 'EXAMPLE_replacement');
  assert.equal(await reopen().accessToken(), 'EXAMPLE_replacement');
  assert.equal(requests.filter(request => request.body?.get('grant_type') === 'refresh_token').length, 1);
});

test('temporary refresh failure never releases a near-expiry token or erases the grant', mac, async t => {
  const {auth, begin, directory, setGrant, validGrant} = await fixture(t);
  const {query, params} = await begin();
  setGrant(validGrant(params.get('nonce'), {expires_in: 1}));
  await auth.complete(origin, owner, query);
  const file = join(directory, 'chatgpt-plan-auth.json');
  const before = await readFile(file);
  setGrant(Response.json({error: 'service_unavailable'}, {status: 503}));
  await assert.rejects(auth.accessToken(), {code: 'PROVIDER_UNAVAILABLE'});
  assert.deepEqual(await readFile(file), before);
});
