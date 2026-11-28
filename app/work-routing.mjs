import {executionHeld} from './execution-access.mjs';
import {ROUTES, STAGES} from './execution-policy.mjs';
import {readCurrentProject} from './portfolio.mjs';

const requestId = /^[a-z0-9][a-z0-9_-]{7,79}$/i;
const fields = new Set(['id', 'prompt', 'stage', 'route', 'model', 'effort']);
const messages = {
  SIGN_IN_REQUIRED: 'サインインが必要です。',
  API_TASK_INVALID: '受付番号、指示、工程、モデルを確認してください。',
  PROJECT_BUSY: '実行中または結果を照合中の作業があります。',
  TASK_ID_CONFLICT: 'この受付番号は別の作業または経路で使用されています。',
  EXECUTION_SETTINGS_CHANGED: '案件の実行設定が変わりました。設定を確認してください。',
  EXECUTION_HELD: '案件の停止条件または承認待ちを確認してください。',
  STAGE_ROUTE_REQUIRED: 'この工程に使う経路を案件設定で指定してください。',
  OPTIMIZATION_INFORMATION_REQUIRED: '経路を比較できる実績を確認できません。',
  NO_ROUTE_ALLOWED: 'この案件と作業に許可された実行経路を確認できません。',
  ROUTE_NOT_ALLOWED: '指定した経路はこの案件で許可されていません。',
  ROUTE_UNAVAILABLE: '設定された経路の利用条件を確認できません。',
  MODEL_UNAVAILABLE: 'この経路で指定されたモデルを確認できません。',
  REASONING_UNAVAILABLE: '選択した推論レベルは経路で利用できません。',
  HANDOVER_REQUIRED: '元の作業と成果物を照合してから経路を変更してください。',
  CODEX_SUBSCRIPTION_LIMIT_REACHED: 'Codexの契約内利用枠を使用できません。',
  CODEX_SUBSCRIPTION_USAGE_UNCONFIRMED: 'Codexの契約内利用枠を確認できません。',
  SUBSCRIPTION_AUTH_REQUIRED: '契約内Codexの認証を確認できません。',
};

function problem(code, status = 409) {
  return Object.assign(new Error(messages[code] ?? messages.ROUTE_UNAVAILABLE), {status, code});
}

function checkedInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.has(key)) ||
      typeof input.id !== 'string' || !requestId.test(input.id) || typeof input.prompt !== 'string' ||
      !input.prompt.trim() || input.prompt.length > 12000 || !STAGES.includes(input.stage ?? 'implementation') ||
      (input.route !== undefined && !ROUTES.includes(input.route)) ||
      ['model', 'effort'].some(key => input[key] !== undefined &&
        (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 160))) {
    throw problem('API_TASK_INVALID', 400);
  }
  return {...input, stage:input.stage ?? 'implementation'};
}

export function createWorkRouting({directory, operations, store, apiWork, apiEnabled}) {
  function routeOf(project, id) {
    const api = store.getWork(project.id, id).operation;
    const subscription = operations.hasReceipt(project, id);
    if (api && (api.kind !== undefined || api.route !== 'api' || subscription)) throw problem('TASK_ID_CONFLICT');
    return api ? 'api' : subscription ? 'subscription' : null;
  }

  async function dispatch(project, input, route, signedIn, snapshot) {
    if (!signedIn()) throw problem('SIGN_IN_REQUIRED',401);
    if (input.route && input.route !== route) throw problem('TASK_ID_CONFLICT');
    const options = snapshot ? {expectedRevision:snapshot.revision,canDispatch:signedIn} : {replayOnly:true};
    const {operation} = await (route === 'api'
      ? apiWork.start(project, input, options)
      : operations.start(project, {...input, route}, options));
    return {route, operation, ...(snapshot?.fallback && {fallback:true})};
  }

  return {
    async read(project, id) {
      if (typeof id !== 'string' || !requestId.test(id)) throw problem('API_TASK_INVALID', 400);
      const route = routeOf(project,id);
      if (!route) return {route:null,operation:null};
      const {operation} = await (route === 'api' ? apiWork.read(project,id) : operations.read(project,id));
      return operation ? {route, operation} : {route:null,operation:null};
    },
    async start(project, uncheckedInput, signedIn) {
      const input = checkedInput(uncheckedInput);
      const recorded = routeOf(project,input.id);
      if (recorded) return dispatch(project,input,recorded,signedIn);

      const current = readCurrentProject(directory,project.id);
      if (!current || executionHeld(current.state)) throw problem('EXECUTION_HELD');
      const work = store.getWork(project.id);
      if (operations.hasActiveWork(project) || work.busy) throw problem('PROJECT_BUSY');
      const {settings,revision} = store.getSettings(project.id);
      if (input.route && !settings.allowedRoutes.includes(input.route)) throw problem('ROUTE_NOT_ALLOWED');
      const enabledRoutes = input.route ? [input.route] : settings.allowedRoutes;
      const [apiContext,subscription] = await Promise.all([
        Promise.resolve().then(() => apiEnabled && enabledRoutes.includes('api') ? apiWork.dispatchContext(project,input) : null)
          .catch(error => ({error:error.code})),
        enabledRoutes.includes('subscription')
          ? operations.dispatchCapability(project,input.model ?? settings.model).catch(error => ({available:false,error:error.code}))
          : {available:false},
      ]);
      const decision = store.previewDispatch(project.id, {stage:input.stage, ...(input.route && {route:input.route}),
        ...(input.model && {model:input.model}), ...(input.effort && {reasoningEffort:input.effort})}, {
        capabilities:{api:apiContext?.capabilities?.api, subscription},
        safety:{authorized:true,status:'ready',allowedRoutes:enabledRoutes, api:apiContext?.safety?.api},
      });
      if (!decision.allowed) {
        const committed = routeOf(project,input.id);
        if (committed) return dispatch(project,input,committed,signedIn);
        const firstRoute = decision.attempts?.[0]?.route;
        const unavailable = firstRoute === 'api' ? apiContext?.error : subscription.error;
        const code = decision.code === 'ROUTE_UNAVAILABLE' && typeof unavailable === 'string' ? unavailable : decision.code;
        throw problem(code);
      }
      if (decision.revision !== revision) throw problem('EXECUTION_SETTINGS_CHANGED');
      if (decision.route === 'subscription' && work.operation?.route === 'api') throw problem('HANDOVER_REQUIRED');
      try {
        return await dispatch(project,input,decision.route,signedIn,decision);
      } catch (error) {
        const committed = routeOf(project,input.id);
        if (committed && committed !== decision.route) return dispatch(project,input,committed,signedIn);
        throw error;
      }
    },
  };
}
