import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {read,save,identity,checkIdentities} from './candidate-dataset-context.mjs';
import {graphData} from './frontier-data.mjs';
import {STRUCTURAL_PATTERNS} from '../src/experiments/locagent/patterns.ts';

// Target-aware validation of already-frozen relation facts, NOT an online search
// or an estimate of what bounded dispatch would actually return.
export function frozenPathProof(data,anchor,targets){
  const overlap=(e,r)=>e.path===r.path&&e.startLine<=r.endLine&&e.endLine>=r.startLine;
  const candidates=r=>{const symbols=data.symbols.filter(e=>['class','function'].includes(e.kind)&&overlap(e,r));return symbols.length?symbols:data.symbols.filter(e=>e.kind==='file'&&overlap(e,r));};
  const possible=candidates(anchor),best=Math.min(...possible.map(e=>e.endLine-e.startLine));
  const roots=possible.filter(e=>e.endLine-e.startLine===best),rootIds=new Set(roots.map(e=>e.id));
  const incoming=new Map(),outgoing=new Map();for(const e of data.relations){if(!['resolved_scoped','resolved_import_alias'].includes(e.resolution))continue;(incoming.get(e.toId)??incoming.set(e.toId,[]).get(e.toId)).push(e);(outgoing.get(e.fromId)??outgoing.set(e.fromId,[]).get(e.fromId)).push(e);}
  const proofs=targets.map(target=>{
    const entities=candidates(target),ids=new Set(entities.map(e=>e.id));let proof=null;
    for(const root of roots)for(const pattern of STRUCTURAL_PATTERNS){let frontier=[{id:root.id,entityIds:[root.id],edges:[]}];for(const step of pattern.steps){const next=[];for(const p of frontier)for(const edge of(step.direction==='upstream'?incoming:outgoing).get(p.id)??[]){if(!step.relations.includes(edge.relation))continue;const id=step.direction==='upstream'?edge.fromId:edge.toId;if(p.entityIds.includes(id))continue;const q={id,entityIds:[...p.entityIds,id],edges:[...p.edges,{edgeId:edge.id,relation:edge.relation,direction:step.direction,resolution:edge.resolution}]};if(ids.has(id)&&!rootIds.has(id)){if(!proof||q.edges.length<proof.edges.length)proof={...q,patternId:pattern.id};}next.push(q);}frontier=[...new Map(next.map(n=>[n.id,n])).values()];}}
    return {target,matchingEntities:entities.map(e=>({id:e.id,name:e.qualifiedName,path:e.path,startLine:e.startLine,endLine:e.endLine})),pathExists:!!proof,proof};
  });return {rootCandidates:roots.map(e=>({id:e.id,name:e.qualifiedName,path:e.path,startLine:e.startLine,endLine:e.endLine})),targets:proofs,anyRelevantPathExists:proofs.some(p=>p.pathExists),allRangesHavePath:proofs.every(p=>p.pathExists),meaning:'Existential audit with known target over immutable facts, no new graph build, no retrieval A/B, no bounded-search success claim. Range overlap is a mapping aid; matching entities and exact edges are exposed for judgment.'};
}
export async function collectPrivate(out){
  const freeze=await read(join(out,'phase-a-v2/diagnostic-freeze.json'));assert.ok(freeze.allCasesComplete);await checkIdentities(freeze.files);
  assert.ok(process.permission);assert.equal(process.permission.has('fs.write',join(out,'phase-a-v2')),false);
  const workspace=resolve(out,'../..'),corpus=join(workspace,'output/realgolden40-closure/corpus-v1-final'),goldPath=join(corpus,'hidden/gold.jsonl'),auditPath=join(corpus,'audit/receipts.jsonl');
  const gold=(await readFile(goldPath,'utf8')).trim().split(/\r?\n/).map(JSON.parse),audit=(await readFile(auditPath,'utf8')).trim().split(/\r?\n/).map(JSON.parse),{plans}=await read(join(out,'universe.json'));
  await save(join(out,'phase-b/private-input-identities.json'),{freeze:await identity(join(out,'phase-a-v2/diagnostic-freeze.json')),sources:[await identity(goldPath),await identity(auditPath)],labelsAreAgentDevelopmentJudgments:true});
  const rows=[];
  for(const p of plans){const g=gold.find(g=>g.id===p.caseId),a=audit.find(a=>a.id===p.caseId);assert.ok(g&&a);let graphProof=null;
    if(g.label==='defect'){const data=await graphData(p);graphProof={generationState:data.generationState,coverage:data.coverage,...frozenPathProof(data,g.goldenFindings[0].sourceAnchor,g.contextEvidence)};}
    rows.push({caseId:p.caseId,group:p.group,label:g.label,claim:g.goldenFindings?.[0]?.claim??null,introductionRationale:g.goldenFindings?.[0]?.introductionRationale??null,changedAnchor:g.goldenFindings?.[0]?.sourceAnchor??null,requiredUntouched:g.contextEvidence,cleanCategory:g.cleanCategory??null,existingAuditRationale:a.annotation.rationale,graphProof});
    console.log(JSON.stringify({caseId:p.caseId,path:graphProof?.anyRelevantPathExists??null}));
  }
  await save(join(out,'phase-b/private-material.json'),rows);await checkIdentities(freeze.files);
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))await collectPrivate(resolve(process.argv[2]));
