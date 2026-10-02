import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { score } from '../src/eval/metrics.ts';
import { validateCorpus } from '../eval/validate.mjs';
import { loadCorpus } from '../eval/corpus.mjs';
import { sha256 } from '../src/infrastructure/files.ts';
import { fileURLToPath } from 'node:url';
const bytes=await readFile(new URL('../eval/cases.json',import.meta.url),'utf8');const corpus=JSON.parse(bytes);const lock=JSON.parse(await readFile(new URL('../eval/corpus.lock.json',import.meta.url),'utf8'));
test('frozen corpus contains 12 defects and eight clean controls with immutable identities',()=>{assert.equal(validateCorpus(corpus,lock,bytes).cases.length,20);assert.throws(()=>validateCorpus(corpus,lock,bytes+' '),/hash mismatch/);});

test('archived r1 remains byte-identical and cannot be scored with current r2 labels',async()=>{
 const oldHash='ef748a3c5916190857e5cb8e4753b23274f7206833ada681763dd328b2b44939';
 const old=await loadCorpus(fileURLToPath(new URL('../eval/corpora/controlled-python-v02-20',import.meta.url)),oldHash);
 assert.equal(old.corpus.corpusId,'controlled-python-v02-20');
 assert.equal(old.corpus.cases.find(c=>c.id==='clean-guard').expected,'clean');
 const current=await loadCorpus();assert.notEqual(current.lock.sha256,oldHash);
 await assert.rejects(loadCorpus(undefined,oldHash),/Result corpus mismatch/);
 const revision=JSON.parse(await readFile(new URL('../eval/corpus-revision.json',import.meta.url),'utf8'));
 assert.equal(revision.corpusSha256,current.lock.sha256);assert.equal(revision.predecessor.sha256,oldHash);
 assert.equal(revision.review.humanAttestation,false);assert.equal(revision.review.priorModelResultsSeen,true);
 assert.deepEqual(revision.cases.map(c=>c.caseId).sort(),current.corpus.cases.map(c=>c.id).sort());
 for(const r of revision.cases){const c=current.corpus.cases.find(c=>c.id===r.caseId),p=old.corpus.cases.find(c=>c.id===r.predecessorCaseId);assert.equal(r.baseSha,c.baseSha);assert.equal(r.headSha,c.headSha);assert.equal(r.previousBaseSha,p.baseSha);assert.equal(r.previousHeadSha,p.headSha);assert.equal(r.severity.after,c.severity);}
});

test('corpus validation rejects inconsistent severity and out-of-source locations even with a matching lock',()=>{
 for(const mutate of [c=>c.cases[0].severity='none',c=>c.cases[0].expectedFindings[0].severity='low',c=>c.cases[12].severity='high',c=>c.cases[0].relevantLocation.endLine=999,c=>c.cases[0].relevantLocation.endLine=1.5]){
  const changed=structuredClone(corpus);mutate(changed);const content=JSON.stringify(changed);
  assert.throws(()=>validateCorpus(changed,{sha256:sha256(content)},content),/severity|Severity|location/);
 }
});
test('quality counts explicit one-to-one semantic matches, failures and false positives',()=>{
 const gold=corpus.cases.find(c=>c.id==='cross-key');const clean=corpus.cases.find(c=>c.id==='clean-guard');
 const runs=[{runKey:'a',caseId:gold.id,arm:'text+graph',delivered:true,status:'completed',findings:[{id:'good'},{id:'bad'}],elapsedMs:10},{runKey:'b',caseId:clean.id,arm:'text+graph',delivered:true,status:'completed',findings:[{id:'noise'}],elapsedMs:10},{runKey:'c',caseId:gold.id,arm:'text+graph',delivered:false,status:'failed',findings:[],elapsedMs:10}];
 const mapping=[{runKey:'a',status:'complete',reviewer:'fixture',predictions:[{predictionId:'good',goldenId:gold.expectedFindings[0].id,rationale:'same behavior'},{predictionId:'bad',goldenId:null,rationale:'different behavior'}]},{runKey:'b',status:'complete',reviewer:'fixture',predictions:[{predictionId:'noise',goldenId:null,rationale:'guard protects it'}]}];
 const r=score(corpus.cases,runs,mapping);const q=r.byArm['text+graph'].quality;assert.equal(q.findingPrecision,1/3);assert.equal(q.findingRecall,1/2);assert.equal(q.f1,2/5);assert.equal(q.cleanPrFalsePositiveRate,1);assert.equal(q.prLevelRecall,1/2);assert.equal(q.crossFileRecall,1/2);assert.equal(q.completeDeliveryRate,2/3);assert.equal(r.byArm['text+graph'].cost.totalTokens,null);assert.equal(r.perCase.length,3);
 mapping[0].predictions[1].goldenId=gold.expectedFindings[0].id;assert.throws(()=>score(corpus.cases,runs,mapping),/duplicate golden/);
});
test('location overlap never silently counts as semantic success',()=>{const c=corpus.cases[0];assert.throws(()=>score(corpus.cases,[{runKey:'a',caseId:c.id,arm:'text-only',findings:[{id:'p',evidence:[c.relevantLocation]}]}],[]),/pending/);});
