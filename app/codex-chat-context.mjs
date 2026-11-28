import {validEvidenceCursor, validEvidenceTarget} from './codex.mjs';
import {validatedDocument} from './text-attachment.mjs';

const problem = (status, message) => Object.assign(new Error(message), {status});
const missingThread = () => problem(404, 'この案件のCodex作業を確認できません。');
const unavailable = () => problem(503, 'このCodex接続から作業記録を照合できません。');
const conversationSources = new Set(['chatgpt-export', 'chatgpt-live']);
const conversationId = /^(?:[a-z0-9_.:-]{1,160}|live\/[a-f0-9-]{36})$/i;
const receiptId = /^[a-z0-9_-]{8,80}$/i;
const hexDigest = /^[a-f0-9]{64}$/;
const statuses = new Set(['completed', 'failed', 'declined', 'inProgress']);
const kinds = new Set(['add', 'update', 'delete']);
const maxPages = 4;
const maxDocumentBytes = 16 * 1024;
const relativeFile = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
  !/[\\:\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(value) &&
  value.split('/').every(part => part && part !== '.' && part !== '..') &&
  !/(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{12,}|github_pat_[a-z0-9_]{12,}|xox[a-z]-[a-z0-9-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)|(?:^|\/)(?:\.env(?:\.[^/]+)?|\.git-credentials|\.netrc|\.npmrc|credentials\.json|auth\.json|id_rsa|id_ed25519)(?:$|\/)|\.(?:pem|key|p12|pfx)$/iu.test(value);
const exactDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function continuation(value, seen) {
  if (value == null) return null;
  if (!validEvidenceCursor(value) || seen.has(value)) throw unavailable();
  seen.add(value);
  return value;
}

async function confirmTurn(native, scope, id, turnId, historyCursor) {
  let cursor = historyCursor;
  const seen = new Set(cursor === null ? [] : [cursor]);
  for (let pages = 1; pages <= maxPages; pages++) {
    const page = await native.readThread(scope, id, cursor);
    if (page?.thread?.id !== id) throw missingThread();
    if (!Array.isArray(page.turns) || page.turns.length > 4) throw unavailable();
    const matches = page.turns.filter(turn => turn?.id === turnId);
    if (matches.length > 1) throw unavailable();
    if (matches.length) {
      if (matches[0].status !== 'completed') throw problem(409, 'Codexの作業が完了してから引き継いでください。');
      return {pages, completedAt: matches[0].completedAt};
    }
    cursor = continuation(page.nextCursor, seen);
    if (!cursor) throw missingThread();
  }
  throw problem(404, '取得範囲内でこのCodex作業を確認できません。');
}

async function turnEvidence(native, scope, id, turnId) {
  const commands = [];
  const files = [];
  const cursors = new Set();
  const ids = new Set();
  let cursor = null;
  let truncated = false;
  let pages = 0;
  do {
    const page = await native.readTurnEvidence(scope, id, turnId, {cursor});
    if (page?.threadId !== id || page.turnId !== turnId || !Array.isArray(page.entries) || page.entries.length > 12) {
      throw unavailable();
    }
    for (const entry of page.entries) {
      if (!validEvidenceTarget(entry?.id) || ids.has(entry.id)) throw unavailable();
      ids.add(entry.id);
      if (!statuses.has(entry.status)) continue;
      if (entry.type === 'command') {
        commands.push({status: entry.status, ...(Number.isSafeInteger(entry.exitCode) && {exitCode: entry.exitCode})});
      } else if (entry.type === 'files' && Array.isArray(entry.changes)) {
        for (const file of entry.changes.slice(0, 20)) {
          if (!relativeFile(file?.path) || !kinds.has(file.kind)) {
            truncated = true;
            continue;
          }
          files.push({path: file.path, kind: file.kind, status: entry.status,
            ...(relativeFile(file.from) && {from: file.from})});
        }
        truncated ||= entry.truncated === true || entry.changes.length > 20;
      }
    }
    pages++;
    cursor = continuation(page.nextCursor, cursors);
  } while (cursor && pages < maxPages);
  return {commands, files, pages, truncated, more: cursor !== null};
}

function selectConversation(chats, operations, project, id, turnId, candidate) {
  const established = operations.chatConversationForTurn(project, id, turnId);
  if (established === undefined) throw problem(409, 'Codexの受付と元の会話の対応を確認できません。');
  const linked = established !== null;
  const selected = established ?? candidate;
  if (selected === null) return null;
  return conversationView(chats, project, selected, linked);
}

function conversationView(chats, project, selected, linked) {
  const source = chats.read(project.id, selected, 0, {reconcile: false})?.conversation;
  return conversationSources.has(source?.source) && source.id === selected
    ? {id: source.id, title: source.title, linked} : null;
}

function createDocument(origin, evidence) {
  const names = ['artifacts', 'commands', 'files'];
  const omitted = Object.fromEntries(names.map(name => [name, evidence[name].length]));
  const packet = {...origin, coverage: {...origin.coverage, omitted}, commands: [], files: [], artifacts: []};
  // Initial omitted counts reserve at least as much space as the final counts.
  let remaining = maxDocumentBytes - Buffer.byteLength(JSON.stringify(packet), 'utf8');
  for (const name of names) {
    for (const entry of evidence[name]) {
      const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + Number(packet[name].length > 0);
      if (bytes > remaining) break;
      packet[name].push(entry);
      remaining -= bytes;
      omitted[name]--;
    }
  }
  const {document, digest} = validatedDocument({name: 'codex-result.json', text: JSON.stringify(packet)});
  const summary = {commands: packet.commands.length, files: packet.files.length, artifacts: packet.artifacts.length};
  return {document, sha256: digest, summary};
}

export async function readCodexChatContext({chats, operations, native, nativeArtifacts, project, params}) {
  const id = params.get('id');
  const turnId = params.get('turn');
  const candidate = params.get('conversation');
  const historyCursor = params.get('historyCursor');
  const receipt = params.get('receipt');
  if (!['project', 'id', 'turn'].every(key => params.getAll(key).length === 1) ||
      params.getAll('conversation').length > 1 || params.getAll('historyCursor').length > 1 ||
      (historyCursor !== null && !validEvidenceCursor(historyCursor)) || !validEvidenceTarget(id) || !validEvidenceTarget(turnId) ||
      (candidate !== null && !conversationId.test(candidate)) ||
      (receipt !== null && (params.getAll('receipt').length !== 1 || !receiptId.test(receipt) || candidate === null ||
        historyCursor !== null))) {
    throw problem(400, 'スレッド、作業、会話の指定を確認してください。');
  }
  if (!project.cwd.length) throw missingThread();
  if (!native.readTurnEvidence || (receipt === null ? !native.readThread : !native.confirmLinkedTurn)) throw unavailable();
  const readReceipt = () => operations.completedChatReceipt(project, candidate, receipt, id, turnId);
  const saved = receipt === null ? null : readReceipt();
  if (receipt !== null && (!saved || !conversationView(chats, project, candidate, true))) throw missingThread();
  let turn;
  let evidence;
  try {
    if (saved) {
      if (await native.confirmLinkedTurn(saved.workspace, id, turnId, receipt) !== true) throw missingThread();
      turn = {pages: 0};
    } else {
      turn = await confirmTurn(native, project.cwd, id, turnId, historyCursor);
    }
    evidence = await turnEvidence(native, saved ? [saved.workspace] : project.cwd, id, turnId);
  } catch (error) {
    if ([404, 409, 503].includes(error?.status)) throw error;
    throw unavailable();
  }
  const checkpoint = project.nativeHandover;
  const inspectArtifacts = checkpoint?.threadId === id && checkpoint?.turnId === turnId && checkpoint.shareArtifacts === true;
  const published = inspectArtifacts ? (await nativeArtifacts.list([project], 0)).artifacts : [];
  const artifacts = published.flatMap(item =>
    relativeFile(item.title) && hexDigest.test(item.sha256) && exactDate(item.observedAt)
      ? [{path: item.title, sha256: item.sha256, observedAt: item.observedAt}] : []);
  const conversation = saved ? conversationView(chats, project, candidate, true) :
    selectConversation(chats, operations, project, id, turnId, candidate);
  if (saved && (!conversation || readReceipt()?.snapshot !== saved.snapshot)) throw missingThread();
  const origin = {schemaVersion: 1, project: {id: project.id}, threadId: id, turnId, status: 'completed',
    ...(exactDate(turn.completedAt) && {completedAt: turn.completedAt}),
    coverage: {turnPages: turn.pages, evidencePages: evidence.pages, moreEvidence: evidence.more,
      sourceTruncated: evidence.truncated || artifacts.length < published.length,
      artifactEvidence: artifacts.length ? 'verified' : inspectArtifacts ? 'unverified' : 'unpublished'}};
  return {threadId: id, turnId, conversation, ...createDocument(origin, {...evidence, artifacts})};
}
