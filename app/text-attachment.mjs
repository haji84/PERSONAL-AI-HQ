import {createHash} from 'node:crypto';

const documentByteLimit = 16 * 1024;
const documentExtension = /\.(?:txt|md|markdown|csv|json)$/i;
const unsafeDocumentName = /[/\\<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const binaryDocumentText = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u;
const documentError = (status, message) => Object.assign(new Error(message), {status});

export const codexResultDocumentName = 'codex-result.json';
export const codexResultStaleCode = 'CODEX_RESULT_STALE';

export function validatedDocument(value) {
  if (value === undefined) return null;
  const invalid = () => documentError(400, 'UTF-8のテキスト、Markdown、CSV、JSONの文書を1件指定してください。');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'text')) throw invalid();
  const {name, text} = value;
  if (typeof name !== 'string' || !name.isWellFormed() || Buffer.byteLength(name, 'utf8') > 255 ||
      unsafeDocumentName.test(name) || !documentExtension.test(name) || typeof text !== 'string' ||
      !text.isWellFormed() || binaryDocumentText.test(text)) throw invalid();
  if (Buffer.byteLength(text, 'utf8') > documentByteLimit) throw documentError(413, '文書は16 KiB以下にしてください。');
  return {document: {name, text}, digest: createHash('sha256').update(text, 'utf8').digest('hex')};
}
