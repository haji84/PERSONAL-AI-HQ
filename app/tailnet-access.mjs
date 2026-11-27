import {randomBytes, timingSafeEqual} from 'node:crypto';

const codeAgeMs = 5 * 60 * 1000;
const maxRemoteSessions = 4;
export const tailnetCookieName = '__Host-personal_hq';

export function createTailnetAccess(config, sessionAge) {
  if (config === undefined) return undefined;
  const {origin, login, port} = config ?? {};
  const address = typeof origin === 'string' ? URL.parse(origin) : null;
  const labels = address?.hostname.split('.') ?? [];
  const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (address?.protocol !== 'https:' || address.origin !== origin || labels.length !== 4 ||
      labels[2] !== 'ts' || labels[3] !== 'net' || !labels.slice(0, 2).every(label => dnsLabel.test(label)) ||
      typeof login !== 'string' || !/^[!-~]{1,254}$/.test(login) || login.includes(',') ||
      !Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('Tailscale ServeのHTTPS URL、本人ログインと専用ポートを確認してください。');
  }

  let pending;
  const sessions = new Map();

  function accepts(request) {
    const headers = request.headersDistinct;
    const exact = (name, value) => headers[name]?.length === 1 && headers[name][0] === value;
    return request.socket.remoteAddress === '127.0.0.1' && exact('host', address.host) &&
      exact('x-forwarded-host', address.host) && exact('x-forwarded-proto', 'https') &&
      exact('tailscale-user-login', login) && !headers['tailscale-funnel-request'];
  }

  function pair() {
    const code = randomBytes(16).toString('hex');
    const expires = Date.now() + codeAgeMs;
    pending = {code, expires};
    return {url: origin, code, expiresAt: new Date(expires).toISOString()};
  }

  function redeem(code) {
    const now = Date.now();
    if (!pending || pending.expires <= now || typeof code !== 'string' || !/^[a-f0-9]{32}$/.test(code) ||
        !timingSafeEqual(Buffer.from(pending.code, 'hex'), Buffer.from(code, 'hex'))) return null;
    pending = undefined;
    for (const [token, expiry] of sessions) {
      if (expiry <= now) sessions.delete(token);
    }
    if (sessions.size >= maxRemoteSessions) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, now + sessionAge * 1000);
    return token;
  }

  return {
    origin, port, accepts, pair, redeem,
    authenticated: token => (sessions.get(token) ?? 0) > Date.now(),
    end: token => sessions.delete(token),
    revoke() { pending = undefined; sessions.clear(); },
  };
}
