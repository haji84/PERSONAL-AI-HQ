import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, symlinkSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const source=resolve('scripts/secret-guard.mjs');
const token=()=> 'ghp_'+'Z'.repeat(30);
function fixture(fn, suffix='') {
 const dir=mkdtempSync(join(tmpdir(),'guard-'+suffix));
 const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
 const git=(...args)=>{const r=spawnSync('git',args,{cwd:dir,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 const scan=(...args)=>spawnSync(process.execPath,[join(dir,'scanner.mjs'),...args],{cwd:dir,env,encoding:'utf8'});
 const put=(name,data)=>writeFileSync(join(dir,name),data);
 try {git('init');git('config','user.name','Synthetic');git('config','user.email','synthetic@example.invalid');copyFileSync(source,join(dir,'scanner.mjs'));put('safe.txt','safe');git('add','safe.txt');git('commit','-m','safe');fn({dir,git,scan,put,env});}
 finally {rmSync(dir,{recursive:true,force:true});}
}
const blocked=r=>{assert.notEqual(r.status,0,'unsafe input passed');assert.doesNotMatch(r.stdout+r.stderr,new RegExp(token()));};
test('staged symlink to regular type change is scanned',()=>fixture(({dir,git,scan,put})=>{symlinkSync('safe.txt',join(dir,'change'));git('add','change');git('commit','-m','synthetic symlink');unlinkSync(join(dir,'change'));put('change',token());git('add','change');blocked(scan('--staged'));}));
for(const char of ['#','?','%']) test('CLI executes in checkout containing '+char,()=>fixture(({git,scan,put})=>{put('bad.txt',token());git('add','bad.txt');blocked(scan('--staged'));},char));
test('commit scan ignores sanitized working tree',()=>fixture(({git,scan,put})=>{put('bad.txt',token());git('add','bad.txt');git('commit','-m','synthetic');put('bad.txt','safe');blocked(scan());}));
test('staged scan ignores sanitized working tree',()=>fixture(({git,scan,put})=>{put('bad.txt',token());git('add','bad.txt');put('bad.txt','safe');blocked(scan('--staged'));}));
test('invalid non-NUL UTF8 fails closed',()=>fixture(({git,scan,put})=>{put('bad.bin',Buffer.from([0xff,0xfe,0x41]));git('add','bad.bin');blocked(scan('--staged'));}));
test('symlink to safe outside file is unsupported, not followed',()=>fixture(({dir,git,scan})=>{symlinkSync('/dev/null',join(dir,'link'));git('add','link');git('commit','-m','link');blocked(scan());}));
test('gitlink mode fails closed',()=>fixture(({git,scan})=>{git('update-index','--add','--cacheinfo','160000,'+git('rev-parse','HEAD')+',module');blocked(scan('--staged'));}));
test('unknown arguments fail closed',()=>fixture(({scan})=>blocked(scan('--typo'))));
test('explicit SHA selects old safe commit, not unsafe HEAD',()=>fixture(({git,scan,put})=>{const safe=git('rev-parse','HEAD');put('bad.txt',token());git('add','bad.txt');git('commit','-m','bad');assert.equal(scan('--commit',safe).status,0);blocked(scan('--commit',git('rev-parse','HEAD')));}));
test('invalid explicit revisions fail closed',()=>fixture(({scan})=>{blocked(scan('--commit','HEAD'));blocked(scan('--commit','f'.repeat(40)));blocked(scan('--commit'));}));
test('replacement ref cannot hide committed token',()=>fixture(({git,scan,put})=>{const safe=git('rev-parse','HEAD');put('bad.txt',token());git('add','bad.txt');git('commit','-m','bad');const bad=git('rev-parse','HEAD');git('replace',bad,safe);blocked(scan('--commit',bad));}));
test('safe committed files survive deleted worktree and unsafe index',()=>fixture(({dir,git,scan,put})=>{unlinkSync(join(dir,'safe.txt'));put('bad.txt',token());git('add','bad.txt');assert.equal(scan().status,0);}));
test('tabs newlines and leading dash names are scanned',()=>fixture(({git,scan,put})=>{put('-odd\t\nname',token());git('add','--','-odd\t\nname');blocked(scan('--staged'));}));
test('valid Unicode text and executable regular modes pass',()=>fixture(({git,scan,put})=>{put('日本語.txt','こんにちは');git('add','日本語.txt');git('update-index','--chmod=+x','日本語.txt');assert.equal(scan('--staged').status,0);}));
test('oversize immutable blobs are rejected',()=>fixture(({git,scan,put})=>{put('large.txt',Buffer.alloc(1024*1024+1,65));git('add','large.txt');blocked(scan('--staged'));}));
test('temporary alternate index honored',()=>fixture(({dir,git,scan,put,env})=>{env.GIT_INDEX_FILE=join(dir,'alternate-index');git('read-tree','HEAD');put('bad.txt',token());git('add','bad.txt');blocked(scan('--staged'));}));
test('unmerged index fails closed',()=>fixture(({git,scan,put})=>{const base=git('rev-parse','HEAD');git('checkout','-b','other');put('safe.txt','other');git('add','safe.txt');git('commit','-m','other');git('checkout','-b','ours',base);put('safe.txt','ours');git('add','safe.txt');git('commit','-m','ours');// populate unmerged index directly
 const blob=git('rev-parse','HEAD:safe.txt');const r=spawnSync('git',['update-index','--index-info'],{cwd:git('rev-parse','--show-toplevel'),input:`0 ${'0'.repeat(40)}\tsafe.txt\n100644 ${blob} 1\tsafe.txt\n100644 ${blob} 2\tsafe.txt\n`,encoding:'utf8'});assert.equal(r.status,0);blocked(scan('--staged'));}));
test('explicit annotated tag object is not a commit identity',()=>fixture(({git,scan})=>{git('tag','-a','synthetic-tag','-m','synthetic');blocked(scan('--commit',git('rev-parse','synthetic-tag')));}));
test('CLI invoked through scanner symlink cannot silently pass',()=>fixture(({dir,git,scan,put,env})=>{put('bad.txt',token());git('add','bad.txt');symlinkSync(join(dir,'scanner.mjs'),join(dir,'scanner-link.mjs'));blocked(spawnSync(process.execPath,[join(dir,'scanner-link.mjs'),'--staged'],{cwd:dir,env,encoding:'utf8'}));}));
test('CLI symlink works with preserve-symlinks-main',()=>fixture(({dir,git,put,env})=>{put('bad.txt',token());git('add','bad.txt');symlinkSync(join(dir,'scanner.mjs'),join(dir,'scanner-link.mjs'));blocked(spawnSync(process.execPath,['--preserve-symlinks-main',join(dir,'scanner-link.mjs'),'--staged'],{cwd:dir,env,encoding:'utf8'}));}));

test('scanner diagnostics redact synthetic credentials embedded in file paths',()=>fixture(({git,scan,put})=>{
 const secret=token(), filename='synthetic-'+secret+'.txt';
 put(filename,secret);
 git('add','--',filename);
 const result=scan('--staged');
 blocked(result);
 assert.doesNotMatch(result.stderr+result.stdout,new RegExp(secret));
}));
