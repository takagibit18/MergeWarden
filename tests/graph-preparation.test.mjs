import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {repositoryFixture} from './repository-fixture.mjs';
import {SnapshotStore} from '../src/snapshot/store.ts';
import {prepareGraphCases,readGraphPreparation,verifyPreparedCases} from '../eval/real/graph-preparation.mjs';

test('graph preparation receipt binds a validated generation and detects drift',async t=>{
 const f=await repositoryFixture(t,{'a.py':'def save(): pass\ndef run(): save()\n'}),store=await SnapshotStore.freeze({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head:f.base},configuration:{}}),out=join(await mkdtemp(join(tmpdir(),'mw-prepared-')),'graph-preparation.json');
 const cases=[{caseId:'case-a',repository:'owner/repo',store}],receipt=await prepareGraphCases(cases,{kind:'reserve',output:out,runtimeCommit:'a'.repeat(40)});
 assert.equal(receipt.entries[0].generationId.length>0,true);assert.equal(receipt.entries[0].graphSchemaVersion,4);assert.equal(receipt.entries[0].scope,'core');
 const loaded=await readGraphPreparation(out);await verifyPreparedCases(loaded,cases,{kind:'reserve',runtimeCommit:'a'.repeat(40)});
 const tampered=JSON.parse(await readFile(out,'utf8'));tampered.entries[0].generationId='other';await assert.rejects(verifyPreparedCases(tampered,cases,{kind:'reserve',runtimeCommit:'a'.repeat(40)}),/drift/);
});
