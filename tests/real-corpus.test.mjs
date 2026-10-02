import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {repositoryFixture} from './repository-fixture.mjs';
import {freezeTask,prepareTask,validateTask} from '../eval/real/adapter.mjs';
import {compareSourceScope} from '../eval/real/scope.mjs';
import {sha256} from '../src/infrastructure/files.ts';
const task=(base='a'.repeat(40),head='b'.repeat(40))=>({case_id:'fixture',repository:'example/project',repository_url:'https://github.com/example/project.git',base_sha:base,reviewed_sha:head,language:'Python'});
test('real task public input rejects hidden labels, alternate URLs, partial SHAs and unsafe IDs',()=>{
 validateTask(task());
 for(const override of [{expected_label:'clean'},{source_record:{}},{repository_url:'file:///tmp/project'},{reviewed_sha:'abcdef'},{case_id:'../other'},{case_id:undefined},{repository:'../project'},{language:'JavaScript'}])assert.throws(()=>validateTask({...task(),...override}));
});
test('real adapter keeps original Git identities and immutable source bytes; rejects origin drift',async t=>{
 const f=await repositoryFixture(t),head=await f.change(),input=task(f.base,head);
 await f.git('remote','add','origin',input.repository_url);
 const store=await freezeTask(input,{repositoryPath:f.repository,stateDir:f.state,configuration:{fixture:true}});
 assert.equal(store.manifest.identity.headCommit,head);assert.equal(store.manifest.identity.baseCommit,f.base);
 await f.write('app.py','changed outside snapshot\n');
 assert.match(await store.text('head','app.py'),/total \/ count/);
 await f.git('remote','set-url','origin','https://github.com/example/other.git');
 await assert.rejects(freezeTask(input,{repositoryPath:f.repository,stateDir:f.state,configuration:{}}),/Origin/);
});
test('real adapter cancellation, hidden-gold placement and existing workspace guards',async t=>{
 const f=await repositoryFixture(t),head=await f.change(),input=task(f.base,head);
 await f.git('remote','add','origin',input.repository_url);
 await assert.rejects(prepareTask(input,f.repository),/ENOENT/);
 await assert.rejects(freezeTask(input,{repositoryPath:f.repository,stateDir:f.state,configuration:{},signal:AbortSignal.abort()}),/abort/i);
 const hidden=join(f.repository,'hidden');await mkdir(hidden);
 await assert.rejects(freezeTask(input,{repositoryPath:f.repository,stateDir:f.state,configuration:{},hiddenDirectory:hidden}),/Hidden gold/);
 await assert.rejects(freezeTask(input,{repositoryPath:f.repository,stateDir:hidden,configuration:{}}),/outside/);
});
test('source-clean labels cannot cover extra paths; multi-commit timeline stays unknown',()=>{
 const c={source:'swrbench',source_record:{pr_commits:[{sha:'head',diff:[{file:'app.py',patch:'fixture'}]}]}};
 assert.equal(compareSourceScope(c,'head',['app.py','version.py']).status,'mismatch');
 assert.equal(compareSourceScope(c,'head',['app.py']).status,'paths_match_requires_hunk_and_semantic_audit');
 c.source_record.pr_commits.push({sha:'other',diff:[]});assert.equal(compareSourceScope(c,'head',['app.py']).status,'unknown');
});
test('real candidate expansion is frozen, distinct PRs, and never silently becomes scoring gold',async()=>{
 const bytes=await readFile(new URL('../eval/real/manifests/candidates.index.json',import.meta.url));
 const lock=JSON.parse(await readFile(new URL('../eval/real/manifests/candidates.index.lock.json',import.meta.url)));
 const data=JSON.parse(bytes);assert.equal(sha256(bytes),lock.sha256);assert.equal(data.cases.length,104);
 assert.equal(new Set(data.cases.map(c=>c.repository.toLowerCase()+'/'+c.pull_number)).size,104);
 assert.ok(data.cases.every(c=>!c.scoringEligible&&c.expected_label===null));
 assert.equal(data.cases.filter(c=>c.source_role==='positive_candidate').length,40);
 assert.equal(data.cases.filter(c=>c.source_role==='negative_candidate').length,64);
});
