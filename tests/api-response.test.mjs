import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiResponseClient, maximumApiJobUsd} from '../app/api-response.mjs';

const model = {id: 'fixture-model-2026-11-27', contextTokens: 20000, outputTokens: 2000,
  inputUsdPerMillion: 2, outputUsdPerMillion: 8};
const context = {baseSha: 'fixture-revision', files: [{path: 'src/demo.mjs', text: 'export const n = 1;', writable: true}]};
const fixture = json => new Response(JSON.stringify(json), {headers: {'content-type': 'application/json'}});
const proposal = {summary: '定数を修正', changes: [{path: 'src/demo.mjs', text: 'export const n = 2;'}]};
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
  }
});

test('uncertain transport or unexpected billed model leaves settlement unknown and never retries', async () => {
  let calls = 0;
  for (const send of [() => { throw Error('fixture transport loss'); }, () => fixture(completed([], {model: 'unapproved'})),
    () => new Response('quota', {status: 429})]) {
    const client = testClient(async () => { calls++; return send(); });
    await assert.rejects(client.propose({model, prompt: '変更', context}), {code: 'API_SETTLEMENT_UNKNOWN'});
  }
  assert.equal(calls, 3);
});
