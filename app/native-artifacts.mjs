import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, openSync, readSync, realpathSync} from 'node:fs';
import {basename, join} from 'node:path';
import {prepareArtifactEvidenceReadback, readCommittedEvidence} from './api-workspace.mjs';
import {readCurrentProject} from './portfolio.mjs';

const evidenceHash = /^[a-f0-9]{64}$/;
const gitRevision = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const pageSize = 8;
const windows = process.platform === 'win32';
const notFound = () => Object.assign(new Error('検証済みの成果物を確認できません。'), {status: 404});
const validHash = value => typeof value === 'string' && evidenceHash.test(value);

function fileEvidence(file) {
  return typeof file?.path === 'string' && validHash(file.sha256);
}

function downloadLink(project, id, index, part, review) {
  return '/api/artifacts/work/file?' + new URLSearchParams({source: 'codex', project, id, index, part, review});
}

function checkedWorkspaceMarker(checkout, projectId) {
  let fd;
  try {
    const owner = process.getuid?.();
    if (owner === undefined || realpathSync(checkout) !== checkout) return false;
    fd = openSync(join(checkout, '.hq-owned-workspace'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, {bigint: true});
    if (!before.isFile() || before.uid !== BigInt(owner) || before.nlink !== 1n || before.size > 100n) return false;
    const buffer = Buffer.alloc(101);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const after = fstatSync(fd, {bigint: true});
    return BigInt(length) === before.size && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs &&
      buffer.subarray(0, length).toString('utf8').trim() === projectId;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function createNativeArtifacts(directory, completedArtifactSource) {
  function published(project) {
    const checkpoint = project?.nativeHandover;
    if (checkpoint?.version !== 1 || checkpoint.shareArtifacts !== true || checkpoint.effectsReconciled !== true ||
        !project.handoverRequirements || typeof checkpoint.checkoutHead !== 'string' || !gitRevision.test(checkpoint.checkoutHead) ||
        !validHash(checkpoint.requirementsSha256) || !fileEvidence(checkpoint.verification) ||
        !Array.isArray(checkpoint.artifacts) || !checkpoint.artifacts.length || checkpoint.artifacts.length > 22 ||
        !checkpoint.artifacts.every(fileEvidence)) return null;
    const checkout = join(directory, 'workspaces', project.id);
    const source = completedArtifactSource(project, checkout, checkpoint);
    if (!source || (!windows && !checkedWorkspaceMarker(checkout, project.id))) return null;
    const evidence = [{path: project.handoverRequirements, sha256: checkpoint.requirementsSha256},
      checkpoint.verification, ...checkpoint.artifacts].map(({path, sha256}) => ({path, sha256}));
    const review = createHash('sha256').update(JSON.stringify([project.id, source, checkout, checkpoint.checkoutHead, evidence])).digest('hex');
    return {project: project.id, source, checkout, head: checkpoint.checkoutHead, evidence, review};
  }

  function stillPublished(claim) {
    try {
      return published(readCurrentProject(directory, claim.project))?.review === claim.review;
    } catch {
      return false;
    }
  }

  function prepareReadback(claim) {
    return prepareArtifactEvidenceReadback({checkout: claim.checkout, head: claim.head, files: claim.evidence,
      workspaceProject: claim.project, signal: AbortSignal.timeout(12000)});
  }

  async function verify(claim, includeBytes = false) {
    try {
      const git = await readCommittedEvidence({checkout: claim.checkout, paths: claim.evidence.map(file => file.path),
        includeBytes, workspaceProject: claim.project, signal: AbortSignal.timeout(12000)});
      return git.head === claim.head && git.files.every((file, index) => file.sha256 === claim.evidence[index].sha256) ? git : null;
    } catch {
      return null;
    }
  }

  return {
    async list(projects, offset) {
      const candidates = projects.map(published).filter(Boolean).sort((left, right) =>
        right.source.updatedAt.localeCompare(left.source.updatedAt) || left.project.localeCompare(right.project));
      const page = candidates.slice(offset, offset + pageSize);
      const checks = await Promise.all(page.map(async claim => await verify(claim) ? prepareReadback(claim) : null));
      const artifacts = page.flatMap((claim, row) => {
        if (!checks[row]?.() || !stillPublished(claim)) return [];
        const [requirements, verification, ...files] = claim.evidence;
        const link = (index, part) => downloadLink(claim.project, claim.source.id, index, part, claim.review);
        return files.map((file, index) => ({
          project: claim.project, kind: 'file', title: file.path, description: 'Codexで検証済み',
          observedAt: claim.source.updatedAt, sha256: file.sha256, href: link(index, 'artifact'),
          evidence: {requirements: {...requirements, href: link(index, 'requirements')},
            verification: {...verification, href: link(index, 'verification')}},
        }));
      });
      const following = offset + page.length;
      return {artifacts, nextOffset: following < candidates.length ? following : null};
    },
    async artifact(project, id, index, part, review) {
      const claim = published(project);
      if (!claim || claim.source.id !== id || claim.review !== review || !Number.isSafeInteger(index) || index < 0 ||
          index + 2 >= claim.evidence.length) throw notFound();
      const fileIndex = {requirements: 0, verification: 1, artifact: index + 2};
      if (!Object.hasOwn(fileIndex, part)) throw notFound();
      const git = await verify(claim, true);
      const readback = git && await prepareReadback(claim);
      if (!readback?.() || !stillPublished(claim)) throw notFound();
      const file = git.files[fileIndex[part]];
      return {bytes: file.bytes, name: basename(file.path)};
    },
  };
}
