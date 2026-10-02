import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateCandidate,validateScope,validateSelection,freezeCorpus,verifyBundle} from '../eval/real/admission.mjs';
import {digest} from '../eval/real/open-label.mjs';
const anchor={path:'lib.py',startLine:1,endLine:2,contentSha256:'a'.repeat(64)};
function fixture(i,label='defect'){
 const repository='owner/repo'+(i%10),id='case-'+i,task={case_id:id,repository,repository_url:`https://github.com/${repository}.git`,base_sha:'a'.repeat(40),reviewed_sha:'b'.repeat(40),language:'Python',review_context_policy:'repository'};
 const c={id,task,label,source:{rowSha256:'f'.repeat(64),functionalCategory:'F.2 Logic',changeIntroduced:false,confirmedChanges:0},annotation:{status:'source_reviewed',reviewerKind:'agent',reviewer:'synthetic unit test',reviewedAt:'2026-01-01',rationale:'Test fixture, not real annotation',humanReviewed:false,independentOfModelResults:true,independentOfGraphCoverage:true,knownFunctionalDefect:false},scopeAudit:{repo:repository,prNumber:i,publishedBaseSha:task.base_sha,selectedBaseSha:task.base_sha,selectedReviewedSha:task.reviewed_sha,scopeStatus:'verified',sourceInstanceId:'source-'+i,sourceRowSha256:'f'.repeat(64),selectionReason:'fixture',reviewedCommit:{committedAt:'2020-01-01'},reviewCommentTimestamp:'2020-01-02',fixCommit:'c'.repeat(40),fixCommitFacts:{committedAt:'2020-01-03'}},profile:{snapshotMaterializable:true,reviewable:true,baseSha:task.base_sha,reviewedSha:task.reviewed_sha,minimumCoverageToolCalls:3,scaleClass:'standard',changedPathList:['lib.py']},pythonAnchors:[anchor],goldenFindings:label==='defect'?[{id:'g1',claim:'wrong result',trigger:'input',incorrectBehavior:'wrong',impact:'output',introductionRationale:'new branch',severity:'medium',sourceAnchor:anchor,reviewEvidence:{text:'review',source:'source',timestamp:'2020-01-02'},confidence:'B',fixSha:'c'.repeat(40),fixEvidence:{rationale:'fixed branch',verifiedSourceHash:anchor.contentSha256,sourceAnchor:anchor}}]:[],navigationRequirement:'untouched_1hop',navigationRationale:'consumer contract',contextEvidence:[{...anchor,path:'caller.py',role:'consumer'}],cleanMeaning:'no confirmed introduced functional defect under the available review evidence',cleanCategory:'cross_file_safe'};
 const facts=(sha,parents)=>({sha,parents,committedAt:'2020-01-01',contentSha256:'e'.repeat(64)});
 const chain=(ancestor,descendant)=>{const commits=ancestor===descendant?[facts(descendant,[])]:[facts(descendant,[ancestor]),facts(ancestor,[])];return {ancestor,descendant,commits,sha256:digest(commits)};};
 c.scopeAudit.publishedReviewedSha=task.reviewed_sha;c.scopeAudit.issueIntroducingCommit=task.reviewed_sha;
 c.scopeAudit.firstPrCommit=facts(task.reviewed_sha,[task.base_sha]);
 c.scopeAudit.historyVerified={baseToHead:chain(task.base_sha,task.reviewed_sha),introduction:chain(task.reviewed_sha,task.reviewed_sha),fix:chain(task.reviewed_sha,c.scopeAudit.fixCommit)};
 c.evidenceVerification={verified:true,taskSha256:digest(task),anchorsSha256:digest([c.pythonAnchors,c.goldenFindings,c.contextEvidence])};return c;
}
test('scope validates exact and reconstructed history, rejects ambiguity and temporal inversion',()=>{
 const c=fixture(1);validateScope(c.scopeAudit,c.task);
 assert.throws(()=>validateScope({...c.scopeAudit,scopeStatus:'ambiguous'},c.task),/unverified/);
 assert.throws(()=>validateScope({...c.scopeAudit,fixCommitFacts:{committedAt:'2019-01-01'}},c.task),/before-fix/);
 assert.throws(()=>validateScope({...c.scopeAudit,scopeStatus:'reconstructed',historyVerified:null},c.task),/history/);
 validateScope({...c.scopeAudit,scopeStatus:'reconstructed'},c.task);
 assert.throws(()=>validateScope({...c.scopeAudit,historyVerified:true},c.task),/history/);
 assert.throws(()=>validateScope({...c.scopeAudit,publishedReviewedSha:'d'.repeat(40)},c.task),/exact scope/);
});
test('candidate gates reject nonfunctional, no Python, missing reviewer and missing behavior',()=>{
 const c=fixture(1);validateCandidate(c);
 for(const mutate of [x=>x.source.functionalCategory='E.3 Style',x=>x.pythonAnchors=[],x=>x.goldenFindings[0].reviewEvidence=null,x=>x.goldenFindings[0].trigger='',x=>x.annotation.humanReviewed=true,x=>x.profile.snapshotMaterializable=false]){
  const x=structuredClone(c);mutate(x);x.evidenceVerification.anchorsSha256=digest([x.pythonAnchors,x.goldenFindings,x.contextEvidence]);assert.throws(()=>validateCandidate(x));
 }
});
const pool=()=>Array.from({length:54},(_,i)=>fixture(i,i<30?'defect':'clean'));
const formal=[...Array.from({length:24},(_,i)=>'case-'+i),...Array.from({length:16},(_,i)=>'case-'+(i+30))];
const reserve=Array.from({length:6},(_,i)=>'case-'+(i+24));
test('formal quotas, redundant approved pool, and permanent seen/reserve exclusion',()=>{
 validateSelection(pool(),formal,reserve);
 assert.throws(()=>validateSelection(pool().slice(0,53),formal,reserve),/approved pool/);
 assert.throws(()=>validateSelection(pool(),formal.slice(1),reserve),/count/);
 assert.throws(()=>validateSelection(pool(),formal,[...reserve.slice(1),'case-0']),/overlap/);
 assert.throws(()=>validateSelection(pool(),formal,reserve,{seenPRs:['owner/repo0#0']}),/seen pilot/);
 const p=pool();p[1].scopeAudit.prNumber=0;p[1].task={...p[0].task,case_id:p[1].id};p[1].scopeAudit.repo=p[0].task.repository;p[1].evidenceVerification.taskSha256=digest(p[1].task);assert.throws(()=>validateSelection(p,formal,reserve),/duplicate PR/);
 const concentrated=pool();for(const c of concentrated){c.task.repository='one/repo';c.task.repository_url='https://github.com/one/repo.git';c.scopeAudit.repo='one/repo';c.evidenceVerification.taskSha256=digest(c.task);}assert.throws(()=>validateSelection(concentrated,formal,reserve),/quota/);
 const local=pool();for(const c of local)c.navigationRequirement='local';assert.throws(()=>validateSelection(local,formal,reserve),/12 untouched/);
});
test('freeze hash is deterministic, bundle verifies all files, and public tasks contain no gold',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mw-real-freeze-')),one=join(root,'one'),two=join(root,'two');
 const a=await freezeCorpus(one,pool(),formal,reserve,{upstreamSources:{fixture:'not a real corpus'},seenPRs:[]});const b=await freezeCorpus(two,pool(),formal,reserve,{upstreamSources:{fixture:'not a real corpus'},seenPRs:[]});assert.equal(a.corpusSha256,b.corpusSha256);
 const {data}=await verifyBundle(one);assert.equal(data['public/tasks.jsonl'].length,40);assert.equal(data['hidden/gold.jsonl'].length,40);
 assert.ok(!('label' in data['public/tasks.jsonl'][0]));
 const publicOnly=await verifyBundle(one,{publicOnly:true});assert.deepEqual(Object.keys(publicOnly.data).sort(),['public/tasks.jsonl','reserve/tasks.jsonl']);
 await writeFile(join(one,'public/tasks.jsonl'),'{}\n');await assert.rejects(verifyBundle(one),/drift/);
});
test('committed RealGolden bundle has an audited redundant pool and disjoint model reserve',async()=>{
 const {lock,data}=await verifyBundle(fileURLToPath(new URL('../eval/real/corpora/mergewarden-real-python40-v1/',import.meta.url)));
 assert.equal(lock.formalIds.length,40);assert.equal(lock.reserveIds.length,6);assert.equal(data['audit/receipts.jsonl'].filter(c=>c.label==='defect').length,35);assert.equal(data['audit/receipts.jsonl'].filter(c=>c.label==='clean').length,25);
 assert.ok(data['public/tasks.jsonl'].every(t=>/^RG2-[a-f0-9]{12}$/.test(t.case_id)));
 assert.ok(data['audit/receipts.jsonl'].every(c=>c.annotation.reviewerKind==='agent'&&c.annotation.humanReviewed===false));
});
