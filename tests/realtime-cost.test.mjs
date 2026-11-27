import assert from 'node:assert/strict';
import test from 'node:test';
import {maximumRealtimeCostMicros, normalizeRealtimeCostConfig, realtimeResponseMicros,
  realtimeTranscriptionMicros} from '../app/realtime-cost.mjs';
import {normalizeRealtimeTranscriptionUsage, normalizeRealtimeUsage} from '../app/realtime-usage.mjs';

const config = {model: 'fixture-1', voice: 'fixture.voice', transcriptionModel: 'fixture_ASR',
  contextTokens: 1000, maxInputSeconds: 7, maxOutputTokens: 100,
  rates: {inputTextUsdPerMillion: 2, inputAudioUsdPerMillion: 9, cachedTextUsdPerMillion: 0.5,
    cachedAudioUsdPerMillion: 11, outputTextUsdPerMillion: 3, outputAudioUsdPerMillion: 13},
  transcription: {type: 'duration', usdPerMinute: 0.06, billingIncrementSeconds: 3},
};
const tokenConfig = {...config, transcription: {type: 'tokens', maxInputTokens: 120, maxOutputTokens: 20,
  inputTextUsdPerMillion: 0.2, inputAudioUsdPerMillion: 2.5, outputTextUsdPerMillion: 3}};
const responseUsage = normalizeRealtimeUsage({total_tokens: 20, input_tokens: 15, output_tokens: 5,
  input_token_details: {text_tokens: 10, audio_tokens: 5, cached_tokens: 6,
    cached_tokens_details: {text_tokens: 4, audio_tokens: 2}},
  output_token_details: {text_tokens: 2, audio_tokens: 3},
});
const tokenUsage = normalizeRealtimeTranscriptionUsage({type: 'tokens', total_tokens: 10,
  input_tokens: 5, output_tokens: 5, input_token_details: {text_tokens: 2, audio_tokens: 3}});
const duration = seconds => normalizeRealtimeTranscriptionUsage({type: 'duration', seconds});

test('configuration is exactly shaped with bounded signed rates and positive caps', () => {
  const normalized = normalizeRealtimeCostConfig(config);
  assert.deepEqual(normalized, config);
  assert.notEqual(normalized, config);
  assert.notEqual(normalized.rates, config.rates);
  assert.notEqual(normalized.transcription, config.transcription);
  assert.deepEqual(normalizeRealtimeCostConfig(tokenConfig), tokenConfig);
  for (const invalid of [
    null, {...config, alternate: true}, {...config, model: ' bad'}, {...config, voice: 'a\n'},
    {...config, contextTokens: 511}, {...config, contextTokens: 2_000_001}, {...config, maxOutputTokens: 1001},
    {...config, maxOutputTokens: 0}, {...config, maxOutputTokens: 4097},
    {...config, maxInputSeconds: 0}, {...config, maxInputSeconds: 61}, {...config, maxInputSeconds: 1.5},
    ...[Infinity, NaN, -1, '1', 1_000_001].map(value => ({...config, rates: {...config.rates, inputTextUsdPerMillion: value}})),
    {...config, rates: {...config.rates, inputTextUsdPerMillion: undefined}}, {...config, rates: {...config.rates, other: 0}},
    {...config, transcription: {...config.transcription, billingIncrementSeconds: 0}},
    {...config, transcription: {...config.transcription, billingIncrementSeconds: 61}},
    {...config, transcription: {...config.transcription, usdPerMinute: -1}},
    {...config, transcription: {...config.transcription, maxOutputTokens: 2}},
    {...tokenConfig, transcription: {...tokenConfig.transcription, maxInputTokens: 0}},
    {...tokenConfig, transcription: {...tokenConfig.transcription, maxOutputTokens: 0}},
    {...tokenConfig, transcription: {...tokenConfig.transcription, maxOutputTokens: 2_000_001}},
  ]) {
    assert.equal(normalizeRealtimeCostConfig(invalid), null);
    assert.equal(maximumRealtimeCostMicros(invalid), null);
  }
});

test('reservation covers full model context, expensive cache, output and separate ASR ceiling', () => {
  assert.equal(maximumRealtimeCostMicros(config), 21_300);
  assert.equal(maximumRealtimeCostMicros(tokenConfig), 12_660);
  const fractional = {...config, contextTokens: 512, maxOutputTokens: 1, maxInputSeconds: 1,
    rates: Object.fromEntries(Object.keys(config.rates).map(key => [key, 0.00001])),
    transcription: {type: 'duration', usdPerMinute: 0.000001, billingIncrementSeconds: 0.1}};
  assert.equal(maximumRealtimeCostMicros(fractional), 2);
});

test('response separately prices exact cache modalities and refuses inconsistent counts', () => {
  assert.equal(realtimeResponseMicros(config, responseUsage), 108);
  for (const invalid of [
    null, tokenUsage, {...responseUsage, type: 'tokens'}, {...responseUsage, totalTokens: 19},
    {...responseUsage, input: {...responseUsage.input, textTokens: 9}},
    {...responseUsage, output: {...responseUsage.output, imageTokens: 1}},
    {...responseUsage, cachedInput: {...responseUsage.cachedInput, audioTokens: 6}},
    {...responseUsage, cachedInput: {textTokens: 4}}, {...responseUsage, outputTokens: NaN},
  ]) assert.equal(realtimeResponseMicros(config, invalid), null);
  const exact = {...config, rates: {...config.rates, inputTextUsdPerMillion: 0.14}};
  const hundred = {totalTokens: 100, inputTokens: 100, outputTokens: 0, input: {textTokens: 100, audioTokens: 0},
    output: {textTokens: 0, audioTokens: 0}, cachedInput: {textTokens: 0, audioTokens: 0}};
  assert.equal(realtimeResponseMicros(exact, hundred), 14);
  const tiny = {...exact, rates: {...exact.rates, inputTextUsdPerMillion: Number.MIN_VALUE}};
  assert.equal(realtimeResponseMicros(tiny, hundred), 1);
});

test('ASR duration quantum and token pricing are separate and reject mismatched usage families', () => {
  assert.equal(realtimeTranscriptionMicros(config, duration(0)), 0);
  assert.equal(realtimeTranscriptionMicros(config, duration(6)), 6000);
  assert.equal(realtimeTranscriptionMicros(config, duration(6.0001)), 9000);
  const fractional = {...config, transcription: {...config.transcription, billingIncrementSeconds: 0.1}};
  assert.equal(realtimeTranscriptionMicros(fractional, duration(0.3)), 300);
  assert.equal(realtimeTranscriptionMicros(fractional, duration(0.30000000000000004)), 400);
  assert.equal(realtimeTranscriptionMicros(tokenConfig, tokenUsage), 23);
  for (const [settings, observed] of [[config, tokenUsage], [tokenConfig, duration(1)], [config, {}],
    [config, {type: 'duration', seconds: Infinity}], [config, {type: 'duration', seconds: -1}],
    [tokenConfig, {...tokenUsage, totalTokens: 11}], [tokenConfig, {...tokenUsage, input: {textTokens: 2, audioTokens: 4}}],
  ]) assert.equal(realtimeTranscriptionMicros(settings, observed), null);
});

test('known overruns retain their real price, while amounts outside safe integer micros are refused', () => {
  const over = {...responseUsage, totalTokens: 3000, inputTokens: 2000, outputTokens: 1000,
    input: {textTokens: 0, audioTokens: 2000}, output: {textTokens: 0, audioTokens: 1000},
    cachedInput: {textTokens: 0, audioTokens: 1900}};
  assert.equal(realtimeResponseMicros(config, over), 34_800);
  assert.equal(realtimeTranscriptionMicros(config, duration(61)), 63_000);
  assert.equal(realtimeTranscriptionMicros(tokenConfig, {...tokenUsage, totalTokens: 2000,
    inputTokens: 1500, outputTokens: 500, input: {textTokens: 0, audioTokens: 1500}}), 5250);
  const huge = Number.MAX_SAFE_INTEGER;
  assert.equal(realtimeResponseMicros(config, {...over, totalTokens: huge, inputTokens: huge, outputTokens: 0,
    input: {textTokens: huge, audioTokens: 0}, output: {textTokens: 0, audioTokens: 0},
    cachedInput: {textTokens: 0, audioTokens: 0}}), null);
  assert.equal(realtimeTranscriptionMicros(config, duration(Number.MAX_VALUE)), null);
});
