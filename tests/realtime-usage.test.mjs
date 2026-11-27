import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeRealtimeTranscriptionUsage, normalizeRealtimeUsage} from '../app/realtime-usage.mjs';

const realtime = () => ({
  total_tokens: 253,
  input_tokens: 132,
  output_tokens: 121,
  input_token_details: {
    text_tokens: 119,
    audio_tokens: 13,
    image_tokens: 0,
    cached_tokens: 64,
    cached_tokens_details: {text_tokens: 57, audio_tokens: 7, image_tokens: 0},
  },
  output_token_details: {text_tokens: 30, audio_tokens: 91},
});

test('normalizes billable Realtime modalities and the cached input subset', () => {
  assert.deepEqual(normalizeRealtimeUsage(realtime()), {
    totalTokens: 253,
    inputTokens: 132,
    outputTokens: 121,
    input: {textTokens: 119, audioTokens: 13},
    output: {textTokens: 30, audioTokens: 91},
    cachedInput: {textTokens: 57, audioTokens: 7},
  });
  const noCache = realtime();
  noCache.input_token_details.cached_tokens = 0;
  delete noCache.input_token_details.cached_tokens_details;
  assert.deepEqual(normalizeRealtimeUsage(noCache)?.cachedInput, {textTokens: 0, audioTokens: 0});
});

test('refuses incomplete, unpriced, unsafe, or inconsistent Realtime accounting', () => {
  const cases = [
    ['missing usage', undefined],
    ['missing required total', {...realtime(), total_tokens: undefined}],
    ['inconsistent total', {...realtime(), total_tokens: 254}],
    ['inconsistent output detail', {...realtime(), output_token_details: {text_tokens: 31, audio_tokens: 91}}],
    ['missing required modality', {...realtime(), output_token_details: {audio_tokens: 121}}],
    ['missing cached total', {...realtime(), input_token_details: {...realtime().input_token_details, cached_tokens: undefined}}],
    ['missing positive-cache split', {...realtime(), input_token_details: {...realtime().input_token_details, cached_tokens_details: undefined}}],
    ['cached modality exceeds input', {...realtime(), input_token_details: {...realtime().input_token_details,
      cached_tokens_details: {text_tokens: 50, audio_tokens: 14}}}],
    ['cached split does not sum', {...realtime(), input_token_details: {...realtime().input_token_details,
      cached_tokens_details: {text_tokens: 64, audio_tokens: 1}}}],
    ['unpriced image input', {...realtime(), input_token_details: {...realtime().input_token_details,
      text_tokens: 118, image_tokens: 1}}],
    ['unpriced output modality', {...realtime(), output_token_details: {text_tokens: 29, audio_tokens: 91, reasoning_tokens: 1}}],
    ['unsafe integer', {...realtime(), total_tokens: Number.MAX_SAFE_INTEGER + 1}],
    ['negative modality', {...realtime(), output_token_details: {text_tokens: -1, audio_tokens: 122}}],
    ['fractional modality', {...realtime(), output_token_details: {text_tokens: 29.5, audio_tokens: 91.5}}],
  ];
  for (const [label, usage] of cases) assert.equal(normalizeRealtimeUsage(usage), null, label);
});

test('preserves exact duration or per-token accounting for separately billed input transcription', () => {
  assert.deepEqual(normalizeRealtimeTranscriptionUsage({type: 'duration', seconds: 3.25}), {type: 'duration', seconds: 3.25});
  assert.deepEqual(normalizeRealtimeTranscriptionUsage({
    type: 'tokens', total_tokens: 22, input_tokens: 13, output_tokens: 9,
    input_token_details: {text_tokens: 0, audio_tokens: 13},
  }), {
    type: 'tokens', totalTokens: 22, inputTokens: 13, outputTokens: 9,
    input: {textTokens: 0, audioTokens: 13},
  });
});

test('refuses to turn missing or inconsistent transcription usage into a zero charge', () => {
  const tokens = {
    type: 'tokens', total_tokens: 22, input_tokens: 13, output_tokens: 9,
    input_token_details: {text_tokens: 0, audio_tokens: 13},
  };
  for (const usage of [null, undefined, {}, {type: 'duration'}, {type: 'duration', seconds: '3'},
    {type: 'duration', seconds: Infinity}, {type: 'duration', seconds: -1},
    {...tokens, total_tokens: 20}, {...tokens, input_token_details: undefined},
    {...tokens, input_token_details: {text_tokens: 0, audio_tokens: 12, image_tokens: 1}},
    {...tokens, input_token_details: {text_tokens: 0, audio_tokens: 12, another_tokens: 1}},
  ]) assert.equal(normalizeRealtimeTranscriptionUsage(usage), null);
});
