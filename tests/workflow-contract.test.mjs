import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const workflow=readFileSync(new URL('../.github/workflows/autonomous-manager-plan.yml',import.meta.url),'utf8');
// Static guard for this bounded workflow; real Actions execution verifies YAML/runtime behavior.
test('PR changes targeting main run all tests without privileged execution',()=>{
 assert.match(workflow,/^  pull_request:\n    branches: \[main\]$/m);
 assert.match(workflow,/^        run: node --test tests\/\*\.test\.mjs$/m);
 assert.match(workflow,/^        run: npm ci --ignore-scripts --no-audit --no-fund$/m);
 assert.doesNotMatch(workflow,/pull_request_target|secrets\.|write-all|:\s*write\b|id-token:|environment:|deploy|merge-pull|model-inference/i);
 assert.equal((workflow.match(/contents: read/g)||[]).length,2);
 assert.match(workflow,/persist-credentials: false/);
 assert.match(workflow,/node-version: '22'/);
 assert.match(workflow,/timeout-minutes: 5/);
 assert.match(workflow,/runs-on: ubuntu-latest/);
});
