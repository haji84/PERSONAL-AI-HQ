import {execFileSync} from 'node:child_process';
import {constants, closeSync, fstatSync, lstatSync, openSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {projectKey} from './portfolio.mjs';
import {maximumApiJobUsd} from './api-response.mjs';
import {normalizeRealtimeCostConfig, maximumRealtimeCostMicros} from './realtime-cost.mjs';

export const apiAuthorityFile = 'api-execution-authority.json';
const fail = code => { throw Object.assign(new Error(code), {code}); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{1,159}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const decimal = value => Number.isFinite(value) && value >= 0 && value <= 1_000_000;
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function assertNoACL(path, missingCode) {
  if (process.platform !== 'darwin') return;
  try {
    const lines = execFileSync('/bin/ls', ['-Plde', path], {encoding: 'utf8', env: {LC_ALL: 'C'},
      timeout: 2000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'ignore']}).trimEnd().split('\n');
    if (lines.length !== 1) fail('API_AUTHORITY_UNSAFE');
  } catch (cause) {
    if (cause.code === 'API_AUTHORITY_UNSAFE') throw cause;
    try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') fail(missingCode); }
    fail('API_AUTHORITY_UNSAFE');
  }
}

function ownerRecord(directory) {
  let fd;
  try {
    const uid = process.getuid?.();
    const parent = lstatSync(directory);
    if (uid === undefined || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077)) fail('API_AUTHORITY_UNSAFE');
    assertNoACL(directory, 'API_AUTHORITY_MISSING');
    const path = join(directory, apiAuthorityFile);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== uid || (file.mode & 0o077) || file.nlink !== 1 || file.size > 131072) fail('API_AUTHORITY_UNSAFE');
    assertNoACL(path, 'API_AUTHORITY_MISSING');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (cause) {
    if (cause.code === 'ENOENT' || cause.code === 'API_AUTHORITY_MISSING') fail('API_AUTHORITY_MISSING');
    if (cause.code === 'ELOOP' || cause.code === 'API_AUTHORITY_UNSAFE') fail('API_AUTHORITY_UNSAFE');
    fail('API_AUTHORITY_INVALID');
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function readApiAuthority(directory, now = Date.now(), {forDispatch = true} = {}) {
  const value = ownerRecord(directory);
  if (!record(value) || value.version !== 1 || !identifier(value.organization) || !identifier(value.providerProject) ||
      !identifier(value.reservationAuthorityId) || !hash(value.ledgerBinding) ||
      Object.keys(value).some(key => !['version', 'organization', 'providerProject', 'reservationAuthorityId', 'ledgerBinding', 'credit', 'models', 'defaultModel', 'projects', 'realtimeVoice'].includes(key))) {
    fail('API_AUTHORITY_INVALID');
  }
  const credit = value.credit;
  if (!record(credit) || credit.organization !== value.organization || credit.checkoutConfirmed !== true ||
      credit.purchasedCreditUsd !== 0 || credit.paidBillingEnabled !== false || credit.autoRechargeEnabled !== false ||
      !decimal(credit.availableCreditUsd) || !Number.isFinite(timestamp(credit.observedAt)) || !Number.isFinite(timestamp(credit.safeUntil)) ||
      (forDispatch && (credit.availableCreditUsd === 0 || !Number.isFinite(now) || timestamp(credit.observedAt) > now ||
        now - timestamp(credit.observedAt) > 300_000 || timestamp(credit.safeUntil) <= now))) {
    fail('API_CREDIT_UNVERIFIED');
  }
  if (!Array.isArray(value.models) || !value.models.length || value.models.length > 12 ||
      value.models.some(model => !record(model) || !identifier(model.id) ||
        !Number.isSafeInteger(model.contextTokens) || model.contextTokens < 512 || model.contextTokens > 2_000_000 ||
        !Number.isSafeInteger(model.outputTokens) || model.outputTokens < 128 || model.outputTokens > model.contextTokens ||
        model.outputTokens > 65536 || !decimal(model.inputUsdPerMillion) || !decimal(model.outputUsdPerMillion) ||
        !Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.some(effort => !efforts.has(effort)) || maximumApiJobUsd(model) <= 0) ||
      new Set(value.models.map(model => model.id)).size !== value.models.length ||
      !value.models.some(model => model.id === value.defaultModel)) fail('API_MODEL_AUTHORITY_INVALID');
  if (!record(value.projects) || Object.keys(value.projects).some(project => !projectKey.test(project) ||
      ['constructor', 'prototype'].includes(project) || !record(value.projects[project]) ||
      !Array.isArray(value.projects[project].files) || !value.projects[project].files.length ||
      !Array.isArray(value.projects[project].testPaths) || !value.projects[project].testPaths.length)) fail('API_PROJECT_AUTHORITY_INVALID');
  let realtimeVoice;
  if (Object.hasOwn(value, 'realtimeVoice')) {
    if (!record(value.realtimeVoice)) fail('REALTIME_VOICE_AUTHORITY_INVALID');
    const {projects: enrolled, ...rawConfig} = value.realtimeVoice;
    const config = normalizeRealtimeCostConfig(rawConfig);
    const ceiling = config && maximumRealtimeCostMicros(config);
    if (!config || !Number.isSafeInteger(ceiling) || ceiling <= 0 || ceiling > 1_000_000_000_000 ||
        !Array.isArray(enrolled) || !enrolled.length || enrolled.length > 100 || new Set(enrolled).size !== enrolled.length ||
        enrolled.some(project => typeof project !== 'string' || !projectKey.test(project) ||
          ['constructor', 'prototype'].includes(project))) fail('REALTIME_VOICE_AUTHORITY_INVALID');
    realtimeVoice = {projects: enrolled, config};
  }
  const {organization, providerProject, reservationAuthorityId, ledgerBinding, defaultModel, models, projects} = value;
  return {version: 1, organization, providerProject, reservationAuthorityId, ledgerBinding, defaultModel, credit: {
    organization: credit.organization, observedAt: credit.observedAt, safeUntil: credit.safeUntil,
    availableCreditUsd: credit.availableCreditUsd, checkoutConfirmed: true, purchasedCreditUsd: 0,
    paidBillingEnabled: false, autoRechargeEnabled: false,
  }, models: models.map(({id, contextTokens, outputTokens, inputUsdPerMillion, outputUsdPerMillion, reasoningEfforts}) =>
    ({id, contextTokens, outputTokens, inputUsdPerMillion, outputUsdPerMillion, reasoningEfforts})), projects,
    ...(realtimeVoice ? {realtimeVoice} : {})};
}

export function readBoundApiAuthority(directory, store, now, {forDispatch = true, readAuthority = readApiAuthority} = {}) {
  const authority = readAuthority(directory, now, {forDispatch});
  let binding;
  try { binding = store.reservationBinding(); } catch { fail('API_AUTHORITY_UNBOUND'); }
  if (!binding || authority.reservationAuthorityId !== store.authorityId || authority.ledgerBinding !== binding) fail('API_AUTHORITY_UNBOUND');
  return authority;
}

export function verifiedApiCredit(authority) {
  return {organizationId: authority.organization, creditOrganizationId: authority.credit.organization,
    reservationAuthorityId: authority.reservationAuthorityId, ledgerBinding: authority.ledgerBinding,
    availableCreditUsd: authority.credit.availableCreditUsd, observedAt: authority.credit.observedAt,
    expiresAt: authority.credit.safeUntil, zeroAdditionalCostGuaranteed: true};
}
