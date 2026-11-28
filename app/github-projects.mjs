import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {promisify} from 'node:util';
import {parsePortfolioTaskRecords, portfolioObservationPath} from './delivery-records.mjs';

const cli = promisify(execFile);
const ownerName = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const repositoryName = /^[a-z0-9_.-]{1,100}$/i;
const refreshInterval = 60_000;
const limit = 250;
const githubPageSize = 100;
const gitSha = /^[a-f0-9]{40}$/;
const observationLimit = 256 * 1024;
const validId = id => Number.isSafeInteger(id) && id > 0;

async function readGithub(endpoint, jq, signal) {
  const {stdout} = await cli('gh', ['api', '--hostname', 'github.com', endpoint, '--jq', jq], {
    encoding: 'utf8', signal, timeout: 8000, maxBuffer: 1024 ** 2,
    env: {...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_DEBUG: ''},
  });
  return JSON.parse(stdout);
}

function githubAccessDenied(error) {
  const message = typeof error?.stderr === 'string' ? error.stderr : '';
  const status = /\bHTTP\s+(401|403|404|410)\b/u.exec(message)?.[1];
  return Boolean(status && (status !== '403' || !/\brate[- ]limit\b/iu.test(message)));
}

async function readOwned(owner, {signal}) {
  const account = await readGithub('user', '{id,login}', signal);
  const repositories = [];
  if (!matchingAccount(account, owner)) return {account, repositories};
  for (let page = 1; page <= Math.ceil(limit / githubPageSize); page++) {
    const rows = await readGithub('user/repos?affiliation=owner&sort=full_name&direction=asc&per_page=' + githubPageSize + '&page=' + page,
      'map({id,name,owner:(.owner|{id,login}),archived,disabled,fork})', signal);
    if (!Array.isArray(rows) || rows.length > githubPageSize || repositories.length + rows.length > limit) {
      throw new Error('GitHub inventory exceeds the dashboard limit');
    }
    repositories.push(...rows);
    if (rows.length < githubPageSize) break;
  }
  return {account, repositories};
}

async function readProgress({owner, accountId, repositoryId, name, branch, base}, {signal}) {
  const repo = 'repositories/' + repositoryId;
  const [account, identity] = await Promise.all([readGithub('user','{id,login}',signal),
    readGithub(repo,'{id,name,owner:{id:.owner.id,login:.owner.login},archived,disabled,fork}',signal)]);
  if (!matchingAccount(account,owner) || account.id !== accountId || !validRepository(identity) ||
      identity.id !== repositoryId || identity.name.toLowerCase() !== name.toLowerCase() ||
      !matchingAccount(identity.owner,owner) || identity.owner.id !== accountId ||
      identity.archived || identity.disabled !== false || identity.fork !== false) return {denied:true};
  const ref = await readGithub(repo + '/git/ref/heads/' + branch.split('/').map(encodeURIComponent).join('/'),
    '{ref,revision:.object.sha,type:.object.type}',signal);
  const revision = ref?.revision;
  if (ref?.ref !== 'refs/heads/' + branch || ref.type !== 'commit' || !gitSha.test(revision ?? '')) return null;
  if (revision === base) return {revision};
  const history = await readGithub(repo + '/compare/' + base + '...' + revision,
    '{status,ancestor:.merge_base_commit.sha}',signal);
  if (history?.status !== 'ahead' || history.ancestor !== base) return null;
  const tree = await readGithub(repo + '/git/trees/' + revision + '?recursive=1',
    '{truncated,entries:[.tree[]|select(.path==' + JSON.stringify(portfolioObservationPath) + ')]}',signal);
  const entries = tree?.entries;
  if (tree?.truncated !== false || !Array.isArray(entries) || entries.length !== 1) return null;
  const [entry] = entries;
  if (entry.type !== 'blob' || !['100644','100755'].includes(entry.mode) || !gitSha.test(entry.sha ?? '') ||
      !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > observationLimit) return null;
  const blob = await readGithub(repo + '/git/blobs/' + entry.sha,'{sha,size,encoding,content}',signal);
  if (blob?.sha !== entry.sha || blob.size !== entry.size || blob.encoding !== 'base64' ||
      typeof blob.content !== 'string') return null;
  const file = Buffer.from(blob.content,'base64');
  const objectId = createHash('sha1').update('blob ' + file.length + '\0').update(file).digest('hex');
  return file.length === entry.size && objectId === entry.sha ? {revision,file} : null;
}

function matchingAccount(account, owner) {
  return validId(account?.id) && typeof account.login === 'string' && account.login.toLowerCase() === owner;
}

function validRepository(repo) {
  return validId(repo?.id) && typeof repo.name === 'string' && repositoryName.test(repo.name) &&
    !['.', '..'].includes(repo.name) && typeof repo.archived === 'boolean';
}

function ownedRepositories(repositories, account, owner) {
  if (!Array.isArray(repositories) || repositories.length > limit) throw new Error('Invalid GitHub inventory');
  const known = new Map();
  const byName = new Map();
  for (const repo of repositories) {
    if (!matchingAccount(repo?.owner, owner) || repo.owner.id !== account.id || repo.fork !== false || repo.disabled !== false) continue;
    if (!validRepository(repo)) throw new Error('Invalid GitHub repository');
    const row = {id: repo.id, name: repo.name, archived: repo.archived};
    const previous = known.get(row.id);
    if (previous && (previous.name !== row.name || previous.archived !== row.archived)) throw new Error('GitHub inventory changed during observation');
    const name = row.name.toLowerCase();
    const namedId = byName.get(name);
    if (namedId !== undefined && namedId !== row.id) throw new Error('GitHub inventory contains an ambiguous repository name');
    known.set(row.id, row);
    byName.set(name, row.id);
  }
  return [...known.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

function repositoryKey(value) {
  try {
    const url = new URL(value);
    const [, account, name] = /^\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname) ?? [];
    if (url.origin !== 'https://github.com' || url.username || url.password || !ownerName.test(account ?? '') || !name) return null;
    return (account + '/' + name.replace(/\.git$/i, '')).toLowerCase();
  } catch {
    return null;
  }
}

function linkedProjects(owner, repositories, manual, saved) {
  const manualById = new Map(manual.map(row => [row.id, repositoryKey(row.repository)]));
  const byRepo = new Map();
  const reserved = new Set();
  for (const link of saved) {
    if (manualById.get(link.project) !== link.key || reserved.has(link.key) || byRepo.has(link.id)) continue;
    byRepo.set(link.id, link);
    reserved.add(link.key);
  }
  const covered = new Set(byRepo.keys());
  for (const repo of repositories) {
    if (byRepo.has(repo.id)) continue;
    const key = (owner + '/' + repo.name).toLowerCase();
    if (reserved.has(key)) continue;
    const candidates = manual.filter(project => manualById.get(project.id) === key);
    if (candidates.length) covered.add(repo.id);
    if (candidates.length === 1) {
      byRepo.set(repo.id, {id:repo.id, project:candidates[0].id, key});
      reserved.add(key);
    }
  }
  return {links:[...byRepo.values()], covered};
}

function savedArray(value, validate) {
  try {
    const rows = JSON.parse(value);
    return Array.isArray(rows) && rows.length <= limit && rows.every(validate) ? rows : null;
  } catch {
    return null;
  }
}

export function createGithubProjects(directory, {owner: configuredOwner, read = readOwned, readTask = readProgress, now = Date.now}) {
  if (typeof configuredOwner !== 'string' || !ownerName.test(configuredOwner)) throw new TypeError('Invalid GitHub portfolio owner');
  const owner = configuredOwner.toLowerCase();
  const db = new DatabaseSync(join(directory, 'conversations.sqlite'));
  db.exec(`PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS github_project_snapshot (
      owner TEXT PRIMARY KEY NOT NULL, account_id INTEGER NOT NULL, checked_at INTEGER NOT NULL,
      observed_at INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0, repositories TEXT NOT NULL, links TEXT NOT NULL
    )`);
  const byOwner = db.prepare('SELECT * FROM github_project_snapshot WHERE owner=?');
  const save = db.prepare(`INSERT INTO github_project_snapshot VALUES (?,?,?,?,0,?,?)
    ON CONFLICT(owner) DO UPDATE SET account_id=excluded.account_id,checked_at=excluded.checked_at,
    observed_at=excluded.observed_at,blocked=0,repositories=excluded.repositories,links=excluded.links
    WHERE excluded.account_id = github_project_snapshot.account_id AND excluded.checked_at >= github_project_snapshot.checked_at`);
  const suppress = db.prepare('UPDATE github_project_snapshot SET blocked=1,checked_at=? WHERE owner=? AND checked_at<=?');
  let checked = -Infinity;
  let status = 'pending';
  let pending, controller;
  let progress;
  let closed = false;

  function previous() {
    try {
      const row = byOwner.get(owner);
      if (!row) return null;
      const repositories = savedArray(row.repositories, validRepository);
      const links = savedArray(row.links, link => validId(link?.id) && typeof link.project === 'string' && typeof link.key === 'string');
      const validTime = Number.isSafeInteger(row.observed_at) && row.observed_at >= 0 && row.observed_at <= 8.64e15;
      const uniqueRepositories = repositories && new Set(repositories.map(repo => repo.id)).size === repositories.length &&
        new Set(repositories.map(repo => repo.name.toLowerCase())).size === repositories.length;
      return {accountId:row.account_id, blocked:row.blocked === 1, observedAt:validTime ? row.observed_at : null,
        repositories:uniqueRepositories ? repositories : null, links:links ?? []};
    } catch {
      return null;
    }
  }

  function refresh(manual) {
    const started = now();
    if (closed || pending || started - checked < refreshInterval) return;
    checked = started;
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    pending = Promise.resolve().then(async () => {
      const response = await read(owner, {signal});
      signal.throwIfAborted();
      const snapshot = previous();
      if (!matchingAccount(response?.account, owner) || (snapshot && snapshot.accountId !== response.account.id)) {
        suppress.run(started, owner, started);
        status = 'account-mismatch';
        return;
      }
      const repositories = ownedRepositories(response.repositories, response.account, owner);
      const {links} = linkedProjects(owner, repositories, manual, snapshot?.links ?? []);
      save.run(owner, response.account.id, started, now(), JSON.stringify(repositories), JSON.stringify(links));
      status = 'ready';
    }).catch(() => {
      if (!closed) status = 'unavailable';
    }).finally(() => {
      pending = undefined;
      controller = undefined;
    });
  }

  function taskRepository(repository) {
    const snapshot = previous();
    if (closed || status !== 'ready' || !snapshot || snapshot.blocked ||
        now() - snapshot.observedAt > 2 * refreshInterval) return null;
    const repo = snapshot.repositories?.find(row => !row.archived && repository === owner + '/' + row.name.toLowerCase());
    return repo ? {repositoryId:repo.id, accountId:snapshot.accountId, name:repo.name} : null;
  }

  return {
    view(manual, refreshRequested) {
      if (closed) return null;
      if (refreshRequested) refresh(manual);
      const cache = previous();
      if (status === 'account-mismatch' || (cache && (!validId(cache.accountId) || cache.blocked))) {
        return {status:'account-mismatch', observedAt:null, count:0, projects:[]};
      }
      if (!cache?.repositories || cache.observedAt === null) {
        return {status:status === 'ready' ? 'unavailable' : status, observedAt:null, count:0, projects:[]};
      }
      const observedAt = new Date(cache.observedAt).toISOString();
      const live = status === 'ready' && now() - cache.observedAt <= 2 * refreshInterval;
      const {covered} = linkedProjects(owner, cache.repositories, manual, cache.links);
      const manualIds = new Set(manual.map(row => row.id.toLowerCase()));
      const projects = cache.repositories.flatMap(repo => {
        const id = 'github-' + repo.id;
        if (covered.has(repo.id) || manualIds.has(id)) return [];
        const repository = 'https://github.com/' + owner + '/' + encodeURIComponent(repo.name);
        return [{id, name:repo.name, repository, observedAt, state:'unknown',
          registrationAvailable: live && !repo.archived,
          summary: repo.archived ? 'GitHubでアーカイブ済み' : 'GitHubで確認 · 作業先未設定'}];
      }).slice(0, Math.max(0, limit - manual.length));
      return {status:live ? 'ready' : 'stale', observedAt, count:cache.repositories.length, projects};
    },
    taskProgress({repository, ref, revision}) {
      const branch = /^refs\/remotes\/origin\/(.+)$/.exec(ref)?.[1];
      if (!branch || !gitSha.test(revision) ||
          !branch.split('/').every(part => /^[a-z0-9][a-z0-9_.-]*$/i.test(part))) return null;
      const slug = repositoryKey(repository);
      if (closed || !slug?.startsWith(owner + '/')) return {status:'unavailable'};
      const identified = taskRepository(slug);
      if (!identified && !pending) return {status:'unavailable'};
      const key = JSON.stringify([slug,branch,revision]);
      if (progress?.key !== key || (identified && progress.identity &&
          (progress.identity.repositoryId !== identified.repositoryId || progress.identity.accountId !== identified.accountId))) {
        progress?.controller?.abort();
        progress = {key,checked:-Infinity};
      }
      const slot = progress;
      if (!slot.pending && now() - slot.checked >= refreshInterval) {
        slot.checked = now();
        slot.controller = new AbortController();
        slot.pending = Promise.resolve(identified ? undefined : pending).then(async () => {
          const identity = taskRepository(slug);
          if (!identity || progress !== slot) return;
          if (slot.identity && (identity.repositoryId !== slot.identity.repositoryId ||
              identity.accountId !== slot.identity.accountId)) slot.saved = undefined;
          slot.identity = identity;
          const signal = AbortSignal.any([slot.controller.signal,AbortSignal.timeout(8000)]);
          const base = slot.saved?.revision ?? revision;
          const result = await readTask({owner,...identity,branch,base},{signal});
          signal.throwIfAborted();
          if (result?.denied) slot.saved = undefined;
          const unchanged = result?.revision === base && !result.file;
          const verified = gitSha.test(result?.revision ?? '') && Buffer.isBuffer(result.file) &&
            result.file.length <= observationLimit && parsePortfolioTaskRecords(result.file,slug,result.revision);
          if (unchanged) slot.saved ??= result;
          if (verified) slot.saved = result;
          slot.value = {...slot.saved,status:unchanged || verified ? 'synced' : 'unavailable'};
        }).catch(error => {
          if (githubAccessDenied(error)) slot.saved = undefined;
          slot.value = {...slot.saved,status:'unavailable'};
        }).finally(() => {
          slot.pending = undefined;
          slot.controller = undefined;
        });
      }
      return identified && slot.value ? slot.value : {status:slot.pending ? 'checking' : 'unavailable'};
    },
    async close() {
      if (closed) return;
      closed = true;
      controller?.abort();
      progress?.controller?.abort();
      await Promise.all([pending,progress?.pending]);
      db.close();
    },
  };
}
