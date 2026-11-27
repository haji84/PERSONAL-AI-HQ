const namePattern = /^[a-z0-9][a-z0-9_.-]{0,159}$/i;
const maxContextTokens = 2_000_000;
const maxRate = 1_000_000;
const maxSafeMicros = BigInt(Number.MAX_SAFE_INTEGER);
const configFields = ['model', 'voice', 'transcriptionModel', 'contextTokens', 'maxInputSeconds',
  'maxOutputTokens', 'rates', 'transcription'];
const rateFields = ['inputTextUsdPerMillion', 'inputAudioUsdPerMillion', 'cachedTextUsdPerMillion',
  'cachedAudioUsdPerMillion', 'outputTextUsdPerMillion', 'outputAudioUsdPerMillion'];
const transcriptionRates = ['inputTextUsdPerMillion', 'inputAudioUsdPerMillion', 'outputTextUsdPerMillion'];
const durationFields = ['type', 'usdPerMinute', 'billingIncrementSeconds'];
const tokenFields = ['type', 'maxInputTokens', 'maxOutputTokens', ...transcriptionRates];
const totalFields = ['totalTokens', 'inputTokens', 'outputTokens'];
const modalityFields = ['textTokens', 'audioTokens'];
const responseUsageFields = [...totalFields, 'input', 'output', 'cachedInput'];
const transcriptionUsageFields = ['type', ...totalFields, 'input'];

// Public OpenAI model specifications for the WebSocket route. The operator still
// has to verify the actual organization's credit and applicable rate card.
// https://developers.openai.com/api/docs/models/gpt-realtime-1.5
// https://developers.openai.com/api/docs/models/gpt-transcribe
const publishedVoiceRates = {inputTextUsdPerMillion: 4, inputAudioUsdPerMillion: 32,
  cachedTextUsdPerMillion: 0.4, cachedAudioUsdPerMillion: 0.4, outputTextUsdPerMillion: 16, outputAudioUsdPerMillion: 64};

export function hasPublishedRealtimeCeilings(config) {
  return config.model === 'gpt-realtime-1.5' && config.contextTokens >= 32000 &&
    Object.entries(publishedVoiceRates).every(([key, floor]) => config.rates[key] >= floor) &&
    config.transcriptionModel === 'gpt-transcribe' && config.transcription.type === 'duration' &&
    config.transcription.usdPerMinute >= 0.0045 && config.transcription.billingIncrementSeconds === 60;
}

const count = value => Number.isSafeInteger(value) && value >= 0;
const within = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const rate = value => nonnegative(value) && value <= maxRate;
const name = value => typeof value === 'string' && namePattern.test(value);

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.prototype.propertyIsEnumerable.call(value, key));
}

export function normalizeRealtimeCostConfig(input) {
  if (!exact(input, configFields)) return null;
  const {model, voice, transcriptionModel, contextTokens, maxInputSeconds, maxOutputTokens, rates, transcription} = input;
  if (![model, voice, transcriptionModel].every(name) || !within(contextTokens, 512, maxContextTokens) ||
      !within(maxInputSeconds, 1, 60) || !within(maxOutputTokens, 1, Math.min(4096, contextTokens)) ||
      !exact(rates, rateFields) || !rateFields.every(field => rate(rates[field]))) return null;

  if (transcription?.type === 'duration') {
    if (!exact(transcription, durationFields) || !rate(transcription.usdPerMinute) ||
        !Number.isFinite(transcription.billingIncrementSeconds) || transcription.billingIncrementSeconds <= 0 ||
        transcription.billingIncrementSeconds > 60) return null;
  } else if (transcription?.type === 'tokens') {
    if (!exact(transcription, tokenFields) || !within(transcription.maxInputTokens, 1, maxContextTokens) ||
        !within(transcription.maxOutputTokens, 1, maxContextTokens) ||
        !transcriptionRates.every(field => rate(transcription[field]))) return null;
  } else return null;

  return {model, voice, transcriptionModel, contextTokens, maxInputSeconds, maxOutputTokens,
    rates: {...rates}, transcription: {...transcription}};
}

// The persisted price is a decimal number. Preserve its decimal units through
// multiplication and addition so binary floating-point rounding cannot change billing quanta.
function decimal(value) {
  const [mantissa, scientificExponent = '0'] = value.toString().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  const exponent = Number(scientificExponent) - fraction.length;
  return exponent >= 0 ? [digits * 10n ** BigInt(exponent), 1n] : [digits, 10n ** BigInt(-exponent)];
}

const ceiling = (numerator, denominator) => (numerator + denominator - 1n) / denominator;
function micros(numerator, denominator) {
  const amount = ceiling(numerator, denominator);
  return amount <= maxSafeMicros ? Number(amount) : null;
}

function pricedTokens(terms) {
  let numerator = 0n;
  let denominator = 1n;
  for (const [tokens, unitRate] of terms) {
    const [units, divisor] = decimal(unitRate);
    numerator = numerator * divisor + BigInt(tokens) * units * denominator;
    denominator *= divisor;
  }
  return micros(numerator, denominator);
}

function pricedDuration(seconds, transcription) {
  const [elapsed, elapsedDivisor] = decimal(seconds);
  const [increment, incrementDivisor] = decimal(transcription.billingIncrementSeconds);
  const [unitRate, rateDivisor] = decimal(transcription.usdPerMinute);
  const quanta = ceiling(elapsed * incrementDivisor, elapsedDivisor * increment);
  return micros(quanta * increment * unitRate * 1_000_000n, incrementDivisor * rateDivisor * 60n);
}

function validTotals(usage) {
  return totalFields.every(key => count(usage[key])) && usage.totalTokens === usage.inputTokens + usage.outputTokens;
}

function validModalities(usage, total) {
  return exact(usage, modalityFields) && modalityFields.every(key => count(usage[key])) &&
    (total === undefined || usage.textTokens + usage.audioTokens === total);
}

export function maximumRealtimeCostMicros(input) {
  const config = normalizeRealtimeCostConfig(input);
  if (!config) return null;
  const {contextTokens, maxOutputTokens, rates, transcription} = config;
  const response = pricedTokens([
    [contextTokens, Math.max(rates.inputTextUsdPerMillion, rates.inputAudioUsdPerMillion,
      rates.cachedTextUsdPerMillion, rates.cachedAudioUsdPerMillion)],
    [maxOutputTokens, Math.max(rates.outputTextUsdPerMillion, rates.outputAudioUsdPerMillion)],
  ]);
  const speech = transcription.type === 'duration' ? pricedDuration(config.maxInputSeconds, transcription) : pricedTokens([
    [transcription.maxInputTokens, Math.max(transcription.inputTextUsdPerMillion, transcription.inputAudioUsdPerMillion)],
    [transcription.maxOutputTokens, transcription.outputTextUsdPerMillion],
  ]);
  return response !== null && speech !== null && count(response + speech) ? response + speech : null;
}

export function realtimeResponseMicros(input, usage) {
  const config = normalizeRealtimeCostConfig(input);
  if (!config || !exact(usage, responseUsageFields) || !validTotals(usage) ||
      !validModalities(usage.input, usage.inputTokens) || !validModalities(usage.output, usage.outputTokens) ||
      !validModalities(usage.cachedInput) || usage.cachedInput.textTokens > usage.input.textTokens ||
      usage.cachedInput.audioTokens > usage.input.audioTokens) return null;
  const {input: observed, output, cachedInput: cache} = usage;
  const {rates} = config;
  return pricedTokens([
    [observed.textTokens - cache.textTokens, rates.inputTextUsdPerMillion],
    [observed.audioTokens - cache.audioTokens, rates.inputAudioUsdPerMillion],
    [cache.textTokens, rates.cachedTextUsdPerMillion],
    [cache.audioTokens, rates.cachedAudioUsdPerMillion],
    [output.textTokens, rates.outputTextUsdPerMillion],
    [output.audioTokens, rates.outputAudioUsdPerMillion],
  ]);
}

export function realtimeTranscriptionMicros(input, usage) {
  const config = normalizeRealtimeCostConfig(input);
  const transcription = config?.transcription;
  if (!transcription || usage?.type !== transcription.type) return null;
  if (transcription.type === 'duration') {
    return exact(usage, ['type', 'seconds']) && nonnegative(usage.seconds) ? pricedDuration(usage.seconds, transcription) : null;
  }
  if (!exact(usage, transcriptionUsageFields) || !validTotals(usage) || !validModalities(usage.input, usage.inputTokens)) return null;
  return pricedTokens([
    [usage.input.textTokens, transcription.inputTextUsdPerMillion],
    [usage.input.audioTokens, transcription.inputAudioUsdPerMillion],
    [usage.outputTokens, transcription.outputTextUsdPerMillion],
  ]);
}
