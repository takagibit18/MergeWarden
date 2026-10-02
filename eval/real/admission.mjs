import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {validateTask} from './adapter.mjs';
import {digest} from './open-label.mjs';
import {safePath,sha256} from '../../src/infrastructure/files.ts';
import {validateHistoryProof} from './scope.mjs';

const fail=message=>{throw Error('Corpus admission: '+message);};
const required=(value,name)=>{if(typeof value!=='string'||!value.trim())fail(name+' missing');};
const sha=(value,name)=>{if(!/^[a-f0-9]{40}$/.test(value??''))fail(name+' must be a full SHA');};
export function validateScope(scope,task) {
 if(!['verified','reconstructed'].includes(scope.scopeStatus))fail('unverified scope');
 if(scope.repo!==task.repository||scope.selectedBaseSha!==task.base_sha||scope.selectedReviewedSha!==task.reviewed_sha)fail('scope/task drift');
 required(scope.sourceInstanceId,'upstream instance');required(scope.selectionReason,'scope rationale');
 sha(scope.publishedBaseSha,'published base');
 if(scope.scopeStatus==='verified'&&(scope.publishedBaseSha!==task.base_sha||scope.publishedReviewedSha!==task.reviewed_sha))fail('exact scope differs from published scope');
 if(scope.scopeStatus==='reconstructed'&&(!scope.firstPrCommit?.parents?.includes(task.base_sha)||!scope.historyVerified))fail('reconstruction needs parent/history verification');
 validateHistoryProof(scope.historyVerified?.baseToHead,task.base_sha,task.reviewed_sha);
 if(scope.scopeStatus==='reconstructed'&&!scope.historyVerified.baseToHead.commits.some(c=>c.sha===scope.firstPrCommit.sha))fail('first PR commit absent from history');
 if(scope.issueIntroducingCommit)validateHistoryProof(scope.historyVerified?.introduction,scope.issueIntroducingCommit,task.reviewed_sha);
 if(scope.fixCommit)validateHistoryProof(scope.historyVerified?.fix,task.reviewed_sha,scope.fixCommit);
 const reviewed=Date.parse(scope.reviewedCommit?.committedAt),comment=Date.parse(scope.reviewCommentTimestamp);
 if(!Number.isFinite(reviewed)||!Number.isFinite(comment)||reviewed>comment)fail('review timeline unresolved');
 if(scope.fixCommit){sha(scope.fixCommit,'fix');const fixed=Date.parse(scope.fixCommitFacts?.committedAt);if(!Number.isFinite(fixed)||fixed<comment||scope.fixCommit===task.reviewed_sha)fail('review-before-fix order');}
}
function anchor(a,name) {
 if(!a)fail(name+' missing');safePath(a.path);
 if(!Number.isInteger(a.startLine)||!Number.isInteger(a.endLine)||a.startLine<1||a.endLine<a.startLine||!/^[a-f0-9]{64}$/.test(a.contentSha256))fail(name+' invalid');
}
export function validateCandidate(c) {
 validateTask(c.task);const s=c.scopeAudit,p=c.profile,a=c.annotation;
 validateScope(s,c.task);
 if(c.id!==c.task.case_id||!['defect','clean'].includes(c.label))fail('candidate identity/label');
 if(!/^[a-f0-9]{64}$/.test(c.source.rowSha256)||s.sourceRowSha256!==c.source.rowSha256)fail('source row drift');
 if(!a||a.status!=='source_reviewed'||!['human','agent'].includes(a.reviewerKind)||!a.reviewer||!a.reviewedAt||!a.rationale)fail('source audit incomplete');
 if(a.reviewerKind==='agent'&&a.humanReviewed!==false)fail('agent audit must not claim human review');
 if(a.independentOfModelResults!==true||a.independentOfGraphCoverage!==true)fail('selection contaminated by results');
 if(!p.snapshotMaterializable||!p.reviewable||p.baseSha!==c.task.base_sha||p.reviewedSha!==c.task.reviewed_sha||!Number.isInteger(p.minimumCoverageToolCalls)||p.minimumCoverageToolCalls<2)fail('snapshot/profile not ready');
 if(p.scaleClass==='large-pr-stress')fail('large-pr-stress belongs outside formal/reserve pool');
 if(!c.pythonAnchors?.length)fail('no Python anchor');for(const x of c.pythonAnchors){anchor(x,'Python anchor');if(!x.path.endsWith('.py'))fail('no Python anchor');}
 const changed=new Set(p.changedPathList);
 if(!c.pythonAnchors.some(x=>changed.has(x.path)))fail('Python anchor not in reviewed change');
 if(!c.evidenceVerification?.verified||c.evidenceVerification.taskSha256!==digest(c.task)||c.evidenceVerification.anchorsSha256!==digest([c.pythonAnchors,c.goldenFindings,c.contextEvidence]))fail('source evidence verification missing/stale');
 if(c.label==='defect'){
  sha(s.issueIntroducingCommit,'introducing commit');if(s.issueIntroducingCommit===c.task.base_sha)fail('introduction is base');
  if(!/^F\.[1-6](?: |$)/.test(c.source.functionalCategory??'')&&!c.annotation.independentlyEstablishedFunctionalDefect)fail('non-functional positive');
  if(!c.goldenFindings?.length)fail('no gold findings');
  if(!['local','untouched_1hop','multi_hop','project_invariant','unknown'].includes(c.navigationRequirement))fail('navigation annotation missing');
  for(const g of c.goldenFindings){
   for(const k of ['claim','trigger','incorrectBehavior','impact','introductionRationale'])required(g[k],k);
   if(!['low','medium','high','critical'].includes(g.severity))fail('severity invalid');
   anchor(g.sourceAnchor,'finding anchor');if(!g.sourceAnchor.path.endsWith('.py')||!changed.has(g.sourceAnchor.path))fail('defect requires changed Python anchor');
   if(!g.reviewEvidence?.text||!g.reviewEvidence.source||!g.reviewEvidence.timestamp)fail('reviewer evidence missing');
   if(!['A','B','C'].includes(g.confidence))fail('confidence invalid');
   if(['A','B'].includes(g.confidence)){sha(g.fixSha,'fix');if(g.fixSha!==s.fixCommit||!g.fixEvidence?.rationale||!g.fixEvidence.verifiedSourceHash||!g.fixEvidence.sourceAnchor)fail('fix evidence missing');anchor(g.fixEvidence.sourceAnchor,'fix anchor');}
   if(g.confidence==='A'&&!g.externalTestProvenance?.testEvidenceSha256)fail('A needs explicit external test verification, not dataset membership');
  }
  if(c.navigationRequirement!=='local'&&c.navigationRequirement!=='unknown'){
   if(!c.contextEvidence?.length||!c.navigationRationale)fail('untouched context proof missing');
   for(const e of c.contextEvidence){anchor(e,'context');required(e.role,'context role');if(changed.has(e.path))fail('context is changed, not untouched');}
  }
 }else{
  if(c.goldenFindings?.length||c.source.changeIntroduced!==false||c.source.confirmedChanges!==0||a.knownFunctionalDefect!==false)fail('clean gate failed');
  if(c.cleanMeaning!=='no confirmed introduced functional defect under the available review evidence')fail('clean wording overclaims');
  if(!['compensating','behavior_looking_refactor','cross_file_safe','large_repo_small_diff'].includes(c.cleanCategory))fail('clean category');
 }
 return c;
}
export function validateSelection(pool,formalIds,reserveIds,{seenPRs=[]}={}) {
 const byId=new Map(pool.map(c=>[c.id,c]));if(byId.size!==pool.length)fail('duplicate pool ID');
 const prs=new Set();for(const c of pool){validateCandidate(c);const k=c.task.repository.toLowerCase()+'#'+c.scopeAudit.prNumber;if(prs.has(k))fail('duplicate PR');prs.add(k);}
 if(pool.filter(c=>c.label==='defect').length<30||pool.filter(c=>c.label==='clean').length<24)fail('approved pool needs 30 defect and 24 clean');
 if(formalIds.length!==40||reserveIds.length<6||reserveIds.length>8||new Set([...formalIds,...reserveIds]).size!==formalIds.length+reserveIds.length)fail('formal/reserve count or overlap');
 const select=ids=>ids.map(id=>{if(!byId.has(id))fail('unknown approved case');return byId.get(id);});
 const formal=select(formalIds),reserve=select(reserveIds),counts=new Map();
 if(formal.filter(c=>c.label==='defect').length!==24||formal.filter(c=>c.label==='clean').length!==16)fail('24/16 exact count');
 for(const c of formal){const r=c.task.repository.toLowerCase();counts.set(r,(counts.get(r)??0)+1);if(seenPRs.includes(r+'#'+c.scopeAudit.prNumber))fail('seen pilot cannot enter holdout');}
 if(counts.size<6||Math.max(...counts.values())>6)fail('repository quota');
 const defects=formal.filter(c=>c.label==='defect');
 if(defects.filter(c=>c.goldenFindings.every(g=>['A','B'].includes(g.confidence))).length<20)fail('need 20 A/B defect cases');
 if(defects.filter(c=>['untouched_1hop','multi_hop','project_invariant'].includes(c.navigationRequirement)).length<12)fail('need 12 untouched context defects');
 return {formal,reserve,repositoryCounts:Object.fromEntries(counts)};
}
export async function freezeCorpus(directory,pool,formalIds,reserveIds,{upstreamSources,seenPRs}={}) {
 const selected=validateSelection(pool,formalIds,reserveIds,{seenPRs});
 await mkdir(directory); // Never overwrite an earlier freeze.
 const payloads={
  'public/tasks.jsonl':selected.formal.map(c=>c.task),
  'hidden/gold.jsonl':selected.formal.map(c=>({id:c.id,label:c.label,goldenFindings:c.goldenFindings,navigationRequirement:c.navigationRequirement,contextEvidence:c.contextEvidence,cleanCategory:c.cleanCategory})),
  'audit/receipts.jsonl':pool,
  'reserve/tasks.jsonl':selected.reserve.map(c=>c.task)
 };
 const files={};for(const [path,rows] of Object.entries(payloads)){await mkdir(join(directory,path,'..'),{recursive:true});const bytes=rows.map(x=>JSON.stringify(x)).join('\n')+'\n';await writeFile(join(directory,path),bytes,{flag:'wx'});files[path]=sha256(bytes);}
 const lock={schemaVersion:1,corpusId:'mergewarden-real-python40-v1',status:'corpus_frozen_pilot_pending',files,upstreamSources,seenPRs,formalIds,reserveIds,approvedPoolIds:pool.map(c=>c.id),repositoryCounts:selected.repositoryCounts};
 lock.corpusSha256=digest(lock);await writeFile(join(directory,'corpus.lock.json'),JSON.stringify(lock,null,2)+'\n',{flag:'wx'});return lock;
}
export async function verifyBundle(directory,{publicOnly=false}={}) {
 const lock=JSON.parse(await readFile(join(directory,'corpus.lock.json'),'utf8')),base={...lock};delete base.corpusSha256;
 if(lock.corpusSha256!==digest(base))fail('corpus lock drift');
 const expectedFiles=['public/tasks.jsonl','reserve/tasks.jsonl','hidden/gold.jsonl','audit/receipts.jsonl'];
 if(!lock.files||digest(Object.keys(lock.files).sort())!==digest(expectedFiles.sort()))fail('frozen file manifest incomplete');
 const keys=publicOnly?['public/tasks.jsonl','reserve/tasks.jsonl']:expectedFiles;
 const data={};for(const name of keys){safePath(name);const bytes=await readFile(join(directory,name));if(sha256(bytes)!==lock.files[name])fail('frozen file drift');data[name]=bytes.toString().trim().split('\n').map(JSON.parse);}
 if(!publicOnly){
  const {formal,reserve}=validateSelection(data['audit/receipts.jsonl'],lock.formalIds,lock.reserveIds,{seenPRs:lock.seenPRs});
  if(digest(formal.map(c=>c.task))!==digest(data['public/tasks.jsonl'])||digest(reserve.map(c=>c.task))!==digest(data['reserve/tasks.jsonl']))fail('public task/audit drift');
  const expectedGold=formal.map(c=>({id:c.id,label:c.label,goldenFindings:c.goldenFindings,navigationRequirement:c.navigationRequirement,contextEvidence:c.contextEvidence,cleanCategory:c.cleanCategory}));
  if(digest(expectedGold)!==digest(data['hidden/gold.jsonl']))fail('hidden gold/audit drift');
 }
 if(digest(data['public/tasks.jsonl'].map(t=>t.case_id))!==digest(lock.formalIds)||digest(data['reserve/tasks.jsonl'].map(t=>t.case_id))!==digest(lock.reserveIds))fail('public task list drift');
 for(const key of ['public/tasks.jsonl','reserve/tasks.jsonl'])data[key].forEach(validateTask);
 return {lock,data};
}
