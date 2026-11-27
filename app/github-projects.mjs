import {execFile} from 'node:child_process';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {promisify} from 'node:util';

const cli = promisify(execFile);
const ownerName = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const repositoryName = /^[a-z0-9_.-]{1,100}$/i;
const refreshInterval = 60_000;
const limit = 250;
const githubPageSize = 100;
const validId = id => Number.isSafeInteger(id) && id > 0;

async function readOwned(owner, {signal}) {
  const run = async (endpoint, jq) => {
    const {stdout} = await cli('gh', ['api', '--hostname', 'github.com', endpoint, '--jq', jq], {
      encoding: 'utf8', signal, timeout: 8000, maxBuffer: 1024 ** 2,
      env: {...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_DEBUG: ''},
    });
    return JSON.parse(stdout);
  };
  const account = await run('user', '{id,login}');
  const repositories = [];
  if (!matchingAccount(account, owner)) return {account, repositories};
  for (let page = 1; page <= Math.ceil(limit / githubPageSize); page++) {
    const rows = await run('user/repos?affiliation=owner&sort=full_name&direction=asc&per_page=' + githubPageSize + '&page=' + page,
      'map({id,name,owner:(.owner|{id,login}),archived,disabled,fork})');
    if (!Array.isArray(rows) || rows.length > githubPageSize || repositories.length + rows.length > limit) {
      throw new Error('GitHub inventory exceeds the dashboard limit');
    }
    repositories.push(...rows);
    if (rows.length < githubPageSize) break;
  }
  return {account, repositories};
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

export function createGithubProjects(directory, {owner: configuredOwner, read = readOwned, now = Date.now}) {
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
    async close() {
      if (closed) return;
      closed = true;
      controller?.abort();
      await pending;
      db.close();
    },
  };
}
