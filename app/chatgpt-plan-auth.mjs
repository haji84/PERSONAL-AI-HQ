import {execFile} from 'node:child_process';
import {createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, realpath, rename, rmdir, stat, unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

export const PLAN_AUTH_CALLBACK_PATH = '/auth/callback';

const issuer = 'https://auth.openai.com';
const authorizeEndpoint = issuer + '/api/accounts/authorize';
const tokenEndpoint = issuer + '/api/accounts/oauth/token';
const jwksEndpoint = issuer + '/.well-known/jwks.json';
const resource = 'https://api.openai.com/v1';
const registrationClient = 'dynamic_agent_client';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const planScopes = ['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const attemptLifetime = 10 * 60_000;
const terminalRefreshErrors = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused'
]);
const renewLifetime = 30 * 24 * 60 * 60_000;
const refreshWindow = 30_000;
const credentialLimit = 128 * 1024;
const exec = promisify(execFile);
const systemCommand = {timeout: 3000, maxBuffer: 16_384, env: {LC_ALL: 'C'}};
const randomValue = () => randomBytes(32).toString('base64url');
const owner = info => info.uid === process.getuid();
const validString = (value, max = 32_768) => typeof value === 'string' && value.length > 0 && value.length <= max;
const validClient = client => typeof client === 'string' && /^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(client);
const validHost = id => typeof id === 'string' && /^urn:uuid:[0-9a-f-]{36}$/.test(id);
const sameSecret = (actual, expected) => validString(actual, 1024) &&
  Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
  timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

export class PlanAuthError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PlanAuthError';
    this.code = code;
  }
}

const failure = code => new PlanAuthError(code);

function loopbackCallback(origin) {
  if (typeof origin !== 'string' || !/^http:\/\/127\.0\.0\.1(?::[1-9][0-9]{0,4})?$/.test(origin)) {
    throw failure('INVALID_ORIGIN');
  }
  const url = URL.parse(origin);
  // Reject aliases and values URL would normalize, including a noncanonical port.
  if (origin !== url?.origin) throw failure('INVALID_ORIGIN');
  return origin + PLAN_AUTH_CALLBACK_PATH;
}

async function protectedVolume() {
  if (process.platform !== 'darwin' || !process.getuid || !constants.O_NOFOLLOW) {
    throw failure('STORAGE_UNAVAILABLE');
  }
  const [{stdout}, data] = await Promise.all([
    exec('/usr/bin/fdesetup', ['status'], systemCommand),
    stat('/System/Volumes/Data')
  ]);
  if (stdout.trim() !== 'FileVault is On.') throw failure('STORAGE_UNAVAILABLE');
  return data.dev;
}

async function assertNoACL(path) {
  const {stdout} = await exec('/bin/ls', ['-Plde', path], systemCommand);
  if (stdout.trimEnd().split('\n').length !== 1) throw failure('STORAGE_UNAVAILABLE');
}

function hasPlanScopes(granted) {
  return Array.isArray(granted) && planScopes.every(scope => granted.includes(scope));
}

function validStoredGrant(grant) {
  if (!(grant && validClient(grant.clientId) && validString(grant.subject))) return false;
  if (grant.reauthorizationRequired === true) {
    return !('idToken' in grant || 'accessToken' in grant || 'refreshToken' in grant);
  }
  return validString(grant.idToken) && validString(grant.accessToken) &&
    validString(grant.refreshToken) && Number.isSafeInteger(grant.expiresAt) &&
    Number.isSafeInteger(grant.renewUntil) && hasPlanScopes(grant.scopes);
}

function createCredentialStore(directory) {
  let volume;
  async function storagePath() {
    try {
      volume ??= protectedVolume();
      const [device, info] = await Promise.all([volume, lstat(directory)]);
      if (!info.isDirectory() || !owner(info) || (info.mode & 0o777) !== 0o700 ||
          info.dev !== device) throw failure('STORAGE_UNAVAILABLE');
      const path = await realpath(directory);
      await assertNoACL(path);
      return path;
    } catch {
      throw failure('STORAGE_UNAVAILABLE');
    }
  }

  async function read(path) {
    const file = join(path, 'chatgpt-plan-auth.json');
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw failure('STORAGE_UNAVAILABLE');
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || !owner(info) || (info.mode & 0o777) !== 0o600 ||
          info.nlink !== 1 || info.size > credentialLimit) throw failure('STORAGE_UNAVAILABLE');
      await assertNoACL(file);
      const record = JSON.parse(await handle.readFile('utf8'));
      if (record?.version !== 1 || !validHost(record.hostId) ||
          (record.grant !== null && !validStoredGrant(record.grant))) throw failure('STORAGE_UNAVAILABLE');
      return record;
    } catch {
      throw failure('STORAGE_UNAVAILABLE');
    } finally {
      await handle.close();
    }
  }

  async function write(path, record) {
    const tempfile = join(path, '.chatgpt-plan-auth-' + randomUUID() + '.tmp');
    try {
      const contents = JSON.stringify(record);
      if (Buffer.byteLength(contents) > credentialLimit) throw failure('STORAGE_UNAVAILABLE');
      const handle = await open(tempfile, 'wx', 0o600);
      try {
        await assertNoACL(tempfile);
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempfile, join(path, 'chatgpt-plan-auth.json'));
    } catch {
      throw failure('STORAGE_UNAVAILABLE');
    } finally {
      await unlink(tempfile).catch(() => {});
    }
  }

  // Cross-process exclusion prevents two app processes exchanging one rotating refresh token.
  // An orphan lock fails closed and requires review after an unclean process exit.
  async function exclusive(path, task) {
    const lock = join(path, '.chatgpt-plan-auth.lock');
    try {
      await mkdir(lock, {mode: 0o700});
    } catch (error) {
      throw failure(error.code === 'EEXIST' ? 'AUTH_BUSY' : 'STORAGE_UNAVAILABLE');
    }
    try {
      return await task();
    } finally {
      await rmdir(lock).catch(() => {});
    }
  }

  return {storagePath, read, write, exclusive};
}

function decodePart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw failure('INVALID_IDENTITY');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw failure('INVALID_IDENTITY');
  return bytes;
}

async function verifiedIdentity(fetchImpl, token, clientId, nonce) {
  try {
    if (!validString(token)) throw failure('INVALID_IDENTITY');
    const parts = token.split('.');
    if (parts.length !== 3) throw failure('INVALID_IDENTITY');
    const [header, payload, signature] = parts.map(decodePart);
    const {alg, kid, crit} = JSON.parse(header);
    if (alg !== 'RS256' || !validString(kid, 256) || crit !== undefined) throw failure('INVALID_IDENTITY');
    const response = await fetchImpl(jwksEndpoint, {redirect: 'error', signal: AbortSignal.timeout(10_000)});
    if (!response.ok) throw failure('INVALID_IDENTITY');
    const {keys} = await response.json();
    const matching = keys.filter(key => key.kid === kid);
    if (matching.length !== 1) throw failure('INVALID_IDENTITY');
    const jwk = matching[0];
    if (jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== alg) || (jwk.use && jwk.use !== 'sig') ||
        (jwk.key_ops && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify')))) {
      throw failure('INVALID_IDENTITY');
    }
    const key = createPublicKey({key: jwk, format: 'jwk'});
    if (key.asymmetricKeyDetails.modulusLength < 2048 ||
        !verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), key, signature)) {
      throw failure('INVALID_IDENTITY');
    }
    const claims = JSON.parse(payload);
    const now = Math.floor(Date.now() / 1000);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !audience.includes(clientId) ||
        (audience.length > 1 && claims.azp !== clientId) ||
        (claims.azp !== undefined && claims.azp !== clientId) ||
        !validString(claims.sub) || !Number.isSafeInteger(claims.exp) || claims.exp <= now ||
        (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now)) ||
        (nonce !== undefined && !sameSecret(claims.nonce, nonce))) throw failure('INVALID_IDENTITY');
    return claims.sub;
  } catch {
    throw failure('INVALID_IDENTITY');
  }
}

async function exchange(fetchImpl, fields) {
  try {
    const response = await fetchImpl(tokenEndpoint, {
      method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({...fields, resource}), redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    });
    if (response.status === 400 || response.status === 401) {
      const body = await response.json().catch(() => null);
      if (fields.grant_type === 'refresh_token' && terminalRefreshErrors.has(body?.error)) {
        throw failure('AUTHORIZATION_REQUIRED');
      }
      throw failure('GRANT_REJECTED');
    }
    if (response.status !== 200) throw failure('PROVIDER_UNAVAILABLE');
    return await response.json();
  } catch (error) {
    if (error instanceof PlanAuthError) throw error;
    throw failure('PROVIDER_UNAVAILABLE');
  }
}

async function validatedGrant(fetchImpl, response, clientId, {nonce, prior} = {}) {
  const granted = typeof response?.scope === 'string' ? response.scope.trim().split(/ +/) : [];
  if (!hasPlanScopes(granted)) throw failure('PLAN_SCOPE_REQUIRED');
  if (!validString(response.access_token) || !validString(response.refresh_token) ||
      typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer' ||
      !Number.isSafeInteger(response.expires_in) || response.expires_in <= 0 || response.expires_in > 3600) {
    throw failure('INVALID_GRANT');
  }
  const now = Date.now();
  const idToken = response.id_token === undefined && nonce === undefined ? prior?.idToken : response.id_token;
  const subject = response.id_token === undefined && nonce === undefined
    ? prior?.subject : await verifiedIdentity(fetchImpl, idToken, clientId, nonce);
  if (prior && prior.subject !== subject) throw failure('INVALID_IDENTITY');
  const expiresAt = now + response.expires_in * 1000;
  if (expiresAt <= Date.now()) throw failure('INVALID_GRANT');
  const {access_token: accessToken, refresh_token: refreshToken} = response;
  return {
    clientId, subject, idToken, accessToken, refreshToken,
    scopes: granted, expiresAt, renewUntil: now + renewLifetime
  };
}

function view(record) {
  const grant = record?.grant;
  if (!grant) return {configured: false, status: 'disconnected'};
  if (grant.reauthorizationRequired) return {configured: true, status: 'reauthorization_required'};
  return {
    configured: true,
    status: grant.expiresAt > Date.now() ? 'connected'
      : grant.renewUntil > Date.now() ? 'refresh_required' : 'reauthorization_required',
    expiresAt: new Date(grant.expiresAt).toISOString()
  };
}

export function createPlanAuth({directory, fetchImpl = globalThis.fetch}) {
  const store = createCredentialStore(resolve(directory));
  let pending;
  let refreshing;
  let completing = false;

  async function begin(origin, ownerSession) {
    const redirectUri = loopbackCallback(origin);
    if (!validString(ownerSession, 1024)) throw failure('OWNER_SESSION_REQUIRED');
    if (completing) throw failure('AUTH_BUSY');
    const path = await store.storagePath();
    const record = await store.exclusive(path, async () => {
      const previous = await store.read(path);
      if (previous) return previous;
      const initial = {version: 1, hostId: 'urn:uuid:' + randomUUID(), grant: null};
      await store.write(path, initial);
      return initial;
    });
    if (completing) throw failure('AUTH_BUSY');
    const {hostId, grant} = record;
    const state = randomValue();
    const nonce = randomValue();
    const codeVerifier = randomValue();
    const target = new URL(authorizeEndpoint);
    target.search = new URLSearchParams({
      client_id: grant?.clientId ?? registrationClient,
      ext_agent_host_id: hostId, redirect_uri: redirectUri, response_type: 'code',
      scope: scopes, resource, state, nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url')
    }).toString();
    if (!grant) target.searchParams.set('agent_name_hint', 'Personal AI HQ');
    pending = {state, nonce, codeVerifier, redirectUri, ownerSession, hostId,
      clientId: grant?.clientId, expiresAt: Date.now() + attemptLifetime};
    return target.href;
  }

  async function complete(origin, ownerSession, query) {
    const attempt = pending;
    if (!attempt || attempt.expiresAt <= Date.now() || !sameSecret(ownerSession, attempt.ownerSession) ||
        loopbackCallback(origin) !== attempt.redirectUri || !(query instanceof URLSearchParams) ||
        new Set(query.keys()).size !== query.size || !sameSecret(query.get('state'), attempt.state)) {
      throw failure('INVALID_CALLBACK');
    }
    pending = undefined;
    if (query.has('error')) throw failure('AUTHORIZATION_DENIED');
    const code = query.get('code');
    const clientId = query.has('client_id') ? query.get('client_id') : attempt.clientId;
    if (!validString(code, 8192) || !validClient(clientId) ||
        (attempt.clientId && clientId !== attempt.clientId) ||
        (query.has('iss') && query.get('iss') !== issuer) ||
        (query.has('redirect_uri') && query.get('redirect_uri') !== attempt.redirectUri)) {
      throw failure('INVALID_CALLBACK');
    }
    completing = true;
    try {
      const path = await store.storagePath();
      return await store.exclusive(path, async () => {
        const record = await store.read(path);
        if (record?.hostId !== attempt.hostId || record.grant?.clientId !== attempt.clientId) {
          throw failure('INVALID_CALLBACK');
        }
        const response = await exchange(fetchImpl, {
          grant_type: 'authorization_code', client_id: clientId, code,
          code_verifier: attempt.codeVerifier, redirect_uri: attempt.redirectUri
        });
        const grant = await validatedGrant(fetchImpl, response, clientId, {nonce: attempt.nonce, prior: record.grant});
        if (attempt.expiresAt <= Date.now()) throw failure('INVALID_CALLBACK');
        const next = {...record, grant};
        await store.write(path, next);
        return view(next);
      });
    } finally {
      completing = false;
    }
  }

  async function status() {
    try {
      return view(await store.read(await store.storagePath()));
    } catch {
      return {configured: false, status: 'storage_unavailable'};
    }
  }

  async function accessToken() {
    if (!refreshing) {
      refreshing = (async () => {
        const path = await store.storagePath();
        const record = await store.read(path);
        if (!record?.grant || record.grant.reauthorizationRequired) throw failure('AUTHORIZATION_REQUIRED');
        if (record.grant.expiresAt > Date.now() + refreshWindow) return record.grant.accessToken;
        return store.exclusive(path, async () => {
          const current = await store.read(path);
          const prior = current?.grant;
          if (!prior || prior.reauthorizationRequired) throw failure('AUTHORIZATION_REQUIRED');
          if (prior.expiresAt > Date.now() + refreshWindow) return prior.accessToken;
          const clearInvalidCredentials = () => store.write(path, {
            ...current,
            grant: {clientId: prior.clientId, subject: prior.subject, reauthorizationRequired: true}
          });
          let response;
          try {
            if (prior.renewUntil <= Date.now()) throw failure('AUTHORIZATION_REQUIRED');
            response = await exchange(fetchImpl, {
              grant_type: 'refresh_token', client_id: prior.clientId, refresh_token: prior.refreshToken
            });
            const grant = await validatedGrant(fetchImpl, response, prior.clientId, {prior});
            await store.write(path, {...current, grant});
            return grant.accessToken;
          } catch (error) {
            // A successful but unusable rotation may already have invalidated the old grant.
            if (response || error.code === 'AUTHORIZATION_REQUIRED') await clearInvalidCredentials();
            throw error;
          }
        });
      })().finally(() => { refreshing = undefined; });
    }
    return refreshing;
  }

  return {begin, complete, status, accessToken};
}
