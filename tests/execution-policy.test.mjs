import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, resolveExecution, verifyHandover } from '../app/execution-policy.mjs';

const now = Date.parse('2026-11-27T07:00:00Z');
const capabilities = {
  subscription: { available: true, authMode: 'chatgpt', defaultModel: 'high-model', defaultReasoningEffort: 'high', models: [{ id: 'high-model', reasoningEfforts: ['medium', 'high'] }] },
  api: { available: true, defaultModel: 'high-model', defaultReasoningEffort: 'high', models: [{ id: 'high-model', reasoningEfforts: ['medium', 'high'] }] },
};
const safety = {
  authorized: true, status: 'ready', allowedRoutes: ['api', 'subscription'],
  api: { organizationId: 'grant-org', creditOrganizationId: 'grant-org', availableCreditUsd: 1, observedAt: '2026-11-27T06:59:30Z', expiresAt: '2026-11-28T00:00:00Z', zeroAdditionalCostGuaranteed: true, maxRequestCostUsd: 0.1 },
};
function decide(settings, options = {}) { return resolveExecution({ settings, capabilities, safety, now, ...options }); }

test('exclusive modes stop at unavailable routes instead of silently changing account', () => {
  assert.equal(decide({ mode: 'api-only', apiBudgetUsd: 1 }, { capabilities: { ...capabilities, api: { available: false } } }).allowed, false);
  assert.equal(decide({ mode: 'subscription-only' }, { capabilities: { ...capabilities, subscription: { available: false } } }).allowed, false);
  assert.equal(decide({ mode: 'api-only', apiBudgetUsd: 1 }).route, 'api');
  assert.equal(decide({ mode: 'subscription-only' }).route, 'subscription');
});

test('explicit task route cannot escape a project exclusive mode', () => {
  const decision = decide({ mode: 'subscription-only' }, { task: { route: 'api' } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'ROUTE_NOT_ALLOWED');
});

test('auto fallback requires a separately saved permission', () => {
  const options = { capabilities: { ...capabilities, api: { available: false } } };
  const settings = { mode: 'auto', preference: 'api-first', apiBudgetUsd: 1 };
  assert.equal(decide(settings, options).allowed, false);
  assert.equal(decide({ ...settings, allowFallback: true }, options).route, 'subscription');
  assert.equal(decide({ ...settings, allowFallback: true }, { ...options, task: { route: 'api' } }).allowed, false);
});

test('manual model and effort are preserved and unavailable choices stop', () => {
  const settings = { mode: 'subscription-only', model: 'high-model', reasoningEffort: 'high' };
  assert.equal(decide(settings).model, 'high-model');
  assert.equal(decide(settings).reasoningEffort, 'high');
  assert.equal(decide({ ...settings, model: 'missing-model' }).code, 'MODEL_UNAVAILABLE');
  assert.equal(decide({ ...settings, reasoningEffort: 'ultra' }).code, 'REASONING_UNAVAILABLE');
  assert.equal(decide(settings, { task: { reasoningEffort: 'medium' } }).reasoningEffort, 'medium');
});

test('hybrid chooses only the requested stage and requires an actual assignment', () => {
  const settings = { mode: 'hybrid', apiBudgetUsd: 1, stageRoutes: { design: 'api', implementation: 'subscription' } };
  assert.equal(decide(settings, { task: { stage: 'design' } }).route, 'api');
  assert.equal(decide(settings, { task: { stage: 'implementation' } }).route, 'subscription');
  assert.equal(decide(settings, { task: { stage: 'review' } }).code, 'STAGE_ROUTE_REQUIRED');
});

test('subscription requires actual ChatGPT account authentication', () => {
  assert.equal(decide({ mode: 'subscription-only' }, { capabilities: { ...capabilities, subscription: { ...capabilities.subscription, authMode: 'apiKey' } } }).code, 'SUBSCRIPTION_AUTH_REQUIRED');
});

test('holds override user route and model selections', () => {
  for (const status of ['paused', 'cancelled', 'awaiting_approval', 'resource_limited', 'blocked', 'unknown']) {
    assert.equal(decide({ mode: 'subscription-only' }, { safety: { ...safety, status } }).allowed, false, status);
  }
  assert.equal(decide({ mode: 'subscription-only' }, { safety: { ...safety, unresolvedEffects: true } }).code, 'UNRESOLVED_EFFECTS');
  assert.equal(decide({ mode: 'subscription-only' }, { safety: { ...safety, authorized: false } }).code, 'NOT_AUTHORIZED');
});

test('API refuses stale, expired, wrong-organization or unknown financial evidence', () => {
  const cases = [
    [{ observedAt: '2026-11-27T06:00:00Z' }, 'CREDIT_INFORMATION_STALE'],
    [{ observedAt: '2026-11-27T07:01:00Z' }, 'CREDIT_INFORMATION_STALE'],
    [{ expiresAt: '2026-11-27T06:59:59Z' }, 'CREDITS_EXPIRED'],
    [{ availableCreditUsd: null }, 'CREDIT_BALANCE_UNKNOWN'],
    [{ creditOrganizationId: 'different-org' }, 'CREDIT_ORGANIZATION_MISMATCH'],
    [{ zeroAdditionalCostGuaranteed: false }, 'API_COST_GUARANTEE_REQUIRED'],
    [{ maxRequestCostUsd: null }, 'REQUEST_COST_UNKNOWN'],
  ];
  for (const [patch, code] of cases) {
    assert.equal(decide({ mode: 'api-only', apiBudgetUsd: 1 }, { safety: { ...safety, api: { ...safety.api, ...patch } } }).code, code);
  }
});

test('API needs both project and shared balance after outstanding reservations', () => {
  assert.equal(decide({ mode: 'api-only' }).code, 'PROJECT_BUDGET_REQUIRED');
  assert.equal(decide({ mode: 'api-only', apiBudgetUsd: 0.09 }).code, 'PROJECT_BUDGET_EXCEEDED');
  assert.equal(decide({ mode: 'api-only', apiBudgetUsd: 1 }, { safety: { ...safety, api: { ...safety.api, availableCreditUsd: 0.09 } } }).code, 'SHARED_CREDIT_INSUFFICIENT');
});

test('balanced auto selection needs measured ranking instead of inventing quality', () => {
  const settings = { mode: 'auto', preference: 'balanced', allowFallback: true, apiBudgetUsd: 1 };
  assert.equal(decide(settings).code, 'OPTIMIZATION_INFORMATION_REQUIRED');
  assert.equal(decide(settings, { capabilities: { ...capabilities, routeRanking: { basis: 'measured', routes: ['subscription', 'api'] } } }).route, 'subscription');
});

test('malformed configuration is rejected rather than widening permissions', () => {
  for (const settings of [
    { mode: 'mistyped-mode' },
    { mode: 'api-only', allowedRoutes: ['api', 'subscription'] },
    { mode: 'auto', allowedRoutes: [] },
    { mode: 'auto', allowFallback: 'true' },
    { mode: 'api-only', apiBudgetUsd: -1 },
    { mode: 'auto', apiBudgetUSD: 5 },
    { mode: 'hybrid', stageRoutes: { design: 'unknown' } },
  ]) assert.throws(() => normalizeSettings(settings));
});

test('handover compares real readback fields and rejects stale checkpoints', () => {
  const hash = 'a'.repeat(64);
  const checkpoint = { id: 'checkpoint-1', version: 3, goalId: 'goal-1', requirementsHash: hash, conversationHash: hash, stopHash: hash, budgetHash: hash, artifactsHash: hash };
  assert.equal(verifyHandover(checkpoint, { ...checkpoint }).ok, true);
  assert.equal(verifyHandover(checkpoint, { ...checkpoint, version: 2 }).ok, false);
  assert.equal(verifyHandover(checkpoint, { ...checkpoint, stopHash: 'b'.repeat(64) }).ok, false);
  assert.equal(verifyHandover(checkpoint, { ...checkpoint, goalId: 'other-goal' }).ok, false);
  assert.equal(verifyHandover({}, {}).ok, false);
});

test('an API budget incident keeps API held while authorized subscription work remains possible', () => {
  const held = { ...safety, api: { ...safety.api, budgetHold: true } };
  assert.equal(decide({ mode: 'api-only', apiBudgetUsd: 1 }, { safety: held }).code, 'BUDGET_RECONCILIATION_REQUIRED');
  assert.equal(decide({ mode: 'subscription-only' }, { safety: held }).route, 'subscription');
});

test('task settings reject unknown fields and malformed handover hashes', () => {
  assert.equal(decide({ mode: 'subscription-only' }, { task: { apiKey: 'test-value' } }).code, 'INVALID_TASK');
  const checkpoint = { id: 'cp', version: 1, goalId: 'goal', requirementsHash: ['a'.repeat(64)], conversationHash: 'a'.repeat(64), stopHash: 'a'.repeat(64), budgetHash: 'a'.repeat(64), artifactsHash: 'a'.repeat(64) };
  assert.equal(verifyHandover(checkpoint, checkpoint).ok, false);
});

test('removing the preferred route from safety cannot silently override fallback denial', () => {
  const options = { safety: { ...safety, allowedRoutes: ['subscription'] } };
  assert.equal(decide({ mode: 'auto', preference: 'api-first', allowFallback: false, apiBudgetUsd: 1 }, options).allowed, false);
  assert.equal(decide({ mode: 'auto', preference: 'api-first', allowFallback: true, apiBudgetUsd: 1 }, options).route, 'subscription');
});

test('a string false is never financial authorization', () => {
  assert.equal(decide({ mode: 'api-only', apiBudgetUsd: 1 }, { safety: { ...safety, api: { ...safety.api, zeroAdditionalCostGuaranteed: 'false' } } }).allowed, false);
});
