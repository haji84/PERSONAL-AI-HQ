import {createHash} from 'node:crypto';
import {validatedDocument} from './text-attachment.mjs';

const conversationSources = new Set(['chatgpt-export', 'chatgpt-live']);
const pageSize = 40;
const displayedLimit = 5000 + pageSize;
const documentName = 'chatgpt-handoff.json';
const problem = (status, message) => Object.assign(new Error(message), {status});
const invalidRange = () => problem(400, '表示した会話の範囲を確認してください。');

function handoffMessage(message) {
  const {role, text, createdAt, status, turnId, document, image} = message;
  return {
    role, text, createdAt,
    ...(status && {status}),
    ...(turnId && {turnId}),
    ...(document && {document: {name: document.name, text: document.text}}),
    ...(image && {image: {mime: image.mime, size: image.size, sha256: image.sha256}}),
  };
}

export function readChatHandoff(chats, project, params) {
  if (!['project', 'id', 'through', 'observedAt', 'viewSha256'].every(key => params.getAll(key).length === 1)) throw invalidRange();
  const id = params.get('id');
  const requested = params.get('through');
  const observedAt = params.get('observedAt');
  const viewSha256 = params.get('viewSha256');
  const through = Number(requested);
  // Match the existing history route's reachable indices, including its final page.
  if (!id || !/^[1-9]\d{0,3}$/.test(requested) || through > displayedLimit || !/^[a-f0-9]{64}$/.test(viewSha256) ||
      !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) throw invalidRange();

  const offset = Math.max(0, through - pageSize);
  const size = through - offset;
  const result = chats.read(project.id, id, offset, {reconcile: false});
  const conversation = result?.conversation;
  if (!conversationSources.has(conversation?.source)) throw problem(404, 'この案件のChatGPT会話を確認できません。');
  if (conversation.importedAt !== observedAt) throw problem(409, '会話が更新されました。表示を更新してから引き継いでください。');
  if (conversation.messages.length < size) throw invalidRange();

  const displayed = conversation.messages.slice(0, size);
  if (createHash('sha256').update(JSON.stringify(displayed)).digest('hex') !== viewSha256) {
    throw problem(409, '表示中の発言が更新されました。履歴を更新してから引き継いでください。');
  }
  if (displayed.some(message => message.status === 'in_progress')) {
    throw problem(409, '応答を受け取り終えてから引き継いでください。');
  }
  const messages = displayed.map(handoffMessage);
  const origin = {
    schemaVersion: 1,
    project: {id: project.id, goal: project.goal, repository: project.repository},
    source: {id, kind: conversation.source, title: conversation.title, observedAt, viewSha256},
  };
  const hasLater = conversation.messages.length > size || result.nextOffset !== null;
  let handoff;
  for (let first = messages.length - 1; first >= 0; first--) {
    const start = offset + first;
    const range = {start, end: through, hasEarlier: start > 0, hasLater};
    const included = messages.slice(first);
    // Escape control characters that a text attachment cannot carry literally.
    const text = JSON.stringify({...origin, range, messages: included}).replace(/[\x7f-\x9f]/g,
      char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    try {
      const {document, digest} = validatedDocument({name: documentName, text});
      handoff = {document, sha256: digest, range, imageCount: included.filter(message => message.image).length};
    } catch (error) {
      if (error.status !== 413 || !handoff) throw error;
      break;
    }
  }
  return handoff;
}

export function chatConversationForHandoff(chats, project, reference) {
  if (reference?.document.name !== documentName) return null;
  try {
    const packet = JSON.parse(reference.document.text);
    if (packet?.schemaVersion !== 1 || packet.project?.id !== project.id || typeof packet.source?.id !== 'string') return null;
    const params = new URLSearchParams({project: project.id, id: packet.source.id, through: packet.range?.end,
      observedAt: packet.source.observedAt, viewSha256: packet.source.viewSha256});
    return readChatHandoff(chats, project, params).sha256 === reference.digest ? packet.source.id : null;
  } catch {
    return null;
  }
}
