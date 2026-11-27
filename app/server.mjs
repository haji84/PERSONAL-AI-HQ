import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import {constants} from 'node:fs';
import {lstat, open, readFile, realpath, unlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {readCurrentProject, readPortfolio} from './portfolio.mjs';
import {createChatStore} from './chat-store.mjs';
import {createCodexClient, emptyNativeActivity, isCodexLoopbackUrl, validEvidenceCursor, validEvidenceTarget} from './codex.mjs';
import {createOperations} from './operations.mjs';
import {createExecutionAccess} from './execution-access.mjs';
import {createPlanAuth, PLAN_AUTH_CALLBACK_PATH} from './chatgpt-plan-auth.mjs';
import {createChatGPTResponses} from './chatgpt-responses.mjs';
import {ensurePrivateDirectory, readPrivateRuntimeToken} from './private-directory.mjs';
import {createApiDevelopment} from './api-development.mjs';
import {createNativeArtifacts} from './native-artifacts.mjs';
import {createCodexPeerVerifier} from './codex-peer.mjs';
import {localSpeechAvailable, localSpeechMaxChars, synthesizeLocalSpeech} from './local-speech.mjs';
import {createTailnetAccess, tailnetCookieName} from './tailnet-access.mjs';
import {validatedDocument} from './text-attachment.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/dictation.mjs', ['dictation.mjs', 'text/javascript']],
  ['/app.css', ['app.css', 'text/css']]]);
const defaultRuntime = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'PersonalAIHQ', 'integration')
  : join(homedir(), 'Library', 'Application Support', 'Personal AI HQ', 'integration');
const browserPolicy = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const sessionAge = 8 * 60 * 60;
const nativeObservationTimeout = 4000;
const nativeActivityWatch = /^([a-z0-9_-]{1,160}):([a-z0-9_-]{1,160})$/i;
const error = (status, message) => Object.assign(new Error(message), {status});
const apiMessages = {
  API_AUTHORIZATION_REQUIRED: 'この端末の通常API実行は認証が保留中です。',
  API_RUNTIME_UNSUPPORTED: 'この端末で通常APIの隔離実行を確認できません。',
  API_AUTHORITY_MISSING: '本人が確認したAPIの費用・組織設定がありません。',
  API_AUTHORITY_UNSAFE: 'APIの権限設定ファイルを所有者専用として確認できません。',
  API_AUTHORITY_INVALID: 'APIの権限設定を照合できません。',
  API_AUTHORITY_UNBOUND: '通常APIを許可する組織の予算管理先を確認できません。',
  API_CREDIT_UNVERIFIED: '組織の有効な特典残高と追加費用ゼロの条件を確認してください。',
  API_WORKSPACE_NOT_ENROLLED: '通常APIが編集できるこの案件の分離作業先を確認できません。',
  API_TASK_INVALID: '作業番号、指示、工程、モデルの指定を確認してください。',
  HANDOVER_REQUIRED: '前の経路の要求と成果物を照合してから実行してください。',
  HANDOVER_RECEIPT_STALE: '最新の確定済み作業から引継ぎを照合してください。',
  HANDOVER_REQUIREMENTS_MISSING: '作業時に記録した要求の正本がありません。',
  HANDOVER_REQUIREMENTS_CHANGED: '要求の正本を作業時の記録と照合できません。',
  HANDOVER_CONVERSATION_UNVERIFIED: '保存した作業指示と実行結果を受付記録に照合できません。',
  NATIVE_HANDOVER_CHECKPOINT_REQUIRED: '案件の確定済み検証記録と、会話の引継ぎ許可を確認してください。',
  NATIVE_HANDOVER_GIT_CHANGED: '要求、成果物、検証記録を確定済みのGit作業先と照合できません。',
  NATIVE_HANDOVER_ENROLLMENT_REQUIRED: 'この案件で通常APIへの送信を許可した資料と引継ぎ資料が一致しません。',
  NATIVE_HANDOVER_ALREADY_SENT: 'このCodex作業から同じ依頼を送信済みです。',
  API_CANDIDATE_HANDOVER_REQUIRED: '以前の検証済み成果物を現在のGit作業コピーで確認できません。',
  PROJECT_BUSY: '実行中または結果を照合中の作業があります。',
  PROJECT_BUDGET_REQUIRED: 'この案件のAPI作業上限を設定してください。',
  PROJECT_BUDGET_EXCEEDED: 'この案件のAPI作業上限内に予約できません。',
  SHARED_CREDIT_INSUFFICIENT: '共有のAPI特典残高内に作業費用を予約できません。',
  ROUTE_NOT_ALLOWED: 'この案件の実行モードでは通常APIを選択できません。',
  EXECUTION_HELD: '案件の停止条件または未確定の作業を確認してください。',
  API_ARTIFACT_NOT_FOUND: '検証済みの成果物を確認できません。',
  API_ARTIFACT_CHANGED: '成果物が検証記録と一致しません。',
  API_TASK_NOT_FOUND: '中断するAPI作業を確認できません。',
};

function send(response, status, payload, extra = {}) {
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', ...extra});
  response.end(JSON.stringify(payload));
}

function activityWatches(params) {
  const requested = params.getAll('watch');
  if (params.getAll('native').length !== 1 || requested.length > 3 || new Set(requested).size !== requested.length) {
    throw error(400, '確認するCodex作業を3件以内で指定してください。');
  }
  return requested.map(value => {
    const match = nativeActivityWatch.exec(value);
    if (!match) throw error(400, '確認するCodex作業の番号が正しくありません。');
    return {threadId: match[1], turnId: match[2]};
  });
}

async function observeNativeActivity(native, project, watches, isManaged, response) {
  if (!project.cwd.length || !native.readActivity) return emptyNativeActivity('unconfigured');
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, nativeObservationTimeout);
  response.once('close', abort);
  try {
    const stopped = once(controller.signal, 'abort').then(() => emptyNativeActivity('unavailable'));
    const read = native.readActivity(project.cwd, watches, {signal: controller.signal, isManaged});
    return await Promise.race([read, stopped]);
  } catch {
    return emptyNativeActivity('unavailable');
  } finally {
    clearTimeout(timer);
    response.off('close', abort);
    abort();
  }
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

function cookieKey(header, name = 'personal_hq') {
  const prefix = `${name}=`;
  const matches = (header ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(prefix));
  return matches.length === 1 ? matches[0].slice(prefix.length) : null;
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

export async function startOwnerApp({directory = defaultRuntime, port = 4328, socket, codex, plan, apiDevelopment = false, speech,
  loopbackUrl, loopbackTokenFile, tailnet} = {}) {
  const access = createTailnetAccess(tailnet, sessionAge);
  directory = resolve(directory);
  await ensurePrivateDirectory(directory);
  let loopback;
  if (loopbackUrl !== undefined || loopbackTokenFile !== undefined) {
    if (socket !== undefined || codex || typeof loopbackUrl !== 'string' || typeof loopbackTokenFile !== 'string' ||
        !loopbackUrl || !loopbackTokenFile) throw new Error('Codexのローカル接続先と本人専用トークンを指定してください。');
    if (!isCodexLoopbackUrl(loopbackUrl)) throw new TypeError('Codexの接続先には端末内のループバックポートを指定してください。');
    const [token, verifyPeer] = await Promise.all([
      readPrivateRuntimeToken(directory, loopbackTokenFile), createCodexPeerVerifier(),
    ]);
    loopback = {url: loopbackUrl, token, verifyPeer};
  }
  const native = codex ?? createCodexClient({socket: await checkedSocket(socket), loopback});
  const chats = createChatStore(directory);
  const execution = createExecutionAccess(directory, native);
  const operations = createOperations(directory, native, execution, {
    prepareHandover: (...args) => apiWork.prepareNativeHandover(...args),
  });
  const nativeArtifacts = createNativeArtifacts(directory, operations.completedArtifactSource);
  const apiEnabled = Boolean(apiDevelopment);
  const apiWork = createApiDevelopment({...(!apiEnabled || apiDevelopment === true ? {} : apiDevelopment),
    directory, store: execution.store, conversations: chats, hasNativeWork: operations.hasNativeWork, hasActiveWork: operations.hasActiveWork,
    completedNativeSource: operations.completedSource, readHandoverTurn: (...args) => native.readHandoverTurn?.(...args),
    withProjectWorkLock: (project, act) => operations.updateExecution(project, () => {
      if (chats.hasActiveLive(project.id)) throw error(409, 'ChatGPTの応答が終わるまで開始できません。');
      return act();
    })});
  if (plan === true) {
    const auth = createPlanAuth({directory});
    plan = {auth, responses: createChatGPTResponses({auth})};
  }
  const speechService = speech ?? {available: localSpeechAvailable, synthesize: (text, options) => synthesizeLocalSpeech(directory, text, options)};
  const liveRequests = new Set();
  let speechTask;
  let key = randomBytes(32).toString('hex');
  let session = '';
  let expires = 0;
  let signInFile;
  let url;
  let host;
  let closing;

  async function liveChat(project, input, response) {
    if (!plan) throw error(503, 'ChatGPTプランの接続が設定されていません。');
    if (typeof input?.model !== 'string' || !input.model || input.model.length > 160 ||
        typeof input.id !== 'string' || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000) {
      throw error(400, '会話の入力とモデルを指定してください。');
    }
    const attachment = validatedDocument(input.document);
    const controller = new AbortController();
    liveRequests.add(controller);
    const cancel = () => controller.abort();
    response.once('close', cancel);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
    let text = '';
    let request;
    async function publish(event) {
      if (response.destroyed) return;
      if (!response.write(`data: ${JSON.stringify(event)}\n\n`)) await once(response, 'drain', {signal});
    }
    try {
      let selection;
      if (!chats.readLive(project.id, input.id)) {
        execution.preflight(project, 'consultation');
        const entries = await plan.responses.models({signal});
        const catalog = {accountType: 'chatgpt', data: entries.map((value, index) => ({id: value.slug,
          isDefault: index === 0, reasoningEfforts: []}))};
        selection = await execution.authorize(project, {stage: 'consultation', model: input.model, catalog});
      }
      signal.throwIfAborted();
      const confirmRoute = () => {
        if (!selection || !execution.isCurrent(project, selection.revision, 'consultation')) {
          throw error(409, '実行経路が更新されました。もう一度確認してください。');
        }
      };
      request = chats.beginLive(project.id, {...input, document: attachment?.document}, confirmRoute);
      response.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8'});
      if (request.duplicate) {
        await publish({type: 'done', turn: request.turn});
        return;
      }
      await publish({type: 'started', turn: request.turn});
      let status = 'completed';
      let savedAt = Date.now();
      try {
        confirmRoute();
        for await (const delta of plan.responses.stream({model: selection.model, messages: request.messages, signal, beforeSend: confirmRoute})) {
          text += delta;
          if (Date.now() - savedAt >= 500) {
            chats.persistLiveText(project.id, input.id, text);
            savedAt = Date.now();
          }
          await publish({type: 'delta', text: delta});
        }
      } catch (cause) {
        status = controller.signal.aborted ? 'aborted' : signal.aborted ? 'interrupted' :
          cause.code === 'CHATGPT_PLAN_INCOMPLETE' ? 'incomplete' :
          cause.code === 'CHATGPT_PLAN_INTERRUPTED' ? 'interrupted' : 'failed';
      }
      chats.finishLive(project.id, input.id, {status, text});
      await publish({type: 'done', turn: chats.readLive(project.id, input.id)});
    } catch (cause) {
      if (request && !request.duplicate) chats.finishLive(project.id, input.id, {status: 'interrupted', text});
      if (!response.headersSent && !response.destroyed) throw cause.code?.startsWith('CHATGPT_PLAN_')
        ? error(503, 'ChatGPTプランの接続、モデルまたは利用枠を確認してください。') : cause;
    } finally {
      liveRequests.delete(controller);
      response.off('close', cancel);
      if (response.headersSent && !response.destroyed) response.end();
    }
  }

  async function speak(input, response) {
    if (typeof input?.text !== 'string' || !input.text.trim() || input.text.length > localSpeechMaxChars || Object.keys(input).length !== 1) {
      throw error(400, '読み上げる文字を確認してください。');
    }
    if (!await speechService.available()) throw error(503, 'この端末の日本語読み上げを利用できません。');
    const previous = speechTask;
    if (previous?.controller.signal.aborted) await previous.pending.catch(() => {});
    if (response.destroyed || closing) return;
    if (speechTask && (speechTask !== previous || !speechTask.controller.signal.aborted)) {
      throw error(409, '先に開始した読み上げを準備しています。');
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once('close', cancel);
    const pending = Promise.resolve().then(() => speechService.synthesize(input.text, {signal: controller.signal}));
    const task = {controller, pending};
    speechTask = task;
    try {
      const audio = await pending;
      if (response.destroyed || controller.signal.aborted) return;
      response.writeHead(200, {'Content-Type': 'audio/wav', 'Content-Length': audio.byteLength});
      response.end(audio);
    } finally {
      response.off('close', cancel);
      if (speechTask === task) speechTask = null;
    }
  }

  async function respond(request, response, remote) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', browserPolicy);
    const origin = remote ? access.origin : url;
    const validHost = remote ? access.accepts(request) : request.headers.host === host &&
      !Object.hasOwn(request.headers, 'x-forwarded-host') && !Object.hasOwn(request.headers, 'x-forwarded-proto');
    if (!validHost || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      throw error(403, 'このホストからはアクセスできません。');
    }
    const target = new URL(request.url, origin);
    if (target.origin !== origin) throw error(403, 'このホストからはアクセスできません。');
    const route = target.pathname;
    const cookie = cookieKey(request.headers.cookie, remote ? tailnetCookieName : undefined);
    const signedIn = () => remote ? access.authenticated(cookie) : Date.now() < expires && sameKey(session, cookie);
    const authenticated = signedIn();
    const get = request.method === 'GET';
    const post = request.method === 'POST';
    if (remote && (route === PLAN_AUTH_CALLBACK_PATH || route === '/api/chat/plan' ||
        route.startsWith('/api/chat/plan/') || route === '/api/chat/live')) {
      throw error(404, 'この接続からは利用できません。');
    }
    if (get && route === PLAN_AUTH_CALLBACK_PATH && plan) {
      let result = 'connected';
      try { await plan.auth.complete(url, Date.now() < expires ? session : '', target.searchParams); }
      catch { result = 'check'; }
      response.writeHead(303, {Location: `/?chatgpt=${result}#chat`});
      response.end();
      return;
    }
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
      return send(response, 200, {authenticated, capabilities: {chatImport: true, codexWrite: enabled,
        executionSettings: authenticated, executionActivity: authenticated, chatgptPlan: !remote && authenticated && Boolean(plan),
        apiDevelopment: authenticated && apiEnabled, localSpeech: authenticated && await speechService.available(),
        tailnetPairing: !remote && authenticated && Boolean(access), tailnetSignIn: remote}});
    }
    if (post && route === '/api/session' && !remote) {
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
    if (post && access && route === '/api/access/redeem') {
      if (!remote || request.headers.origin !== origin) throw error(403, 'サインイン元を確認できません。');
      const {code} = await jsonBody(request, 256) ?? {};
      const token = access.redeem(code);
      if (!token) throw error(403, '接続コードが無効か、期限切れです。');
      return send(response, 200, {authenticated: true}, {'Set-Cookie':
        `${tailnetCookieName}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionAge}`});
    }
    if (!authenticated) throw error(401, 'サインインが必要です。');
    if (!get && (!post || request.headers.origin !== origin)) throw error(403, 'この画面から操作してください。');
    if (post && access && ['/api/access/pair', '/api/access/revoke'].includes(route)) {
      if (remote) throw error(403, 'ホスト端末で操作してください。');
      if (route === '/api/access/pair') return send(response, 200, access.pair());
      access.revoke();
      return send(response, 200, {revoked: true});
    }
    if (post && remote && route === '/api/access/end') {
      access.end(cookie);
      return send(response, 200, {authenticated: false}, {'Set-Cookie':
        `${tailnetCookieName}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`});
    }
    if (get && route === '/api/codex/models') return send(response, 200, await native.models());
    if (get && route === '/api/usage') {
      const subscription = await Promise.resolve(native.usage?.()).catch(() => null);
      return send(response, 200, {subscription: subscription ?? null});
    }
    if (get && route === '/api/chat/plan' && plan) return send(response, 200, await plan.auth.status());
    if (post && route === '/api/chat/plan/authorize' && plan) {
      try { return send(response, 200, {authorizationUrl: await plan.auth.begin(url, session)}); }
      catch { throw error(503, 'この端末でChatGPTプランの認証を開始できませんでした。'); }
    }
    if (get && route === '/api/chat/plan/models' && plan) {
      try { return send(response, 200, {models: await plan.responses.models({signal: AbortSignal.timeout(12000)})}); }
      catch (cause) {
        if (cause.code === 'CHATGPT_PLAN_AUTH_REQUIRED') throw error(403, 'ChatGPTプランを再認証してください。');
        throw error(503, 'このChatGPTプランのモデルを読み取れませんでした。');
      }
    }
    const portfolio = await readPortfolio(directory);
    if (get && route === '/api/portfolio') return send(response, 200, portfolio.view);
    if (get && route === '/api/artifacts/file') return download(response, portfolio.artifacts.get(target.searchParams.get('id')));
    if (get && route === '/api/artifacts/work') {
      const offset = Number(target.searchParams.get('offset') ?? 0);
      const scope = target.searchParams.get('project');
      const source = target.searchParams.getAll('source');
      if (!Number.isSafeInteger(offset) || offset < 0) throw error(400, '成果物一覧の位置が正しくありません。');
      if ((scope !== null && !portfolio.projects.has(scope)) || target.searchParams.getAll('project').length > 1) {
        throw error(404, '案件を見つけられませんでした。');
      }
      if (source.length > 1 || (source.length && source[0] !== 'codex')) throw error(400, '成果物の取得元を確認できません。');
      if (source[0] === 'codex') {
        const projects = scope === null ? [...portfolio.projects.values()] : [portfolio.projects.get(scope)];
        const result = await nativeArtifacts.list(projects, offset);
        if (!signedIn()) throw error(401, 'サインインが必要です。');
        return send(response, 200, result);
      }
      return send(response, 200, apiWork.listArtifacts(scope === null ? [...portfolio.projects.keys()] : [scope], offset));
    }

    const project = portfolio.projects.get(target.searchParams.get('project'));
    if (!project) throw error(404, '案件を見つけられませんでした。');
    if (get && route === '/api/execution/activity') {
      if (target.searchParams.getAll('project').length !== 1) throw error(404, '案件を見つけられませんでした。');
      const watch = target.searchParams.getAll('native').includes('1') ? activityWatches(target.searchParams) : null;
      const {activity: codexActivity} = await operations.readActivity(project);
      const apiActivity = apiWork.activity(project);
      const activity = apiActivity && (!codexActivity || apiActivity.createdAt >= codexActivity.createdAt) ? apiActivity : codexActivity;
      if (!watch) return send(response, 200, {activity});
      const nativeActivity = await observeNativeActivity(native, project, watch,
        id => operations.hasManagedActivityThread(project, id), response);
      if (response.destroyed) return;
      const current = readCurrentProject(directory, project.id);
      if (!current || current.cwd.length !== project.cwd.length || current.cwd.some(cwd => !project.cwd.includes(cwd))) {
        throw error(404, '案件を見つけられませんでした。');
      }
      return send(response, 200, {activity, nativeActivity});
    }
    if (get && route === '/api/execution/handover') {
      const scopes = [...target.searchParams.getAll('receipt'), ...target.searchParams.getAll('thread')];
      if (target.searchParams.getAll('project').length !== 1 || scopes.length !== 1) {
        throw error(404, '案件と対象の作業を指定してください。');
      }
      const proof = await (target.searchParams.has('thread') ? apiWork.previewNativeHandover(project, scopes[0])
        : apiWork.previewHandover(project, scopes[0]));
      return send(response, 200, proof);
    }
    if (route === '/api/execution/settings') {
      if (get) return send(response, 200, {...execution.settings(project), apiAvailable: apiEnabled && apiWork.capabilities(project).available});
      if (post) {
        const input = await jsonBody(request, 8192);
        return send(response, 200, operations.updateExecution(project, () => {
          if (chats.hasActiveLive(project.id)) throw error(409, 'ChatGPTの応答が終わってから設定を変更してください。');
          return execution.update(project, input);
        }));
      }
    }
    if (get && ['/api/artifacts/work/file', '/api/execution/api/artifact'].includes(route)) {
      if (target.searchParams.getAll('project').length !== 1) throw error(404, '案件を見つけられませんでした。');
      const value = target.searchParams.get('index');
      if (!value || !/^\d{1,2}$/.test(value)) throw error(404, apiMessages.API_ARTIFACT_NOT_FOUND);
      const source = target.searchParams.getAll('source');
      const receipt = target.searchParams.get('id');
      const part = target.searchParams.get('part');
      if (source.length && (source.length !== 1 || source[0] !== 'codex' || route !== '/api/artifacts/work/file' ||
          ['id', 'index', 'part', 'review'].some(key => target.searchParams.getAll(key).length !== 1))) {
        throw error(404, apiMessages.API_ARTIFACT_NOT_FOUND);
      }
      const {bytes, name} = source.length
        ? await nativeArtifacts.artifact(project, receipt, Number(value), part, target.searchParams.get('review'))
        : await apiWork.artifact(project, receipt, Number(value));
      if (!signedIn()) throw error(401, 'サインインが必要です。');
      const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`});
      response.end(bytes);
      return;
    }
    if (route.startsWith('/api/execution/api')) {
      if (!apiEnabled) throw error(409, apiMessages.API_AUTHORIZATION_REQUIRED);
      if (target.searchParams.getAll('project').length !== 1) throw error(404, '案件を見つけられませんでした。');
      if (get && route === '/api/execution/api/capabilities') return send(response, 200, apiWork.capabilities(project));
      if (get && route === '/api/execution/api') return send(response, 200, apiWork.read(project, target.searchParams.get('id') ?? undefined));
      if (post && route === '/api/execution/api') return send(response, 202, await apiWork.start(project, await jsonBody(request, 64000)));
      if (post && route === '/api/execution/api/interrupt') {
        const input = await jsonBody(request, 4096);
        return send(response, 202, apiWork.interrupt(project, input?.id));
      }
    }
    if (route === '/api/codex/run') {
      if (get) {
        if (target.searchParams.has('thread') && (target.searchParams.getAll('thread').length !== 1 ||
            target.searchParams.getAll('project').length !== 1)) throw error(400, '照合するスレッドを1件指定してください。');
        return send(response, 200, await operations.read(project, target.searchParams.get('id'),
          target.searchParams.get('handoverReceipt'), target.searchParams.get('thread')));
      }
      if (post) {
        const input = await jsonBody(request, 768 * 1024);
        if (input?.expectedThreadId !== undefined && target.searchParams.getAll('project').length !== 1) {
          throw error(400, '案件を1件指定してください。');
        }
        return send(response, 202, await operations.start(project, input));
      }
    }
    if (post && route === '/api/codex/interrupt') {
      const data = await jsonBody(request, 4096);
      if (typeof data?.id !== 'string') throw error(400, '対象のCodex作業を指定してください。');
      return send(response, 202, await operations.interrupt(project, data.id));
    }
    if (post && route === '/api/codex/cancel') {
      if (target.searchParams.getAll('project').length !== 1) throw error(404, '案件を見つけられませんでした。');
      const data = await jsonBody(request, 4096);
      if (typeof data?.id !== 'string') throw error(400, '中止するCodex作業を指定してください。');
      return send(response, 202, await operations.cancel(project, data.id));
    }
    if (route === '/api/codex/steer') {
      if (get) return send(response, 200, await operations.readSteering(project, target.searchParams.get('id')));
      if (post) return send(response, 202, await operations.steer(project, await jsonBody(request, 64000)));
    }
    if (get && route === '/api/chat') {
      const id = target.searchParams.get('id');
      const offset = Number(target.searchParams.get('offset') ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000) throw error(400, '会話の位置が正しくありません。');
      const result = id ? chats.read(project.id, id, offset) : chats.list(project.id, (target.searchParams.get('q') ?? '').slice(0, 200));
      if (!result) throw error(404, '会話を見つけられませんでした。');
      return send(response, 200, id ? apiWork.conversationView(project, result, offset) : result);
    }
    if (route === '/api/chat/live') {
      if (get) return send(response, 200, {turn: chats.readLive(project.id, target.searchParams.get('id'))});
      if (post) return liveChat(project, await jsonBody(request, 96 * 1024), response);
    }
    if (post && route === '/api/chat/speech') {
      if (target.searchParams.getAll('project').length !== 1) throw error(404, '案件を指定してください。');
      return speak(await jsonBody(request, 16384), response);
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
      if (!project.cwd.length || target.searchParams.getAll('project').length !== 1 || target.searchParams.getAll('id').length !== 1) {
        throw error(404, 'この案件のCodex接続情報がありません。');
      }
      const id = target.searchParams.get('id');
      const {desktopThreadId, ...view} = await native.readThread(project.cwd, id, target.searchParams.get('cursor'));
      const managed = operations.managesThread(project, id);
      return send(response, 200, {...view, managed, ...(!remote && !managed && desktopThreadId === id ? {desktopThreadId} : {})});
    }
    if (get && route === '/api/codex/evidence') {
      const params = target.searchParams;
      if (!project.cwd.length || params.getAll('project').length !== 1) {
        throw error(404, 'この案件のCodex接続情報がありません。');
      }
      const id = params.get('id');
      const turn = params.get('turn');
      const cursor = params.get('cursor');
      const item = params.get('item');
      if (!validEvidenceTarget(id) || !validEvidenceTarget(turn) || params.getAll('id').length !== 1 ||
          params.getAll('turn').length !== 1 || params.getAll('cursor').length > 1 || params.getAll('item').length > 1 ||
          (cursor !== null && (!validEvidenceCursor(cursor) || item !== null)) || (item !== null && !validEvidenceTarget(item))) {
        throw error(400, 'スレッド、作業、取得位置の指定を確認してください。');
      }
      if (!native.readTurnEvidence) throw error(503, 'このCodex接続から作業記録を取得できません。');
      const result = await native.readTurnEvidence(project.cwd, id, turn, {cursor, item});
      const current = readCurrentProject(directory, project.id);
      if (!current || current.cwd.length !== project.cwd.length || current.cwd.some(cwd => !project.cwd.includes(cwd))) {
        throw error(404, 'この案件のCodex接続情報がありません。');
      }
      if (!signedIn()) throw error(401, 'サインインが必要です。');
      return send(response, 200, result);
    }
    throw error(404, '見つかりませんでした。');
  }

  const makeServer = remote => http.createServer({requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 8192}, (request, response) => {
    respond(request, response, remote).catch(problem => {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      const status = typeof problem?.status === 'number' ? problem.status : 500;
      send(response, status, {error: status === 500 ? '状態を読み取れませんでした。' : apiMessages[problem.code] ?? problem.message,
        ...(['CODEX_IMAGE_MODEL_UNAVAILABLE', 'CODEX_RESUME_TARGET_UNAVAILABLE'].includes(problem.code) ? {code: problem.code} : {})});
    });
  });
  const server = makeServer(false);
  const proxyServer = access && makeServer(true);
  const servers = proxyServer ? [server, proxyServer] : [server];
  const listen = (listener, listenPort) => new Promise((done, fail) => {
    listener.once('error', fail);
    listener.listen(listenPort, '127.0.0.1', () => { listener.off('error', fail); done(); });
  });
  async function close() {
    closing ??= (async () => {
      for (const controller of liveRequests) controller.abort();
      speechTask?.controller.abort();
      await speechTask?.pending.catch(() => {});
      await apiWork.close();
      await Promise.all(servers.map(listener => new Promise(done => listener.close(done))));
      operations.close();
      await native.close?.();
      chats.close();
      if (signInFile) await unlink(signInFile).catch(() => {});
    })();
    return closing;
  }
  try {
    await listen(server, port);
    host = `127.0.0.1:${server.address().port}`;
    url = `http://${host}`;
    signInFile = await writeSignIn(directory, url, key);
    if (!proxyServer) return {url, signInFile, close};
    await listen(proxyServer, access.port);
    return {url, signInFile, close, tailnetUrl: access.origin, tailnetTarget: `http://127.0.0.1:${proxyServer.address().port}`};
  } catch (problem) { await close(); throw problem; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {HQ_TAILNET_ORIGIN: origin, HQ_TAILNET_LOGIN: login, HQ_TAILNET_PROXY_PORT: proxyPort} = process.env;
  const tailnet = [origin, login, proxyPort].some(value => value !== undefined)
    ? {origin, login, port: /^[1-9]\d{0,4}$/.test(proxyPort ?? '') ? Number(proxyPort) : NaN} : undefined;
  const app = await startOwnerApp({directory: process.env.HQ_PRIVATE_DIRECTORY, port: Number(process.env.HQ_PORT ?? 4328),
    socket: process.env.HQ_CODEX_SOCKET, plan: process.env.HQ_CHATGPT_PLAN === '1', apiDevelopment: process.env.HQ_API_EXECUTION === '1',
    loopbackUrl: process.env.HQ_CODEX_LOOPBACK_URL, loopbackTokenFile: process.env.HQ_CODEX_LOOPBACK_TOKEN_FILE, tailnet});
  console.log(JSON.stringify({url: app.url, signInFile: app.signInFile, ...(app.tailnetTarget && {tailnetTarget: app.tailnetTarget})}));
  if (process.argv.includes('--open') && process.platform === 'darwin') {
    spawn('/usr/bin/open', [app.signInFile], {stdio: 'ignore'}).on('error', () => {});
  }
  const shutdown = async () => { await app.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
