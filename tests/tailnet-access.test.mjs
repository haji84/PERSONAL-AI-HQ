import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ensurePrivateDirectory} from '../app/private-directory.mjs';
import {startOwnerApp} from '../app/server.mjs';

const origin = 'https://workstation.example.ts.net';
const hostname = new URL(origin).host;
const login = 'owner@example.invalid';
const codePattern = /^[a-f0-9]{32}$/u;
const approvedProxy = {
  Host: hostname, 'X-Forwarded-Host': hostname, 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': login,
};

function call(target, path, {method = 'GET', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(target + path, {method, headers, agent: false}, async response => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({status: response.statusCode, headers: response.headers, text});
      } catch (error) { reject(error); }
    });
    outgoing.setTimeout(4000, () => outgoing.destroy(new Error('Local fixture response timed out')));
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

async function fixture(t, options = {}, {includeCodexScope = false} = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'hq-tailnet-test-'));
  const directory = join(root, 'runtime');
  const expectedOrigin = options.tailnet?.origin ?? origin;
  const expectedHost = new URL(expectedOrigin).host;
  let app;
  t.after(async () => {
    await app?.close();
    await rm(root, {recursive: true, force: true});
  });
  await ensurePrivateDirectory(directory);
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify({
    projects: [{id: 'sample', name: 'Tailnet fixture', state: 'ready', ...(includeCodexScope ? {cwd: directory} : {})}],
  }), {mode: 0o600});
  app = await startOwnerApp({directory, port: 0, codex: {}, ...options});
  const signIn = await readFile(app.signInFile, 'utf8');
  const key = /name="key" value="([a-f0-9]{64})"/u.exec(signIn)?.[1];
  assert.ok(key);
  const response = await call(app.url, '/api/session', {method: 'POST',
    headers: {Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({key}).toString()});
  assert.equal(response.status, 303);
  const localCookie = response.headers['set-cookie'][0].split(';')[0];
  return {
    app, localCookie,
    local(path, options) { return call(app.url, path, options); },
    remote(path, {headers, ...options} = {}) {
      assert.equal(app.tailnetUrl, expectedOrigin);
      assert.match(app.tailnetTarget, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u);
      assert.notEqual(app.tailnetTarget, app.url);
      const identity = {...approvedProxy, Host: expectedHost, 'X-Forwarded-Host': expectedHost};
      return call(app.tailnetTarget, path, {headers: Array.isArray(headers) ? headers : {...identity, ...headers}, ...options});
    },
  };
}

const tailnet = {origin, login, port: 0};
const json = result => JSON.parse(result.text);
const post = (headers = {}, payload) => ({
  method: 'POST', headers: {...headers, ...(payload === undefined ? {} : {'Content-Type': 'application/json'})},
  ...(payload === undefined ? {} : {body: JSON.stringify(payload)}),
});

async function pair(env) {
  const response = await env.local('/api/access/pair', post({Origin: env.app.url, Cookie: env.localCookie}));
  assert.equal(response.status, 200);
  const issued = json(response);
  assert.equal(issued.url, origin);
  assert.match(issued.code, codePattern);
  assert.ok(Date.parse(issued.expiresAt) > Date.now());
  assert.ok(Date.parse(issued.expiresAt) <= Date.now() + 5 * 60_000);
  return issued.code;
}

async function redeem(env, code) {
  const response = await env.remote('/api/access/redeem', post({Origin: origin}, {code}));
  assert.equal(response.status, 200);
  const header = response.headers['set-cookie'][0];
  assert.match(header, /^__Host-personal_hq=/u);
  for (const attribute of [/;\s*Secure(?:;|$)/iu, /;\s*HttpOnly(?:;|$)/iu, /;\s*SameSite=Strict(?:;|$)/iu, /;\s*Path=\/(?:;|$)/iu]) {
    assert.match(header, attribute);
  }
  assert.doesNotMatch(header, /;\s*Domain=/iu);
  return header.split(';')[0];
}

test('tailnet access is off by default and ordinary local sign-in still works', async t => {
  const env = await fixture(t);
  assert.equal(env.app.tailnetUrl, undefined);
  assert.equal(env.app.tailnetTarget, undefined);
  const result = await env.local('/api/session', {headers: {Cookie: env.localCookie}});
  assert.equal(result.status, 200);
  assert.equal(json(result).authenticated, true);
  assert.equal(Boolean(json(result).capabilities.tailnetPairing), false);
  assert.equal(Boolean(json(result).capabilities.tailnetSignIn), false);
  const portfolio = await env.local('/api/portfolio', {headers: {Cookie: env.localCookie}});
  assert.equal(json(portfolio).projects[0].name, 'Tailnet fixture');
  const forwarded = {'X-Forwarded-Host': new URL(env.app.url).host, 'X-Forwarded-Proto': 'https'};
  assert.equal((await env.local('/api/portfolio', {headers: {...forwarded, Cookie: env.localCookie}})).status, 403);
});

test('malformed tailnet config fails before creating a runtime or a listener', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'hq-tailnet-config-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const directory = join(root, 'runtime');
  for (const options of [
    {...tailnet, origin: 'https://workstation.example.invalid'},
    {...tailnet, origin: 'https://example.ts.net'},
    {...tailnet, origin: origin + '/path'},
    {...tailnet, origin: 'http://workstation.example.ts.net'},
    {...tailnet, login: undefined},
    {...tailnet, port: -1},
    {...tailnet, port: 65536},
  ]) {
    await assert.rejects(async () => {
      const unexpected = await startOwnerApp({directory, port: 0, codex: {}, tailnet: options});
      await unexpected.close();
    }, {name: 'TypeError'});
    assert.deepEqual(await readdir(root), []);
  }
});

test('tailnet matches the full external host when Serve uses a nondefault HTTPS port', async t => {
  const alternateOrigin = origin + ':8443';
  const env = await fixture(t, {tailnet: {...tailnet, origin: alternateOrigin}});
  assert.equal((await env.remote('/api/session')).status, 200);
  for (const header of ['Host', 'X-Forwarded-Host']) {
    assert.equal((await env.remote('/api/session', {headers: {[header]: hostname}})).status, 403);
  }
  const issued = await env.local('/api/access/pair', post({Origin: env.app.url, Cookie: env.localCookie}));
  assert.equal(issued.status, 200);
  const {code, url} = json(issued);
  assert.equal(url, alternateOrigin);
  assert.equal((await env.remote('/api/access/redeem', post({Origin: origin}, {code}))).status, 403);
  assert.equal((await env.remote('/api/access/redeem', post({Origin: alternateOrigin}, {code}))).status, 200);
});

test('tailnet backend requires exact approved proxy headers and rejects Funnel', async t => {
  const env = await fixture(t, {tailnet});
  const landing = await env.remote('/api/session');
  assert.equal(landing.status, 200);
  assert.equal(json(landing).authenticated, false);
  assert.equal(json(landing).capabilities.tailnetSignIn, true);
  assert.equal(Boolean(json(landing).capabilities.tailnetPairing), false);
  const approved = Object.entries(approvedProxy).flat();
  for (const [name, value] of Object.entries(approvedProxy)) {
    const missing = Object.entries(approvedProxy).filter(([header]) => header !== name).flat();
    // A raw header array avoids the HTTP client's duplicate-header normalization.
    assert.equal((await env.remote('/api/session', {headers: missing})).status, name === 'Host' ? 400 : 403, 'missing ' + name);
    assert.equal((await env.remote('/api/session', {headers: {...approvedProxy, [name]: 'wrong.invalid'}})).status, 403, 'wrong ' + name);
    assert.equal((await env.remote('/api/session', {headers: [...approved, name, value]})).status, 403, 'duplicate ' + name);
    assert.equal((await env.remote('/api/session', {headers: {...approvedProxy, [name]: value + ', ' + value}})).status, 403, 'list ' + name);
  }
  assert.equal((await env.remote('/api/session', {headers: {'Tailscale-Funnel-Request': '?1'}})).status, 403);
  assert.equal((await env.remote('/api/session', {headers: {'Tailscale-Funnel-Request': ''}})).status, 403);
});

test('owner pairing is single-use, replaceable, and cannot move cookies between listeners', async t => {
  const env = await fixture(t, {tailnet});
  const localAuth = {Origin: env.app.url, Cookie: env.localCookie};
  const localState = await env.local('/api/session', {headers: {Cookie: env.localCookie}});
  assert.equal(json(localState).capabilities.tailnetPairing, true);
  assert.equal(Boolean(json(localState).capabilities.tailnetSignIn), false);
  const localAnonymous = await env.local('/api/session');
  assert.equal(Boolean(json(localAnonymous).capabilities.tailnetPairing), false);
  assert.equal((await env.local('/api/access/pair', post({Origin: env.app.url}))).status, 401);
  assert.equal((await env.local('/api/access/pair', post({...localAuth, Origin: origin}))).status, 403);
  assert.equal((await env.remote('/api/portfolio')).status, 401);
  assert.equal((await env.remote('/api/portfolio', {headers: {Cookie: env.localCookie}})).status, 401);
  const replaced = await pair(env);
  const pending = await pair(env);
  assert.notEqual(replaced, pending);
  assert.equal((await env.remote('/api/access/redeem', post({Origin: origin}, {code: replaced}))).status, 403);
  assert.equal((await env.remote('/api/access/redeem', post({}, {code: pending}))).status, 403);
  assert.equal((await env.remote('/api/access/redeem', post({Origin: env.app.url}, {code: pending}))).status, 403);
  assert.equal((await env.local('/api/access/redeem', post(localAuth, {code: pending}))).status, 403);
  assert.equal((await env.remote('/api/access/redeem', post({Origin: origin}, {code: pending + '\n'}))).status, 403);
  const remoteCookie = await redeem(env, pending);
  assert.equal((await env.remote('/api/access/redeem', post({Origin: origin}, {code: pending}))).status, 403);
  assert.equal((await env.local('/api/portfolio', {headers: {Cookie: remoteCookie}})).status, 401);
  assert.equal((await env.remote('/api/portfolio', {headers: {Cookie: remoteCookie}})).status, 200);
  const remoteState = await env.remote('/api/session', {headers: {Cookie: remoteCookie}});
  assert.equal(json(remoteState).authenticated, true);
  assert.equal(Boolean(json(remoteState).capabilities.tailnetPairing), false);
  assert.equal((await env.remote('/api/access/revoke', post({Origin: origin, Cookie: remoteCookie}))).status, 403);
  assert.equal((await env.remote('/api/access/pair', post({Origin: origin, Cookie: remoteCookie}))).status, 403);
});

test('pairing expires, remote sign-out ends one session, and local revoke clears every remote session', async t => {
  t.mock.timers.enable({apis: ['Date']});
  const env = await fixture(t, {tailnet});
  const localAuth = {Origin: env.app.url, Cookie: env.localCookie};
  const aged = await pair(env);
  t.mock.timers.tick(5 * 60_000 + 1);
  assert.equal((await env.remote('/api/access/redeem', post({Origin: origin}, {code: aged}))).status, 403);
  const first = await redeem(env, await pair(env));
  const second = await redeem(env, await pair(env));
  assert.notEqual(first, second);
  const portfolio = cookie => env.remote('/api/portfolio', {headers: {Cookie: cookie}});
  assert.equal((await portfolio(first)).status, 200);
  assert.equal((await portfolio(second)).status, 200);
  assert.equal((await env.remote('/api/access/end', post({Origin: env.app.url, Cookie: first}))).status, 403);
  assert.equal((await env.remote('/api/access/end', post({Origin: origin}))).status, 401);
  assert.equal((await env.remote('/api/access/end', post({Origin: origin, Cookie: first}))).status, 200);
  assert.equal((await portfolio(first)).status, 401);
  assert.equal((await portfolio(second)).status, 200);
  const outstanding = await pair(env);
  assert.equal((await env.local('/api/access/revoke', post({Origin: env.app.url}))).status, 401);
  assert.equal((await env.local('/api/access/revoke', post({...localAuth, Origin: origin}))).status, 403);
  assert.equal((await env.local('/api/access/revoke', post(localAuth))).status, 200);
  assert.equal((await portfolio(second)).status, 401);
  assert.equal((await env.remote('/api/access/redeem', post({Origin: origin}, {code: outstanding}))).status, 403);
  assert.equal((await env.local('/api/portfolio', {headers: {Cookie: env.localCookie}})).status, 200);
});

test('remote owner access cannot invoke the local-only ChatGPT Plan flow', async t => {
  const invocations = [];
  const observe = (name, result) => async () => { invocations.push(name); return result; };
  const env = await fixture(t, {tailnet, plan: {
    auth: {status: observe('status', {authorized: true}), begin: observe('begin'), complete: observe('complete')},
    responses: {models: observe('models', [{slug: 'fixture-model'}]), async *stream() { invocations.push('stream'); }},
  }});
  assert.equal((await env.local('/api/chat/plan', {headers: {Cookie: env.localCookie}})).status, 200);
  assert.deepEqual(invocations.splice(0), ['status']);
  const remoteCookie = await redeem(env, await pair(env));
  const access = {Origin: origin, Cookie: remoteCookie};
  for (const [path, options] of [
    ['/api/chat/plan', {headers: access}],
    ['/api/chat/plan/models', {headers: access}],
    ['/api/chat/plan/authorize', post(access)],
    ['/auth/callback?state=fixture&code=fixture', {headers: access}],
    ['/api/chat/live?project=sample', post(access, {id: 'live-fixture-test', model: 'fixture-model', prompt: 'Synthetic prompt'})],
  ]) {
    assert.ok([403, 404].includes((await env.remote(path, options)).status), path);
  }
  assert.deepEqual(invocations, []);
});

test('a revoked remote session receives no in-flight Codex evidence', async t => {
  const nativeStarted = Promise.withResolvers();
  const releaseNative = Promise.withResolvers();
  const marker = 'private fixture evidence';
  const env = await fixture(t, {tailnet, codex: {
    async readTurnEvidence(scope, id, turn) {
      assert.equal(scope.length, 1);
      nativeStarted.resolve();
      await releaseNative.promise;
      return {threadId: id, turnId: turn, entries: [{type: 'command', output: marker}], nextCursor: null};
    },
  }}, {includeCodexScope: true});
  const remoteCookie = await redeem(env, await pair(env));
  const read = env.remote('/api/codex/evidence?project=sample&id=thread&turn=turn', {headers: {Cookie: remoteCookie}});
  try {
    await nativeStarted.promise;
    const revoked = await env.local('/api/access/revoke', post({Origin: env.app.url, Cookie: env.localCookie}));
    assert.equal(revoked.status, 200);
  } finally { releaseNative.resolve(); }
  const result = await read;
  assert.equal(result.status, 401);
  assert.ok(!result.text.includes(marker));
});
