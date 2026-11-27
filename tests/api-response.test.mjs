import test from 'node:test';
import assert from 'node:assert/strict';
import {apiAdviceMaxLength, createApiResponseClient, maximumApiJobUsd} from '../app/api-response.mjs';

const model = {id: 'fixture-model-2026-11-27', contextTokens: 20000, outputTokens: 2000,
  inputUsdPerMillion: 2, outputUsdPerMillion: 8};
const context = {baseSha: 'fixture-revision', files: [{path: 'src/demo.mjs', text: 'export const n = 1;', writable: true}]};
const fixture = json => new Response(JSON.stringify(json), {headers: {'content-type': 'application/json'}});
const proposal = {summary: '定数を修正', changes: [{path: 'src/demo.mjs', text: 'export const n = 2;'}]};
const receipt = {id: 'resp_fixture', inputTokens: 100, outputTokens: 25};
const completed = (content, overrides = {}) => ({id: 'resp_fixture', model: model.id, service_tier: 'default', status: 'completed',
  usage: {input_tokens: 100, output_tokens: 25}, output: [{type: 'message', role: 'assistant', content}], ...overrides});
const testClient = fetchImpl => createApiResponseClient({key: 'fixture-only', organization: 'org-fixture', project: 'proj_fixture', fetchImpl});

test('ordinary Responses requests have an exact receiver, bounded output and no hosted tools', async () => {
  let calls = 0;
  let checked = false;
  const client = testClient(async (url, request) => {
    calls++;
    assert.equal(checked, true);
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer fixture-only');
    assert.equal(request.headers['OpenAI-Organization'], 'org-fixture');
    assert.equal(request.headers['OpenAI-Project'], 'proj_fixture');
    const body = JSON.parse(request.body);
    assert.equal(body.model, model.id);
    assert.equal(body.store, false);
    assert.equal(body.service_tier, 'default');
    assert.equal(body.max_output_tokens, 2000);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.reasoning.effort, 'low');
    assert.equal(body.tools, undefined);
    assert.match(JSON.stringify(body.input), /fixture-revision/);
    return fixture(completed([{type: 'output_text', text: JSON.stringify(proposal)}]));
  });
  const result = await client.propose({model, effort: 'low', prompt: '小さい変更', context, beforeSend() { checked = true; }});
  assert.equal(calls, 1);
  assert.deepEqual(result.proposal, proposal);
  assert.deepEqual(result.receipt, receipt);
  assert.equal(result.accountedUsd, 0.0004);
  assert.equal(maximumApiJobUsd(model), 0.112);
});

test('rejecting the final dispatch gate sends no API request', async () => {
  let calls = 0;
  const client = testClient(async () => { calls++; });
  const gate = new Error('HELD');
  await assert.rejects(client.propose({model, prompt: '変更', context, beforeSend: () => { throw gate; }}), gate);
  assert.equal(calls, 0);
});

test('malformed or refused model output preserves conservative usage without offering an edit', async () => {
  for (const content of [[{type: 'output_text', text: 'malformed'}], [{type: 'refusal', refusal: 'fixture'}]]) {
    const result = await testClient(async () => fixture(completed(content))).propose({model, prompt: '変更', context});
    assert.equal(result.proposal, null);
    assert.equal(result.accountedUsd, 0.0004);
    assert.equal(result.code, 'API_OUTPUT_UNUSABLE');
    assert.deepEqual(result.receipt, receipt);
  }
});

test('uncertain transport or unexpected billed model leaves settlement unknown and never retries', async () => {
  let calls = 0;
  for (const send of [() => { throw Error('fixture transport loss'); }, () => fixture(completed([], {model: 'unapproved'})),
    () => new Response('quota', {status: 429})]) {
    const client = testClient(async () => { calls++; return send(); });
    await assert.rejects(client.propose({model, prompt: '変更', context}), error =>
      error.code === 'API_SETTLEMENT_UNKNOWN' && !Object.hasOwn(error, 'receipt'));
  }
  assert.equal(calls, 3);
});

test('advice uses a single private Responses request with a text-only schema', async () => {
  const answer = '比較結果\n作業範囲を先に確認する。\n';
  const prompt = '設計案を整理してください';
  const signal = new AbortController().signal;
  let calls = 0;
  let checked = false;
  const client = testClient(async (url, request) => {
    calls++;
    assert.equal(checked, true);
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(request.redirect, 'error');
    assert.equal(request.signal, signal);
    assert.equal(request.headers['OpenAI-Organization'], 'org-fixture');
    assert.equal(request.headers['OpenAI-Project'], 'proj_fixture');
    const body = JSON.parse(request.body);
    assert.equal(body.store, false);
    assert.equal(body.service_tier, 'default');
    assert.equal(body.max_output_tokens, model.outputTokens);
    assert.equal(body.reasoning.effort, 'low');
    assert.equal(Object.hasOwn(body, 'tools'), false);
    assert.deepEqual(body.text.format, {type: 'json_schema', name: 'project_advice', strict: true,
      schema: {type: 'object', additionalProperties: false, required: ['answer'], properties: {answer: {type: 'string'}}}});
    assert.deepEqual(JSON.parse(body.input[1].content), {work: prompt, context});
    return fixture(completed([{type: 'output_text', text: JSON.stringify({answer})}]));
  });
  assert.equal(typeof client.advise, 'function');
  assert.equal(apiAdviceMaxLength, 12000);
  assert.deepEqual(await client.advise({model, effort: 'low', prompt, context, signal, beforeSend() { checked = true; }}),
    {answer, accountedUsd: 0.0004, code: null, receipt});
  assert.equal(calls, 1);
});

test('advice rejects replacements and malformed or over-limit answers while accounting for usage', async () => {
  const advise = content => testClient(async () => fixture(completed(content))).advise({model, prompt: '相談', context});
  for (const value of [proposal, {answer: '相談結果', changes: []}, {answer: ' \n'}, {answer: 'a'.repeat(12001)}, ['相談結果']]) {
    assert.deepEqual(await advise([{type: 'output_text', text: JSON.stringify(value)}]),
      {answer: null, accountedUsd: 0.0004, code: 'API_OUTPUT_UNUSABLE', receipt});
  }
  assert.deepEqual(await advise([{type: 'refusal', refusal: 'fixture'}]),
    {answer: null, accountedUsd: 0.0004, code: 'API_OUTPUT_UNUSABLE', receipt});
  assert.equal((await advise([{type: 'output_text', text: JSON.stringify({answer: 'a'.repeat(12000)})}])).answer.length, 12000);
});

test('advice preserves dispatch denial, billing mismatch and token guards', async () => {
  let calls = 0;
  const client = testClient(async () => { calls++; });
  const gate = new Error('HELD');
  await assert.rejects(client.advise({model, prompt: '相談', context, beforeSend: () => { throw gate; }}), gate);
  assert.equal(calls, 0);
  const content = [{type: 'output_text', text: JSON.stringify({answer: '相談結果'})}];
  const advise = overrides => testClient(async () => fixture(completed(content, overrides))).advise({model, prompt: '相談', context});
  await assert.rejects(advise({service_tier: 'priority'}), {code: 'API_SETTLEMENT_UNKNOWN'});
  assert.deepEqual(await advise({usage: {input_tokens: 100, output_tokens: 2001}}),
    {answer: null, accountedUsd: 0.016208, code: 'API_OUTPUT_UNUSABLE', receipt: {...receipt, outputTokens: 2001}});
});

test('known terminal receipts retain exact actual counts and only a recognized response ID', async () => {
  const resultFor = (id, status) => testClient(async () => fixture(completed([], {id, status, output: [],
    usage: {input_tokens: 8, output_tokens: 0, total_tokens: 99, input_tokens_details: {cached_tokens: 6}},
    metadata: {undeclared: 'private-response-metadata'},
  }))).advise({model, prompt: '相談', context});
  const exact = 'resp_A0z' + 'B'.repeat(120);
  for (const status of ['failed', 'incomplete']) {
    assert.deepEqual(await resultFor(exact, status), {answer: null, accountedUsd: 0.000016,
      code: 'API_OUTPUT_UNUSABLE', receipt: {id: exact, inputTokens: 8, outputTokens: 0}});
  }
  for (const id of [undefined, null, 123, {}, 'message_1', 'resp_', 'Resp_fixture', 'resp_A/B', 'resp_a b',
    'resp_fixture\n', ' resp_fixture', 'resp_あ', exact + 'Z']) {
    assert.deepEqual((await resultFor(id, 'failed')).receipt, {id: null, inputTokens: 8, outputTokens: 0});
  }
});

test('unexpected action output leaves the price and advice unconfirmed', async () => {
  const answer = '相談結果';
  const message = {type: 'message', role: 'assistant', content: [{type: 'output_text', text: JSON.stringify({answer})}]};
  let calls = 0;
  const advise = output => testClient(async () => {
    calls++;
    return fixture(completed([], {output}));
  }).advise({model, prompt: '相談', context});
  await assert.rejects(advise([{type: 'web_search_call', status: 'completed'}, message]), {code: 'API_SETTLEMENT_UNKNOWN'});
  assert.deepEqual(await advise([{type: 'reasoning', summary: []}, message]), {answer, accountedUsd: 0.0004, code: null, receipt});
  assert.equal(calls, 2);
});

test('maximum job cost bounds single and double response reservations', () => {
  assert.equal(maximumApiJobUsd(model, 1), 0.056);
  assert.equal(maximumApiJobUsd(model, 2), 0.112);
  assert.equal(maximumApiJobUsd(model), 0.112);
  for (const rounds of [0, 3, 1.5, '1', Infinity]) {
    assert.throws(() => maximumApiJobUsd(model, rounds), {code: 'API_ROUNDS_INVALID'});
  }
});
