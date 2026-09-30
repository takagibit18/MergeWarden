import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLearningContext, learningJsonBytes, LEARNING_CONTEXT_LIMITS, LEARNING_CONTEXT_VERSION } from '../src/skills/learning-context.ts';
import { learningIdentity } from '../src/skills/identity.ts';
import { digest } from '../src/skills/bank.ts';
import { SKILL_POLICY } from '../src/skills/contracts.ts';
const source={id:'run:current',eventId:'run:current',version:1,repositoryKey:'repo:a',runId:'current',snapshotId:'a'.repeat(64),reportSha256:'b'.repeat(64),kind:'run',independenceKey:'c'.repeat(64),identity:'review_runtime',trust:'observed',simulated:false,withdrawn:false,createdAt:'2026-09-30T00:00:00Z'};
const base=()=>({policy:SKILL_POLICY,source,report:{status:'completed',summary:'score_family handles empty families and fallback ranking',findings:[]},sourcePages:[{path:'font.py',text:'def score_family(families): return 1 / len(families)',fileHash:'d'.repeat(64)}],toolEvents:[],fixedRules:'Keep current evidence and completion rules.',bankSnapshotId:'e'.repeat(64)});
const skill=(id,extra={})=>({id,revision:1,owner:'learner',repositoryKey:'repo:a',state:'trial',sources:[],createdAt:source.createdAt,contentSha256:'f'.repeat(64),scopeType:'review_method',type:'review_procedure',title:'Trace scoring inputs',conditions:['When ranking changes'],steps:['Inspect the input boundary.','Trace scoring and consumer calls.'],counterexamples:['Empty values may be rejected.'],stopConditions:['Stop if the boundary excludes empty lists.'],paths:['font.py'],languages:['Python'],keywords:['score_family'],symbols:[],dependencies:[],...extra});

test('learning relevance outranks IDs, compares method/fact, and respects repository/explicit language boundaries',()=>{
 const skills=[skill('sk_a',{paths:['else.py'],keywords:[],title:'Unrelated task',conditions:['Unrelated work']}),skill('sk_z',{scopeType:'repository_fact',type:'repo_contract',symbols:['score_family'],keywords:['score_family','families','fallback']}),skill('sk_other',{repositoryKey:'repo:b'}),skill('sk_js',{languages:['JavaScript']}),skill('sk_unknown',{languages:[]})];
 const result=selectLearningContext(base(),skills);assert.equal(result.existingSkills.catalog[0].id,'sk_z');assert.equal(result.existingSkills.candidateCount,3);assert.equal(result.existingSkills.rankedCount,2);assert(!result.existingSkills.catalog.some(c=>c.id==='sk_a'));assert.deepEqual(selectLearningContext(base(),[...skills].reverse()),result);assert.equal(SKILL_POLICY,'review-skills-2');assert.equal(result.existingSkills.version,LEARNING_CONTEXT_VERSION);
 const unknown=base();unknown.sourcePages=[{path:'NOTES',text:'score_family'}];assert(selectLearningContext(unknown,[skill('sk_any',{languages:['Rust']})]).existingSkills.candidateCount===1);
});

test('catalog and full bodies are separate; catalog-only opaque refs grant no update authority',()=>{
 const result=selectLearningContext(base(),Array.from({length:10},(_,i)=>skill(`sk_${i}`)));assert.equal(result.existingSkills.catalog.length,8);assert.equal(result.relevantSkills.length,3);assert.equal(result.existingSkills.catalogOmittedCount,2);assert.equal(result.existingSkills.bodyOmittedCount,7);
 const identity=learningIdentity(result),catalog=identity.visible.existingSkills.catalog;assert.equal(catalog.filter(c=>c.bodyProvided).length,3);assert(catalog.filter(c=>c.readOnly).every(c=>!c.bodyProvided));assert(!JSON.stringify(identity.visible).includes('sk_0'));
 const readOnly=catalog.find(c=>!c.bodyProvided);for(const op of ['revise','attach_source','retire'])assert.throws(()=>identity.resolve({operations:[{op,targetRef:readOnly.ref,sourceRefs:[identity.visible.source.ref],reason:'Summary alone'}]}),/Unknown/);
 const full=catalog.find(c=>c.bodyProvided);assert(identity.visible.relevantSkills.some(s=>s.ref===full.ref));assert.equal(identity.resolve({operations:[{op:'attach_source',targetRef:full.ref,sourceRefs:[identity.visible.source.ref],reason:'Bound source'}]}).operations[0].id,result.relevantSkills[0].id);
 const original=structuredClone(result);result.relevantSkills.pop();assert.throws(()=>identity.resolve({operations:[{op:'noop',reason:'none'}]},result),/hash mismatch/);assert.throws(()=>learningIdentity(result),/catalog\/body/);assert.equal(original.relevantSkills.length,3);
});

test('UTF-8 budgets preserve evidence/rules, flag extracted summary truncation, and never truncate bodies',()=>{
 const b=base();b.fixedRules='规则与证据不可删除。'.repeat(900);b.sourcePages[0].text='当前证据\n"\\'.repeat(400);const skills=Array.from({length:8},(_,i)=>skill(`sk_${i}`,{conditions:['scoring '+ '触发'.repeat(140),'Other boundary','Third trigger'],steps:['调查'.repeat(230),'核对'.repeat(230)],counterexamples:['仅当调用方排除该值'],stopConditions:['否则保留不确定性']}));
 const saved=structuredClone(b),input=selectLearningContext(b,skills),identity=learningIdentity(input);assert.deepEqual(b,saved);assert.deepEqual(input.sourcePages,b.sourcePages);assert.equal(input.fixedRules,b.fixedRules);assert(learningJsonBytes(input)<=40000);assert(learningJsonBytes(identity.visible)<=40000);assert(learningJsonBytes({existingSkills:input.existingSkills,relevantSkills:input.relevantSkills})<=LEARNING_CONTEXT_LIMITS.contextBytes);assert(input.existingSkills.catalog.every(c=>c.summaryTruncated));for(const s of input.relevantSkills)assert.deepEqual(s,skills.find(o=>o.id===s.id));assert.throws(()=>selectLearningContext({...b,fixedRules:'界'.repeat(14000)},skills),/byte limit/);
});

test('external and inactive entries remain awareness-only; support and old dependency coverage are explicit',()=>{
 const ref=digest(source),old=skill('sk_old',{sources:[ref],dependencies:[{path:'missing.py',hash:'9'.repeat(64)}]});const entries=[old,skill('sk_ext',{owner:'external'}),skill('sk_retired',{state:'retired'}),skill('sk_quarantined',{state:'quarantined'})],input=selectLearningContext(base(),entries,{[ref]:source});assert.deepEqual(input.relevantSkills.map(s=>s.id),['sk_old']);const c=input.existingSkills.catalog.find(c=>c.id==='sk_old');assert.deepEqual(c.support,{currentSource:true,sameSnapshot:true,sameIndependenceKey:true});assert.equal(c.dependenciesAvailable,false);
 for(const e of input.existingSkills.catalog.filter(c=>c.id!=='sk_old'))assert(e.readOnly&&!e.bodyProvided);
 for(const state of ['retired','quarantined']){const i={...base(),relevantSkills:[skill('sk_blocked',{state})]},x=learningIdentity(i);assert.throws(()=>x.resolve({operations:[{op:'attach_source',targetRef:x.visible.relevantSkills[0].ref,sourceRefs:[x.visible.source.ref],reason:'must not revive'}]}),/mutable/);}
});
