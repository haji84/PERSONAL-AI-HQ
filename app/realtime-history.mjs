import {createHash} from 'node:crypto';

export const realtimeReceiptId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const realtimeArchiveId = /^realtime\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const realtimeReviewHash = /^[a-f0-9]{64}$/;

export function validRealtimeContinuation(value) {
  return value !== null && typeof value === 'object' && Object.keys(value).length === 2 &&
    typeof value.id === 'string' && realtimeArchiveId.test(value.id) &&
    typeof value.review === 'string' && realtimeReviewHash.test(value.review);
}

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function realtimeTranscriptDigest(messages) {
  return hash(messages.map(({role, text}) => [role, text]));
}

export function realtimeArchiveReview(id, updatedAt, messages) {
  return hash([id, updatedAt, messages.map(({role, text, createdAt, turnId}) => [role, text, createdAt, turnId])]);
}
