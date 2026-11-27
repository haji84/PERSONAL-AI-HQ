import assert from 'node:assert/strict';
import test from 'node:test';
import {createChatGPTResponses} from '../app/chatgpt-responses.mjs';

const messages = [{role: 'user', content: '質問'}];
const model = 'fixture-model';
const encode = new TextEncoder();
const auth = {accessToken: async () => 'fixture-token'};
const event = (type, fields = {}) => `data: ${JSON.stringify({type, ...fields})}\n\n`;
function sse(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const bytes of chunks) controller.enqueue(bytes);
      controller.close();
    },
  }), {headers: {'Content-Type': 'text/event-stream; charset=utf-8'}});
}
async function collect(client, signal) {
  const pieces = [];
  for await (const piece of client.stream({model, messages, signal})) pieces.push(piece);
  return pieces;
}

test('lists visible models in API order and keeps credentials internal', async () => {
  const client = createChatGPTResponses({auth, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    return Response.json({models: [
      {visibility: 'list', slug: 'z', display_name: '先頭', private_data: 'ignored'},
      {visibility: 'hide', slug: 'hidden', display_name: 'Hidden'},
      {visibility: 'list', slug: 'a', display_name: '次'},
    ]});
  }});
  assert.deepEqual(await client.models(), [{slug: 'z', displayName: '先頭'}, {slug: 'a', displayName: '次'}]);
});

test('posts only the text input, never follows redirects, and decodes split UTF-8 and SSE delimiters', async () => {
  const controller = new AbortController();
  const wire = ': heartbeat\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"日本"}\r\n\r\n' +
    'data: {"type":"response.output_text.delta","delta":"語"}\r\r' +
    event('response.completed', {response: {status: 'completed'}});
  const client = createChatGPTResponses({auth, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.signal, controller.signal);
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    assert.deepEqual(JSON.parse(init.body), {model, input: messages, store: false, stream: true});
    return sse([...encode.encode(wire)].map(byte => Uint8Array.of(byte)));
  }});
  assert.deepEqual(await collect(client, controller.signal), ['日本', '語']);
});

test('sends the prompt and the exact attached text as two parts of the same user message', async () => {
  const input = [{role: 'assistant', content: '前の返答'}, {role: 'user', content: [
    {type: 'input_text', text: 'この資料を読んで'}, {type: 'input_text', text: '添付資料（日本語.csv）\n\uFEFFa,b\r\n1,2\r\n'},
  ]}];
  let requests = 0;
  const client = createChatGPTResponses({auth, fetchImpl: async (_url, init) => {
    requests++;
    assert.deepEqual(JSON.parse(init.body), {model, input, store: false, stream: true});
    return sse([encode.encode(event('response.completed', {response: {status: 'completed'}}))]);
  }});
  assert.equal((await client.stream({model, messages: input}).next()).done, true);
  assert.equal(requests, 1);
});

test('requires a complete official terminal event and preserves prior partial chunks', async () => {
  for (const [terminal, code] of [
    ['', 'CHATGPT_PLAN_INTERRUPTED'],
    ['data: [DONE]\n\n', 'CHATGPT_PLAN_INTERRUPTED'],
    ['data: {"type":"response.completed"}', 'CHATGPT_PLAN_INTERRUPTED'],
    [event('response.incomplete', {response: {detail: 'private'}}), 'CHATGPT_PLAN_INCOMPLETE'],
    [event('response.failed', {response: {error: {code: 'subscription_sharing_usage_limit_exceeded', message: 'private'}}}), 'CHATGPT_PLAN_USAGE_LIMIT'],
    [event('error', {message: 'private'}), 'CHATGPT_PLAN_FAILED'],
  ]) {
    const client = createChatGPTResponses({auth, fetchImpl: async () => sse([encode.encode(
      event('response.output_text.delta', {delta: 'partial'}) + terminal)])});
    const iterator = client.stream({model, messages});
    assert.deepEqual(await iterator.next(), {done: false, value: 'partial'});
    await assert.rejects(iterator.next(), error => error.code === code && !error.message.includes('private'));
  }
});

test('keeps abort distinct from network interruptions and never retries', async () => {
  const controller = new AbortController();
  let requests = 0;
  const client = createChatGPTResponses({auth, fetchImpl: async () => {
    requests++;
    return sse([encode.encode(event('response.output_text.delta', {delta: 'partial'}))]);
  }});
  const iterator = client.stream({model, messages, signal: controller.signal});
  assert.equal((await iterator.next()).value, 'partial');
  controller.abort('private abort reason');
  await assert.rejects(iterator.next(), {code: 'CHATGPT_PLAN_ABORTED'});
  await assert.rejects(collect(client, controller.signal), {code: 'CHATGPT_PLAN_ABORTED'});
  assert.equal(requests, 1);
});

test('rejects unbounded text and non-text prompts without contacting the endpoint', async () => {
  const client = createChatGPTResponses({auth, fetchImpl: async () => assert.fail('network dependency called')});
  for (const input of [[{role: 'system', content: 'system'}], [{role: 'user', content: [{type: 'input_image'}]}],
    [{role: 'assistant', content: [{type: 'input_text', text: 'text'}, {type: 'input_text', text: 'document'}]}],
    [{role: 'user', content: [{type: 'input_text', text: 'x'.repeat(47000)}, {type: 'input_text', text: 'x'.repeat(2000)}]}],
    [{role: 'user', content: 'x'.repeat(100000)}]]) {
    await assert.rejects(async () => client.stream({model, messages: input}).next(), {code: 'CHATGPT_PLAN_INVALID_REQUEST'});
  }
});

test('maps direct admission and unexpected response media to fixed errors without fallback', async () => {
  for (const [response, code] of [
    [Response.json({detail: 'secret'}, {status: 401}), 'CHATGPT_PLAN_AUTH_REQUIRED'],
    [Response.json({detail: 'secret'}, {status: 403}), 'CHATGPT_PLAN_UNAVAILABLE'],
    [Response.json({detail: 'secret'}, {status: 429}), 'CHATGPT_PLAN_USAGE_LIMIT'],
    [Response.json({result: 'secret'}), 'CHATGPT_PLAN_FAILED'],
  ]) {
    let requests = 0;
    const client = createChatGPTResponses({auth, fetchImpl: async () => { requests++; return response; }});
    await assert.rejects(collect(client), error => error.code === code && !error.message.includes('secret'));
    assert.equal(requests, 1);
  }
});

test('distinguishes missing plan permission and never submits unapproved fallback credentials', async () => {
  const client = createChatGPTResponses({
    auth: {accessToken: async () => { throw Object.assign(new Error('secret'), {code: 'PLAN_SCOPE_REQUIRED'}); }},
    fetchImpl: async () => assert.fail('network dependency called'),
  });
  await assert.rejects(client.models(), error => error.code === 'CHATGPT_PLAN_AUTH_REQUIRED' && !error.message.includes('secret'));
});

test('does not emit output beyond the durable text limit', async () => {
  const client = createChatGPTResponses({auth, fetchImpl: async () => sse([encode.encode(
    event('response.output_text.delta', {delta: 'partial'}) +
    event('response.output_text.delta', {delta: 'x'.repeat(120000)}) +
    event('response.completed'))])});
  const iterator = client.stream({model, messages});
  assert.equal((await iterator.next()).value, 'partial');
  await assert.rejects(iterator.next(), {code: 'CHATGPT_PLAN_INCOMPLETE'});
});
