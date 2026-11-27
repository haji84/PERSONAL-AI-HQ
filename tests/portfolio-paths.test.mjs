import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { readPortfolio } from '../app/portfolio.mjs';

test('equivalent absolute workspace paths use the host format before Codex scope checks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hq-portfolio-test-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep));
    assert.ok(target.includes('hq-portfolio-test-'));
    await rm(target, { recursive: true, force: true });
  });
  const workspace = resolve(directory, 'workspace');
  const portable = workspace.replaceAll('\\', '/') + '/';
  await writeFile(join(directory, 'portfolio.json'), JSON.stringify({
    projects: [{ id: 'project-a', name: 'Path test', cwd: [portable, workspace, 'relative-workspace'] }],
  }));
  const portfolio = await readPortfolio(directory);
  assert.deepEqual(portfolio.projects.get('project-a').cwd, [workspace]);
  assert.equal(portfolio.view.projects[0].cwd, undefined);
});
