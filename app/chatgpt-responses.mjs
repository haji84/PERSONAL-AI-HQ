const base = 'https://api.openai.com/v1';
const eventLimit = 1024 * 1024;
export const chatInputLimit = 48000;
export const chatOutputLimit = 120000;
export const chatMessageLimit = 17;
export const chatModelPattern = /^[a-z0-9][a-z0-9_.:-]{0,159}$/i;

const errors = {
  CHATGPT_PLAN_AUTH_REQUIRED: 'ChatGPT plan authorization is required.',
  CHATGPT_PLAN_UNAVAILABLE: 'ChatGPT plan usage is unavailable.',
  CHATGPT_PLAN_USAGE_LIMIT: 'The ChatGPT plan usage limit was reached.',
  CHATGPT_PLAN_INVALID_REQUEST: 'The ChatGPT text request is invalid.',
  CHATGPT_PLAN_ABORTED: 'The ChatGPT response was cancelled.',
  CHATGPT_PLAN_INCOMPLETE: 'ChatGPT returned an incomplete response.',
  CHATGPT_PLAN_INTERRUPTED: 'The ChatGPT stream ended before completion.',
  CHATGPT_PLAN_FAILED: 'The ChatGPT request failed.',
};

class ChatGPTPlanError extends Error {
  constructor(code) {
    super(errors[code]);
    this.code = code;
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new ChatGPTPlanError('CHATGPT_PLAN_ABORTED');
}

function providerError(code, status) {
  if (status === 429 || code === 'subscription_sharing_usage_limit_exceeded') {
    return new ChatGPTPlanError('CHATGPT_PLAN_USAGE_LIMIT');
  }
  if (status === 401 || ['subscription_sharing_invalid_user', 'chatpass_v2_scope_not_authorized',
    'chatpass_v2_invalid_authorization_context'].includes(code)) {
    return new ChatGPTPlanError('CHATGPT_PLAN_AUTH_REQUIRED');
  }
  if (status === 403 || status === 503 || ['subscription_sharing_user_not_eligible',
    'subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable',
    'subscription_sharing_route_not_supported'].includes(code)) {
    return new ChatGPTPlanError('CHATGPT_PLAN_UNAVAILABLE');
  }
  if (code === 'subscription_sharing_unsupported_capability') {
    return new ChatGPTPlanError('CHATGPT_PLAN_INVALID_REQUEST');
  }
  return new ChatGPTPlanError('CHATGPT_PLAN_FAILED');
}

async function* eventData(body, signal) {
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let pending = '';
  let skipLF = false;
  let data = [];
  let size = 0;
  for await (const chunk of body) {
    checkAbort(signal);
    const decoded = decoder.decode(chunk, {stream: true});
    if (!decoded) continue;
    const value = skipLF && decoded.startsWith('\n') ? decoded.slice(1) : decoded;
    skipLF = false;
    let start = 0;
    for (const ending of value.matchAll(/\r\n?|\n/g)) {
      const line = pending + value.slice(start, ending.index);
      if (line.length > eventLimit) throw new ChatGPTPlanError('CHATGPT_PLAN_FAILED');
      pending = '';
      start = ending.index + ending[0].length;
      skipLF = ending[0] === '\r' && start === value.length;
      if (!line) {
        if (data.length) {
          yield data.join('\n');
          data = [];
          size = 0;
        }
      } else if (line.startsWith('data:') || line === 'data') {
        const payload = line.slice(5).replace(/^ /, '');
        size += payload.length + 1;
        if (size > eventLimit) throw new ChatGPTPlanError('CHATGPT_PLAN_FAILED');
        data.push(payload);
      }
    }
    pending += value.slice(start);
    if (pending.length > eventLimit) throw new ChatGPTPlanError('CHATGPT_PLAN_FAILED');
  }
  decoder.decode();
}

export function createChatGPTResponses({auth, fetchImpl = globalThis.fetch}) {
  async function request(path, {signal, body, beforeSend}) {
    checkAbort(signal);
    let token;
    try {
      token = await auth.accessToken();
    } catch (error) {
      checkAbort(signal);
      const needsAuth = ['AUTHORIZATION_REQUIRED', 'PLAN_SCOPE_REQUIRED'].includes(error?.code);
      throw new ChatGPTPlanError(needsAuth ? 'CHATGPT_PLAN_AUTH_REQUIRED' : 'CHATGPT_PLAN_UNAVAILABLE');
    }
    checkAbort(signal);
    if (typeof token !== 'string' || !token.trim()) throw new ChatGPTPlanError('CHATGPT_PLAN_AUTH_REQUIRED');
    beforeSend?.();
    let response;
    try {
      response = await fetchImpl(base + path, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? {'Content-Type': 'application/json', Accept: 'text/event-stream'} : {Accept: 'application/json'}),
        },
        ...(body ? {body: JSON.stringify(body)} : {}),
        signal,
      });
    } catch {
      checkAbort(signal);
      throw new ChatGPTPlanError('CHATGPT_PLAN_UNAVAILABLE');
    }
    if (response.ok) return response;
    const payload = await response.json().catch(() => null);
    checkAbort(signal);
    throw providerError(payload?.error?.code, response.status);
  }

  return {
    async models({signal} = {}) {
      const response = await request('/models', {signal});
      const payload = await response.json().catch(() => null);
      checkAbort(signal);
      if (!Array.isArray(payload?.models)) throw new ChatGPTPlanError('CHATGPT_PLAN_FAILED');
      return payload.models
        .filter(model => model?.visibility === 'list' && typeof model.slug === 'string' &&
          chatModelPattern.test(model.slug) && typeof model.display_name === 'string' &&
          model.display_name.trim() && model.display_name.length <= 240)
        .map(model => ({slug: model.slug, displayName: model.display_name}));
    },

    async *stream({model, messages, signal, beforeSend}) {
      if (typeof model !== 'string' || !chatModelPattern.test(model) || !Array.isArray(messages) ||
          !messages.length || messages.length > chatMessageLimit) {
        throw new ChatGPTPlanError('CHATGPT_PLAN_INVALID_REQUEST');
      }
      let inputLength = 0;
      const input = messages.map(message => {
        const {role, content} = message ?? {};
        if (role !== 'user' && role !== 'assistant') throw new ChatGPTPlanError('CHATGPT_PLAN_INVALID_REQUEST');
        let parts;
        if (typeof content === 'string' && content.trim()) parts = [content];
        else if (role === 'user' && Array.isArray(content) && content.length === 2 &&
            content.every(part => part?.type === 'input_text' && typeof part.text === 'string' && part.text.trim())) {
          parts = content.map(part => part.text);
        } else {
          throw new ChatGPTPlanError('CHATGPT_PLAN_INVALID_REQUEST');
        }
        inputLength += parts.reduce((length, part) => length + part.length, 0);
        if (inputLength > chatInputLimit) throw new ChatGPTPlanError('CHATGPT_PLAN_INVALID_REQUEST');
        return {role, content: typeof content === 'string' ? content : parts.map(text => ({type: 'input_text', text}))};
      });

      const response = await request('/responses', {signal, beforeSend, body: {model, input, store: false, stream: true}});
      if (!response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
        await response.body?.cancel().catch(() => {});
        checkAbort(signal);
        throw new ChatGPTPlanError('CHATGPT_PLAN_FAILED');
      }
      let outputLength = 0;
      try {
        for await (const data of eventData(response.body, signal)) {
          checkAbort(signal);
          if (data === '[DONE]') break;
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            throw new ChatGPTPlanError('CHATGPT_PLAN_FAILED');
          }
          if (!event || typeof event.type !== 'string') throw new ChatGPTPlanError('CHATGPT_PLAN_FAILED');

          switch (event.type) {
            case 'response.completed':
              if (event.response?.status && event.response.status !== 'completed') {
                throw new ChatGPTPlanError('CHATGPT_PLAN_FAILED');
              }
              return;
            case 'response.incomplete':
              throw new ChatGPTPlanError('CHATGPT_PLAN_INCOMPLETE');
            case 'response.failed':
            case 'error':
              throw providerError(event.response?.error?.code ?? event.error?.code ?? event.code);
            case 'response.output_text.delta':
            case 'response.refusal.delta':
              if (typeof event.delta !== 'string') throw new ChatGPTPlanError('CHATGPT_PLAN_FAILED');
              outputLength += event.delta.length;
              if (outputLength > chatOutputLimit) throw new ChatGPTPlanError('CHATGPT_PLAN_INCOMPLETE');
              if (event.delta) yield event.delta;
              break;
          }
        }
      } catch (error) {
        checkAbort(signal);
        if (error instanceof ChatGPTPlanError) throw error;
        throw new ChatGPTPlanError('CHATGPT_PLAN_INTERRUPTED');
      }
      checkAbort(signal);
      throw new ChatGPTPlanError('CHATGPT_PLAN_INTERRUPTED');
    },
  };
}
