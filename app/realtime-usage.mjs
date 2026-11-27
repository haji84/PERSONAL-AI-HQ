const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const modalities = new Set(['text_tokens', 'audio_tokens']);
const inputFields = new Set([...modalities, 'cached_tokens', 'cached_tokens_details']);

function countedModalities(details, fields = modalities) {
  if (!object(details) || !count(details.text_tokens) || !count(details.audio_tokens) ||
      Object.entries(details).some(([key, value]) => !fields.has(key) && value !== 0)) return null;
  return {textTokens: details.text_tokens, audioTokens: details.audio_tokens};
}

function totals(usage) {
  if (!object(usage) || ![usage.total_tokens, usage.input_tokens, usage.output_tokens].every(count) ||
      usage.total_tokens !== usage.input_tokens + usage.output_tokens) return null;
  return {totalTokens: usage.total_tokens, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens};
}

export function normalizeRealtimeUsage(usage) {
  const reported = totals(usage);
  if (!reported) return null;
  const input = countedModalities(usage.input_token_details, inputFields);
  const output = countedModalities(usage.output_token_details);
  if (!input || !output || input.textTokens + input.audioTokens !== reported.inputTokens ||
      output.textTokens + output.audioTokens !== reported.outputTokens) return null;
  const cached = usage.input_token_details.cached_tokens;
  const details = usage.input_token_details.cached_tokens_details;
  if (!count(cached)) return null;
  const cachedInput = cached === 0 && details === undefined
    ? {textTokens: 0, audioTokens: 0} : countedModalities(details);
  if (!cachedInput || cachedInput.textTokens + cachedInput.audioTokens !== cached ||
      cachedInput.textTokens > input.textTokens || cachedInput.audioTokens > input.audioTokens) return null;
  return {...reported, input, output, cachedInput};
}

export function normalizeRealtimeTranscriptionUsage(usage) {
  if (!object(usage)) return null;
  if (usage.type === 'duration') {
    return Number.isFinite(usage.seconds) && usage.seconds >= 0
      ? {type: 'duration', seconds: usage.seconds} : null;
  }
  if (usage.type !== 'tokens') return null;
  const reported = totals(usage);
  const input = countedModalities(usage.input_token_details);
  if (!reported || !input || input.textTokens + input.audioTokens !== reported.inputTokens) return null;
  return {type: 'tokens', ...reported, input};
}
