import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, readFile, realpath, unlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {readPortfolio} from './portfolio.mjs';
import {createChatStore} from './chat-store.mjs';
import {createCodexClient} from './codex.mjs';
import {createOperations} from './operations.mjs';
import {ensurePrivateDirectory} from './private-directory.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/app.css', ['app.css', 'text/css']]]);
const defaultRuntime = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'PersonalAIHQ', 'integration')
  : join(homedir(), 'Library', 'Application Support', 'Personal AI HQ', 'integration');
const browserPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const sessionAge = 8 * 60 * 60;
const error = (status, message) => Object.assign(new Error(message), {status});

function send(response, status, payload, extra = {}) {
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', ...extra});
  response.end(JSON.stringify(payload));
}

async function body(request, limit) {
  const declared = Number(request.headers['content-length']);
  if (declared > limit) throw error(413, 'ファイルが大きすぎます。');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw error(413, 'ファイルが大きすぎます。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function jsonBody(request, limit) {
  if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') throw error(415, 'JSONを選んでください。');
  const raw = await body(request, limit);
  try { return JSON.parse(raw); }
  catch { throw error(400, 'JSONを読み込めませんでした。'); }
}

function sameKey(expected, actual) {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function cookieKey(header) {
  const matches = (header ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith('personal_hq='));
  return matches.length === 1 ? matches[0].slice('personal_hq='.length) : null;
}

async function writeSignIn(directory, url, key) {
  const file = join(directory, `sign-in-${randomBytes(6).toString('hex')}.html`);
  await writeFile(file, `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="referrer" content="no-referrer">
  <title>Personal AI HQ にログイン</title><form method="post" action="${url}/api/session">
  <input type="hidden" name="key" value="${key}"><button type="submit">Personal AI HQ を開く</button></form>
  <script>document.querySelector('form').requestSubmit()</script></html>`, {mode: 0o600, flag: 'wx'});
  return file;
}

async function download(response, artifact) {
  if (!artifact?.file) throw error(404, '成果物を見つけられませんでした。');
  const {file} = artifact;
  const actual = await realpath(file).catch(() => null);
  if (actual !== file) throw error(404, '成果物の保存先が変わりました。');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) throw error(404, '成果物を開けませんでした。');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw error(404, '成果物を開けませんでした。');
    const filename = encodeURIComponent(basename(file)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`});
    await pipeline(handle.createReadStream({autoClose: false}), response);
  } finally { await handle.close(); }
}

async function checkedSocket(socket) {
  if (socket === undefined) return undefined;
  const invalid = () => new Error('Expected a private Codex socket');
  if (!isAbsolute(socket)) throw invalid();
  const owns = info => !process.getuid || info.uid === process.getuid();
  const privateDirectory = info => info.isDirectory() && owns(info) && (info.mode & 0o077) === 0;
  const [entry, parent, target] = await Promise.all([lstat(socket), lstat(dirname(socket)), realpath(socket)]);
  if (!owns(entry) || !privateDirectory(parent)) throw invalid();
  // The native app-server may publish an owner-controlled link to its private socket.
  const [file, folder] = await Promise.all([lstat(target), lstat(dirname(target))]);
  if (!file.isSocket() || !owns(file) || !privateDirectory(folder)) throw invalid();
  return target;
}

export async function startOwnerApp({directory = defaultRuntime, port = 4328, socket, codex} = {}) {
  directory = resolve(directory);
  await ensurePrivateDirectory(directory);
  const native = codex ?? createCodexClient({socket: await checkedSocket(socket)});
  const chats = createChatStore(directory);
  const operations = createOperations(directory, native);
  let key = randomBytes(32).toString('hex');
  let session = '';
  let expires = 0;
  let signInFile;
  let url;
  let host;
  let closing;

  async function respond(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', browserPolicy);
    if (request.headers.host !== host || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      throw error(403, 'このホストからはアクセスできません。');
    }
    const target = new URL(request.url, url);
    const route = target.pathname;
    const authenticated = Date.now() < expires && sameKey(session, cookieKey(request.headers.cookie));
    const get = request.method === 'GET';
    const post = request.method === 'POST';
    if (get && assets.has(route)) {
      const [file, type] = assets.get(route);
      response.writeHead(200, {'Content-Type': `${type}; charset=utf-8`});
      response.end(await readFile(join(root, file)));
      return;
    }
    if (get && route === '/api/session') {
      const portfolio = authenticated ? await readPortfolio(directory) : null;
      const enabled = native.canWrite === true && portfolio?.view.projects.some(project => project.codexWrite) === true &&
        await Promise.resolve(native.subscriptionReady?.()).catch(() => false) === true;
      return send(response, 200, {authenticated, capabilities: {chatImport: true, codexWrite: enabled}});
    }
    if (post && route === '/api/session') {
      if (!['null', url].includes(request.headers.origin)) throw error(403, 'ログイン元を確認できません。');
      const form = new URLSearchParams(await body(request, 256));
      if (!key || form.getAll('key').length !== 1 || !sameKey(key, form.get('key'))) throw error(403, 'サインイン用のファイルが無効です。');
      key = '';
      await unlink(signInFile).catch(() => {});
      session = randomBytes(32).toString('hex');
      expires = Date.now() + sessionAge * 1000;
      response.writeHead(303, {Location: '/', 'Set-Cookie': `personal_hq=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionAge}`});
      response.end();
      return;
    }
    if (!authenticated) throw error(401, 'サインインが必要です。');
    if (!get && (!post || request.headers.origin !== url)) throw error(403, 'この画面から操作してください。');
    if (get && route === '/api/codex/models') return send(response, 200, await native.models());
    const portfolio = await readPortfolio(directory);
    if (get && route === '/api/portfolio') return send(response, 200, portfolio.view);
    if (get && route === '/api/artifacts/file') return download(response, portfolio.artifacts.get(target.searchParams.get('id')));

    const project = portfolio.projects.get(target.searchParams.get('project'));
    if (!project) throw error(404, '案件を見つけられませんでした。');
    if (route === '/api/codex/run') {
      if (get) return send(response, 200, await operations.read(project, target.searchParams.get('id')));
      if (post) return send(response, 202, await operations.start(project, await jsonBody(request, 64000)));
    }
    if (post && route === '/api/codex/interrupt') {
      const data = await jsonBody(request, 4096);
      if (typeof data?.id !== 'string') throw error(400, '対象のCodex作業を指定してください。');
      return send(response, 202, await operations.interrupt(project, data.id));
    }
    if (get && route === '/api/chat') {
      const id = target.searchParams.get('id');
      const offset = Number(target.searchParams.get('offset') ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000) throw error(400, '会話の位置が正しくありません。');
      const result = id ? chats.read(project.id, id, offset) : chats.list(project.id, (target.searchParams.get('q') ?? '').slice(0, 200));
      if (!result) throw error(404, '会話を見つけられませんでした。');
      return send(response, 200, result);
    }
    if (post && route === '/api/chat/import') {
      const result = chats.import(project.id, await jsonBody(request, 16 * 1024 ** 2));
      if (!result) throw error(400, 'ChatGPTの書き出しから conversations.json を選んでください。');
      return send(response, 200, result);
    }
    if (get && route === '/api/codex/threads') {
      const result = project.cwd.length ? await native.listThreads(project.cwd, target.searchParams.get('cursor')) : {data: [], nextCursor: null};
      return send(response, 200, result);
    }
    if (get && route === '/api/codex/thread') {
      if (!project.cwd.length) throw error(404, 'この案件のCodex接続情報がありません。');
      return send(response, 200, await native.readThread(project.cwd, target.searchParams.get('id'), target.searchParams.get('cursor')));
    }
    throw error(404, '見つかりませんでした。');
  }

  const server = http.createServer({requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 8192}, (request, response) => {
    respond(request, response).catch(problem => {
      if (response.headersSent) { response.destroy(); return; }
      const status = typeof problem?.status === 'number' ? problem.status : 500;
      send(response, status, {error: status === 500 ? '状態を読み取れませんでした。' : problem.message});
    });
  });
  async function close() {
    closing ??= (async () => {
      await new Promise(done => server.close(done));
      operations.close();
      await native.close?.();
      chats.close();
      if (signInFile) await unlink(signInFile).catch(() => {});
    })();
    return closing;
  }
  try {
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(port, '127.0.0.1', () => { server.off('error', fail); done(); });
    });
    host = `127.0.0.1:${server.address().port}`;
    url = `http://${host}`;
    signInFile = await writeSignIn(directory, url, key);
    return {url, signInFile, close};
  } catch (problem) { await close(); throw problem; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startOwnerApp({directory: process.env.HQ_PRIVATE_DIRECTORY, port: Number(process.env.HQ_PORT ?? 4328),
    socket: process.env.HQ_CODEX_SOCKET});
  console.log(JSON.stringify({url: app.url, signInFile: app.signInFile}));
  if (process.argv.includes('--open') && process.platform === 'darwin') {
    spawn('/usr/bin/open', [app.signInFile], {stdio: 'ignore'}).on('error', () => {});
  }
  const shutdown = async () => { await app.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
