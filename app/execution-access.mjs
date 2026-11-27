import {join} from 'node:path';
import {resolveExecution} from './execution-policy.mjs';
import {ExecutionStore} from './execution-store.mjs';
import {readCurrentProject} from './portfolio.mjs';

const held = new Set(['paused', 'approval', 'limit', 'blocked', 'offline', 'waiting', 'completed']);
const problem = (status, message) => Object.assign(new Error(message), {status});

export function createExecutionAccess(directory, native) {
  const store = new ExecutionStore(join(directory, 'execution-policy.json'), {authorityId: 'personal-ai-hq-local'});

  function preflight(project, stage, workspace) {
    const latest = readCurrentProject(directory, project.id);
    if (!latest || held.has(latest.state)) throw problem(409, '案件の既存の停止条件が解除されていません。');
    if (stage === 'implementation' && (!latest.codexWrite || workspace && !latest.cwd.includes(workspace))) {
      throw problem(409, 'この案件の実行先の設定が変わりました。');
    }
    const snapshot = store.getSettings(project.id);
    const {settings} = snapshot;
    if (settings.mode === 'api-only' || settings.mode === 'hybrid' && settings.stageRoutes[stage] === 'api' ||
        settings.mode === 'auto' && settings.preference === 'api-first' && !settings.allowFallback) {
      throw problem(409, 'この作業に指定されたAPI実行経路は利用できません。');
    }
    return snapshot;
  }

  return {
    preflight,
    settings(project) {
      const {revision, updatedAt, settings} = store.getSettings(project.id);
      return {revision, updatedAt, settings, apiAvailable: false};
    },
    update(project, input) {
      if (!Number.isSafeInteger(input?.revision) || input.revision < 0 || !input.settings ||
          typeof input.settings !== 'object' || Array.isArray(input.settings)) {
        throw problem(400, '案件の実行設定を指定してください。');
      }
      try { return {...store.updateSettings(project.id, input.revision, input.settings), apiAvailable: false}; }
      catch (error) {
        if (['REVISION_CONFLICT', 'PROJECT_BUSY', 'STORE_BUSY'].includes(error.message)) {
          throw problem(409, '設定が更新されたか、案件が実行中です。状態を確認してください。');
        }
        if (error instanceof TypeError) throw problem(400, '実行モード、指定経路、上限の組み合わせを確認してください。');
        throw error;
      }
    },
    async authorize(project, {stage, model, effort, catalog}) {
      const {settings, revision} = preflight(project, stage);
      // Only the verified subscription provider is currently connected to this server.
      const observed = catalog ?? await native.models();
      const defaultModel = observed.data.find(item => item.isDefault);
      const chosen = resolveExecution({settings, task: {stage, ...(model ? {model} : {}),
        ...(effort ? {reasoningEffort: effort} : {})}, safety: {authorized: true, status: 'ready', allowedRoutes: ['subscription']},
      capabilities: {api: {available: false}, subscription: {available: observed.accountType === 'chatgpt',
        authMode: observed.accountType, defaultModel: defaultModel?.id,
        defaultReasoningEffort: catalog ? null : (observed.data.find(item => item.id === (model ?? settings.model ?? defaultModel?.id)))?.defaultReasoningEffort || null,
        models: observed.data.map(item => ({id: item.id, reasoningEfforts: item.reasoningEfforts.map(value => value.reasoningEffort)})),
      }}});
      if (!chosen.allowed || chosen.route !== 'subscription') {
        const message = ['MODEL_UNAVAILABLE', 'REASONING_UNAVAILABLE'].includes(chosen.code)
          ? 'この経路で利用できるモデルと推論レベルを選んでください。'
          : '案件設定と現在利用できる接続を照合できませんでした。';
        throw problem(409, message);
      }
      return {model: chosen.model, effort: chosen.reasoningEffort ?? undefined, revision};
    },
    isCurrent(project, revision, stage, workspace) { return preflight(project, stage, workspace).revision === revision; },
  };
}
