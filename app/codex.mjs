import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import WebSocket from 'ws';

const unavailable = message => Object.assign(new Error(message), {status: 503});
const missing = message => Object.assign(new Error(message), {status: 404});
const threadId = /^[a-z0-9_-]{1,160}$/i;
const maxFrame = 2 * 1024 ** 2;
const clean = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
const items = value => Array.isArray(value) ? value : [];
const cursorText = value => typeof value === 'string' && value.length <= 8192 ? value : null;
const iso = value => Number.isFinite(value) && value >= 0 && value < 253402300800 ? new Date(value * 1000).toISOString() : null;

function binary() {
  if (process.env.HQ_CODEX_BIN) return process.env.HQ_CODEX_BIN;
  return ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'].find(path => existsSync(path)) ?? 'codex';
}

function openTransport(command, socket, onClose, onEvent) {
  const channel = socket ? new WebSocket(`ws+unix://${socket}:/`, {
    maxPayload: maxFrame, handshakeTimeout: 6000, perMessageDeflate: false, followRedirects: false,
  }) : null;
  const child = channel ? null : spawn(command, ['app-server', '--listen', 'stdio://'],
    {stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true});
  const waiting = new Map();
  let buffer = Buffer.alloc(0);
  let lastId = 0;
  let closed = false;
  let exited = false;

  function fail() {
    if (closed) return;
    closed = true;
    for (const {reject, timer} of waiting.values()) {
      clearTimeout(timer);
      reject(unavailable('Codex App Serverの接続を確認できません。'));
    }
    waiting.clear();
    onClose();
    if (channel) channel.terminate();
    else if (!exited && child?.pid) child.kill('SIGTERM');
  }
  let ready = Promise.resolve();
  if (channel) {
    ready = new Promise((resolve, reject) => {
      channel.once('open', resolve);
      channel.once('error', () => reject(unavailable('Codexの専用ソケットに接続できません。')));
    });
    channel.on('error', fail);
    channel.once('close', fail);
  } else {
    child.once('error', fail);
    child.once('exit', () => { exited = true; fail(); });
    child.stdin.on('error', fail);
  }

  function send(value) {
    if (closed) throw unavailable('Codex App Serverの接続を確認できません。');
    const raw = JSON.stringify(value);
    if (channel) channel.send(raw);
    else child.stdin.write(raw + '\n');
  }
  function receive(line) {
    if (closed || line.length === 0) return;
    let value;
    try { value = JSON.parse(line.toString('utf8')); } catch { fail(); return; }
    if (!value || typeof value !== 'object') { fail(); return; }
    if (value.method && Object.hasOwn(value, 'id')) {
      send({id: value.id, error: {code: -32601, message: 'Approval is required in the native client'}});
      return;
    }
    if (typeof value.method === 'string') {
      try { onEvent(value.method, value.params); } catch {}
      return;
    }
    const request = waiting.get(value.id);
    if (!request) return;
    waiting.delete(value.id);
    clearTimeout(request.timer);
    if (value.error) request.reject(unavailable('対象のCodex情報を読み取れませんでした。'));
    else request.resolve(value.result);
  }
  channel?.on('message', (data, binary) => { if (!binary) receive(data); });
  child?.stdout.on('data', chunk => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf(10)) >= 0) {
      if (newline > maxFrame) { fail(); return; }
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      receive(line);
      if (closed) return;
    }
    if (buffer.length > maxFrame) fail();
  });

  return {
    send,
    async call(method, params) {
      await ready;
      if (closed || waiting.size >= 24) return Promise.reject(unavailable('Codexの接続が使用中です。'));
      return new Promise((resolve, reject) => {
        const id = ++lastId;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(unavailable('Codexからの応答が時間内に届きませんでした。'));
        }, 12000);
        waiting.set(id, {resolve, reject, timer});
        try { send({id, method, params}); } catch { fail(); }
      });
    },
    close() { child?.stdin.end(); fail(); },
  };
}

function threadView(row) {
  return {id: row.id, title: clean(row.name, 240) || clean(row.preview, 160) || 'Codexセッション',
    updatedAt: iso(row.updatedAt), status: clean(row.status?.type, 32) || 'unknown'};
}

function plainMessages(content) {
  return items(content).flatMap(item => {
    if (item?.type === 'userMessage') {
      const text = items(item.content).filter(part => part?.type === 'text').map(part => clean(part.text, 18000)).join('\n');
      return text ? [{role: 'user', text: text.slice(0, 24000)}] : [];
    }
    return item?.type === 'agentMessage' && typeof item.text === 'string'
      ? [{role: 'assistant', text: clean(item.text, 24000)}] : [];
  });
}

export function createCodexClient({command = binary(), socket} = {}) {
  let transport;
  let initialized;
  const listeners = new Set();

  async function current() {
    if (!initialized) {
      const next = openTransport(command, socket, () => {
        if (transport === next) { transport = undefined; initialized = undefined; }
      }, (method, params) => { for (const listener of listeners) listener(method, params); });
      transport = next;
      initialized = next.call('initialize', {clientInfo: {name: 'personal_ai_hq', title: 'Personal AI HQ', version: '0.1.0'}})
        .then(() => { next.send({method: 'initialized'}); return next; })
        .catch(error => { next.close(); throw error; });
    }
    return initialized;
  }

  async function scopedThread(scope, id) {
    if (typeof id !== 'string' || !threadId.test(id)) throw missing('スレッドを見つけられませんでした。');
    const rpc = await current();
    const {thread} = await rpc.call('thread/read', {threadId: id, includeTurns: false});
    if (!thread || thread.id !== id || !scope.includes(thread.cwd)) throw missing('この案件のスレッドではありません。');
    return {rpc, thread};
  }

  async function subscriptionReady(rpc) {
    const status = await rpc.call('account/read', {refreshToken: false});
    return status?.account?.type === 'chatgpt' && status.requiresOpenaiAuth === true;
  }

  function recentTurns(rpc, id, cursor) {
    return rpc.call('thread/turns/list', {threadId: id, cursor: cursorText(cursor),
      limit: 4, itemsView: 'summary', sortDirection: 'desc'});
  }

  return {
    canWrite: Boolean(socket),
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async subscriptionReady() { return Boolean(socket) && await subscriptionReady(await current()); },
    async submit({workspace, prompt, knownId, model, effort, requestId, onThread}) {
      if (!socket) throw unavailable('独立して稼働するCodex接続が必要です。');
      const rpc = await current();
      if (!await subscriptionReady(rpc)) throw unavailable('ChatGPTプランの認証を確認できません。');
      if (knownId) await scopedThread([workspace], knownId);
      const params = {cwd: workspace, modelProvider: 'openai', sandbox: 'workspace-write', approvalPolicy: 'never',
        ...(model ? {model} : {})};
      const result = knownId
        ? await rpc.call('thread/resume', {...params, threadId: knownId, excludeTurns: true})
        : await rpc.call('thread/start', params);
      const thread = result?.thread;
      if (!thread?.id || !threadId.test(thread.id) || thread.cwd !== workspace || thread.modelProvider !== 'openai' ||
          (knownId && thread.id !== knownId)) {
        throw unavailable('分離作業先をCodexで確認できませんでした。');
      }
      if (onThread(thread.id) !== true) throw unavailable('送信権限を確認できませんでした。');
      const answer = await rpc.call('turn/start', {threadId: thread.id, clientUserMessageId: requestId,
        input: [{type: 'text', text: prompt, text_elements: []}], cwd: workspace, approvalPolicy: 'never',
        sandboxPolicy: {type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true}, ...(model ? {model} : {}), ...(effort ? {effort} : {})});
      if (!answer?.turn?.id) throw unavailable('Codexの受理IDを確認できませんでした。');
      return {threadId: thread.id, turn: answer.turn};
    },
    async interrupt(workspace, id, turnId) {
      const {rpc} = await scopedThread([workspace], id);
      await rpc.call('turn/interrupt', {threadId: id, turnId});
    },
    async listThreads(scope, cursor) {
      const rpc = await current();
      const result = await rpc.call('thread/list', {cwd: scope, archived: false, limit: 25, cursor: cursorText(cursor)});
      return {data: items(result.data).filter(row => row?.id && scope.includes(row.cwd)).map(threadView),
        nextCursor: cursorText(result.nextCursor)};
    },
    async readThread(scope, id, cursor) {
      const {rpc, thread} = await scopedThread(scope, id);
      const result = await recentTurns(rpc, id, cursor);
      const turns = items(result.data).map(turn => ({id: turn.id, status: clean(turn.status, 32) || 'unknown',
        messages: plainMessages(turn.items), itemCount: items(turn.items).length})).reverse();
      return {thread: threadView(thread), turns, nextCursor: cursorText(result.nextCursor)};
    },
    async findSubmission(workspace, id, clientId, turnId) {
      const {rpc} = await scopedThread([workspace], id);
      let cursor = null;
      for (let page = 0; page < 3; page++) {
        const result = await recentTurns(rpc, id, cursor);
        const exact = items(result.data).find(turn => turnId ? turn.id === turnId :
          items(turn.items).some(item => item?.type === 'userMessage' && item.clientId === clientId));
        if (exact) return {id: exact.id, status: exact.status, startedAt: iso(exact.startedAt)};
        cursor = cursorText(result.nextCursor);
        if (!cursor) break;
      }
      return null;
    },
    async models() {
      const rpc = await current();
      const [models, account] = await Promise.all([
        rpc.call('model/list', {limit: 40, includeHidden: false}),
        rpc.call('account/read', {refreshToken: false}),
      ]);
      return {data: items(models.data).filter(row => row?.model && row.hidden !== true).map(row => ({
        id: row.model, displayName: clean(row.displayName, 100) || row.model, isDefault: row.isDefault === true,
        reasoningEfforts: items(row.supportedReasoningEfforts).map(option => ({reasoningEffort: clean(option.reasoningEffort, 24),
          description: clean(option.description, 160)})), defaultReasoningEffort: clean(row.defaultReasoningEffort, 24),
      })), accountType: clean(account?.account?.type, 32) || null};
    },
    close() { transport?.close(); },
  };
}
