// Pure policy only. Trusted server adapters supply capabilities and safety;
// browser input, an AI assertion, or this function alone cannot authorize dispatch.
export const ROUTES = Object.freeze(['api', 'subscription']);
export const MODES = Object.freeze(['api-only', 'subscription-only', 'auto', 'hybrid']);
const STAGES = ['consultation', 'design', 'implementation', 'test', 'verification', 'review', 'delivery'];
const FIELDS = ['mode', 'allowedRoutes', 'preference', 'allowFallback', 'model', 'reasoningEffort', 'apiBudgetUsd', 'stageRoutes'];
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
export const moneyMicros = (value, round = 'floor') => {
  if (!money(value)) throw new TypeError('Invalid USD amount');
  return Math[round](value * 1_000_000);
};

export function normalizeSettings(input = {}) {
  if (!record(input) || Object.keys(input).some(key => !FIELDS.includes(key))) throw new TypeError('Unknown execution setting');
  const mode = input.mode ?? 'subscription-only';
  if (!MODES.includes(mode)) throw new TypeError('Unknown execution mode');
  const exclusive = mode === 'api-only' ? 'api' : mode === 'subscription-only' ? 'subscription' : null;
  const allowedRoutes = input.allowedRoutes ?? (exclusive ? [exclusive] : [...ROUTES]);
  if (!Array.isArray(allowedRoutes) || !allowedRoutes.length || allowedRoutes.some(route => !ROUTES.includes(route)) || new Set(allowedRoutes).size !== allowedRoutes.length) throw new TypeError('Invalid allowed routes');
  if (exclusive && (allowedRoutes.length !== 1 || allowedRoutes[0] !== exclusive)) throw new TypeError('Exclusive mode cannot use another route');
  const preference = input.preference ?? 'subscription-first';
  if (!['api-first', 'subscription-first', 'balanced'].includes(preference)) throw new TypeError('Invalid route preference');
  if (own(input, 'allowFallback') && typeof input.allowFallback !== 'boolean') throw new TypeError('Invalid fallback permission');
  if (input.allowFallback && mode !== 'auto') throw new TypeError('Fallback requires auto mode');
  for (const key of ['model', 'reasoningEffort']) {
    if (input[key] !== undefined && input[key] !== null && (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 160)) throw new TypeError(`Invalid ${key}`);
  }
  if (input.apiBudgetUsd !== undefined && input.apiBudgetUsd !== null && !money(input.apiBudgetUsd)) throw new TypeError('Invalid API budget');
  const stageRoutes = input.stageRoutes ?? {};
  if (!record(stageRoutes) || Object.entries(stageRoutes).some(([stage, route]) => !STAGES.includes(stage) || !allowedRoutes.includes(route))) throw new TypeError('Invalid stage route');
  return {
    mode, allowedRoutes: [...allowedRoutes], preference,
    allowFallback: input.allowFallback ?? false, model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null, apiBudgetUsd: input.apiBudgetUsd ?? null,
    stageRoutes: { ...stageRoutes },
  };
}

const deny = (code, details = {}) => ({ allowed: false, code, ...details });

function apiPermission(settings, safety, now) {
  const api = safety.api ?? {};
  if (api.budgetHold) return 'BUDGET_RECONCILIATION_REQUIRED';
  if (api.zeroAdditionalCostGuaranteed !== true) return 'API_COST_GUARANTEE_REQUIRED';
  if (typeof api.organizationId !== 'string' || !api.organizationId || api.organizationId !== api.creditOrganizationId) return 'CREDIT_ORGANIZATION_MISMATCH';
  const observed = Date.parse(api.observedAt), expires = Date.parse(api.expiresAt);
  if (!Number.isFinite(observed) || observed > now || now - observed > 300_000) return 'CREDIT_INFORMATION_STALE';
  if (!Number.isFinite(expires) || expires <= now) return 'CREDITS_EXPIRED';
  if (!money(api.availableCreditUsd)) return 'CREDIT_BALANCE_UNKNOWN';
  if (!money(api.maxRequestCostUsd) || api.maxRequestCostUsd === 0) return 'REQUEST_COST_UNKNOWN';
  if (!money(settings.apiBudgetUsd)) return 'PROJECT_BUDGET_REQUIRED';
  const spent = safety.projectSpentUsd ?? 0, reserved = safety.projectReservedUsd ?? 0;
  if (!money(spent) || !money(reserved)) return 'PROJECT_BUDGET_UNKNOWN';
  const cost = moneyMicros(api.maxRequestCostUsd, 'ceil');
  if (moneyMicros(spent, 'ceil') + moneyMicros(reserved, 'ceil') + cost > moneyMicros(settings.apiBudgetUsd)) return 'PROJECT_BUDGET_EXCEEDED';
  if (cost > moneyMicros(api.availableCreditUsd)) return 'SHARED_CREDIT_INSUFFICIENT';
  return null;
}

export function resolveExecution({ settings: rawSettings = {}, task = {}, capabilities = {}, safety = {}, now = Date.now() } = {}) {
  const settings = normalizeSettings(rawSettings);
  if (!record(task) || !record(capabilities) || !record(safety) || !Number.isFinite(now)) return deny('INVALID_EXECUTION_CONTEXT');
  if (Object.keys(task).some(key => !['route', 'stage', 'model', 'reasoningEffort'].includes(key)) || Object.entries(task).some(([, value]) => typeof value !== 'string' || !value || value.length > 160)) return deny('INVALID_TASK');
  if (safety.authorized !== true) return deny('NOT_AUTHORIZED');
  if (!['ready', 'active', 'idle'].includes(safety.status)) return deny('EXECUTION_HELD', { status: safety.status ?? 'unknown' });
  if (safety.unresolvedEffects) return deny('UNRESOLVED_EFFECTS');
  if (safety.budgetHold) return deny('BUDGET_RECONCILIATION_REQUIRED');
  if (task.route !== undefined && !settings.allowedRoutes.includes(task.route)) return deny('ROUTE_NOT_ALLOWED');
  if (!Array.isArray(safety.allowedRoutes)) return deny('NO_ROUTE_ALLOWED');
  let candidates;
  if (task.route !== undefined) candidates = [task.route];
  else if (settings.mode === 'hybrid') {
    const route = settings.stageRoutes[task.stage];
    if (!route) return deny('STAGE_ROUTE_REQUIRED');
    candidates = [route];
  } else if (settings.mode === 'api-only') candidates = ['api'];
  else if (settings.mode === 'subscription-only') candidates = ['subscription'];
  else if (settings.preference === 'balanced') {
    const ranking = capabilities.routeRanking;
    if (ranking?.basis !== 'measured' || !Array.isArray(ranking.routes) || ranking.routes.length !== new Set(ranking.routes).size || ranking.routes.some(route => !ROUTES.includes(route)) || !ranking.routes.length) return deny('OPTIMIZATION_INFORMATION_REQUIRED');
    candidates = ranking.routes;
  } else candidates = settings.preference === 'api-first' ? ['api', 'subscription'] : ['subscription', 'api'];
  candidates = candidates.filter(route => settings.allowedRoutes.includes(route));
  if (!candidates.length) return deny('NO_ROUTE_ALLOWED');
  if (!settings.allowFallback || settings.mode !== 'auto' || task.route !== undefined) candidates = candidates.slice(0, 1);
  const attempts = [];
  for (const route of candidates) {
    const capability = capabilities[route];
    let code = null;
    if (!safety.allowedRoutes.includes(route)) code = 'NO_ROUTE_ALLOWED';
    else if (capability?.available !== true) code = 'ROUTE_UNAVAILABLE';
    else if (route === 'subscription' && capability.authMode !== 'chatgpt') code = 'SUBSCRIPTION_AUTH_REQUIRED';
    else if (route === 'api') code = apiPermission(settings, safety, now);
    const model = task.model ?? settings.model ?? capability?.defaultModel;
    const effort = task.reasoningEffort ?? settings.reasoningEffort ?? capability?.defaultReasoningEffort ?? null;
    const modelInfo = capability?.models?.find(entry => entry.id === model);
    if (!code && (!model || !modelInfo)) code = 'MODEL_UNAVAILABLE';
    if (!code && effort !== null && !modelInfo.reasoningEfforts?.includes(effort)) code = 'REASONING_UNAVAILABLE';
    if (!code) return {
      allowed: true, code: 'READY', route, model, reasoningEffort: effort,
      mode: settings.mode, settings, maxCostUsd: route === 'api' ? safety.api.maxRequestCostUsd : 0,
      fallback: attempts.length > 0, attempts,
    };
    attempts.push({ route, code });
  }
  return deny(attempts[0]?.code ?? 'NO_ROUTE_ALLOWED', { attempts });
}

// readback must come from independent, server-side reads of the destination's
// actual canonical files. Matching a browser/AI supplied digest is insufficient.
export function verifyHandover(checkpoint, readback) {
  const fields = ['requirementsHash', 'conversationHash', 'stopHash', 'budgetHash', 'artifactsHash'];
  if (!record(checkpoint) || !record(readback) || typeof checkpoint.id !== 'string' || !checkpoint.id || !Number.isSafeInteger(checkpoint.version) || checkpoint.version < 1 || typeof checkpoint.goalId !== 'string' || !checkpoint.goalId) return { ok: false, code: 'INVALID_CHECKPOINT' };
  const allowed = ['id', 'version', 'goalId', ...fields];
  if (Object.keys(checkpoint).some(key => !allowed.includes(key)) || Object.keys(readback).some(key => !allowed.includes(key)) || fields.some(key => typeof checkpoint[key] !== 'string' || !/^[a-f0-9]{64}$/.test(checkpoint[key]))) return { ok: false, code: 'INVALID_CHECKPOINT' };
  const mismatches = ['id', 'version', 'goalId', ...fields].filter(key => checkpoint[key] !== readback[key]);
  return { ok: mismatches.length === 0, code: mismatches.length ? 'HANDOVER_MISMATCH' : 'HANDOVER_MATCH', mismatches };
}
