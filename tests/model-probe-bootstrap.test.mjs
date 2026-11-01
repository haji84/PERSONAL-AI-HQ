import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const prep='scripts/prepare-model-probe.py';
const runtime=JSON.parse(readFileSync('tests/fixtures/local-builder/manifest.json','utf8'));
const reviewer=JSON.parse(readFileSync('tests/fixtures/local-reviewer/manifest.json','utf8'));
function call(...args){return spawnSync('/usr/bin/python3',['-I','-S',prep,...args],{encoding:'utf8',timeout:5000});}
test('model probe reports only pinned public artifact identities without downloads',()=>{
 const r=call('--manifest');
 assert.equal(r.status,0,r.stderr);
 const m=JSON.parse(r.stdout);
 assert.equal(m.runtime.sha256,runtime.runtime.archiveSha256);
 assert.equal(m.builder.sha256,runtime.model.sha256);
 assert.equal(m.reviewer.sha256,reviewer.sha256);
 assert.equal(m.builder.size,491400064);
 assert.equal(m.reviewer.size,reviewer.size);
 assert.match(m.runtime.url,/ggml-org\/llama\.cpp\/releases\/download\/b11968/);
 assert.match(m.builder.url,/Qwen\/Qwen2\.5-Coder-0\.5B-Instruct-GGUF\/resolve\/ebb2015/);
 assert.match(m.reviewer.url,/HuggingFaceTB\/SmolLM2-1\.7B-Instruct-GGUF\/resolve\/2d4a76a/);
 assert.doesNotMatch(r.stdout,/token|credential|secret/i);
});
test('unknown bootstrap mode never downloads or succeeds',()=>{
 const r=call('--unknown');
 assert.notEqual(r.status,0);
});
