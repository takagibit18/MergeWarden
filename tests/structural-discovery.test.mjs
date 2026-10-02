import test from 'node:test';
import assert from 'node:assert/strict';
import { investigationGuidance, IMPACT_SYNTHESIS_CHECKPOINT } from '../integrations/pi/src/structural-guidance.ts';
import { discoverySummary, discoveryStop, analyzeConversion, strictEntitySearchEvidence } from '../eval/structural-discovery-analysis.mjs';

test('investigation cards define relation intent and bounded completion without answer-bearing targets',()=>{
 for(const [routeType,relation] of [['CALLER_CHECK','incoming CALLS'],['INHERITANCE_CHECK','INHERITS'],['IMPORT_CHECK','IMPORTS'],['STRUCTURAL_ESCALATION','relation that best matches']]){
  const card=investigationGuidance({routeType,targetHint:'changed_callable'});
  assert.ok(card.includes(relation));
  for(const fragment of ['does not complete','consider at least one traversal','no definite relevant relation','coverage is insufficient','tool fails','budget is exhausted','Do not infer a defect'])assert.ok(card.includes(fragment));
  assert.doesNotMatch(card,/cache\.py|serializer\.py|worker\.py|TypeError|gold|known bug|expected defect/i);
 }
 assert.match(IMPACT_SYNTHESIS_CHECKPOINT,/negative evidence/);
 assert.doesNotMatch(IMPACT_SYNTHESIS_CHECKPOINT,/scratchpad|analysis_report|route_reasoning/);
});
const source={routeId:'route',path:'caller.py',sourceCallId:'source',graphCallId:'graph',discoveryMode:'traversal'};
const fixture=()=>({caseId:'P1-signature-caller',arm:'B',manifest:{metrics:{routing:{activated:1}}},routingState:{observation:{episodes:{route:{R0:true,R1:true,R2:true,R3:true,R4:true}},graphDiscoveredPaths:[source],synthesized:[]}},trace:{sourceLinks:[{strictNovel:true,traverseCallId:'graph',sourceCallId:'source'}],findings:[]},findings:[]});
const relevant=[{...source,relevant:true}];
test('stop rule requires all four first-two-positive B/C slots and checks strict traversal rather than graph counts',()=>{
 const runs=['P1-signature-caller','P2-multihop'].flatMap(caseId=>['B','C'].map(arm=>({...fixture(),caseId,arm,trace:{sourceLinks:[]}})));
 assert.equal(discoveryStop(runs.slice(0,3)),false);assert.equal(discoveryStop(runs),true);
 runs[0]=fixture();assert.equal(discoveryStop(runs),false);
 runs[0].routingState.observation.graphDiscoveredPaths=[];assert.equal(discoveryStop(runs),true);
});
test('relevant source with no finding is missed conversion; irrelevant source is independently F4',()=>{
 const r=fixture();assert.equal(analyzeConversion(r,relevant,[],true).stage,'F5');
 assert.equal(analyzeConversion(r,relevant,[],true).missedConversion,true);
 assert.equal(analyzeConversion(r,[{...source,relevant:false}],[],true).stage,'F4');
});
test('correct changed-only evidence is attribution gap, never graph-assisted success or semantic failure',()=>{
 const r=fixture();r.findings=[{id:'f',evidence:[{path:'app.py'}]}];r.trace.findings=[{predictionId:'f',sourceCallIds:['changed'],discoveryPath:'text_only'}];
 const a=analyzeConversion(r,relevant,[{findingId:'f',correct:true}],true);
 assert.equal(a.stage,'ATTRIBUTION_GAP');assert.equal(a.correctGraphAssisted,0);assert.equal(a.missedConversion,false);
});
test('correctness and immutable novel-source evidence are both necessary for R7',()=>{
 const r=fixture();r.findings=[{id:'f',evidence:[{path:'caller.py'}]}];r.trace.findings=[{predictionId:'f',sourceCallIds:['source'],discoveryPath:'graph_assisted',chains:[{sourceCallId:'source'}]}];
 assert.equal(analyzeConversion(r,relevant,[{findingId:'f',correct:true}],true).stage,'SUCCESS');
 const wrong=analyzeConversion(r,relevant,[{findingId:'f',correct:false}],true);assert.equal(wrong.stage,'F6');assert.equal(wrong.correctGraphAssisted,0);
});
test('clean invalid finding after novel-source verification counts against safety even without novel evidence',()=>{
 const r=fixture();r.findings=[{id:'f',evidence:[{path:'app.py'}]}];r.routingState.observation.synthesized=[JSON.stringify(['route','caller.py'])];
 const a=analyzeConversion(r,relevant,[{findingId:'f',correct:false}],false);
 assert.equal(a.falseConversion,true);assert.equal(a.synthesisFalseConversion,true);assert.equal(a.correctGraphAssisted,0);
});
test('entity search verification is separated from strict traversal',()=>{
 const r=fixture();r.routingState.observation.graphDiscoveredPaths=[{...source,discoveryMode:'entity_search',graphCallId:'search'}];
 const d=discoverySummary(r);assert.equal(d.entitySearchToSource.length,1);assert.equal(d.strict.length,0);
});

test('entity-search conversion requires exact accepted source evidence and excludes competing exposure',()=>{
 const evidence={snapshotId:'snapshot',revision:'head',path:'caller.py',startLine:1,endLine:4,contentSha256:'a'.repeat(64)};
 const f={id:'f',evidence:[evidence]},s={...source,discoveryMode:'entity_search'};
 const r={trace:{traceIssues:[],findings:[{predictionId:'f',submissionCallId:'submit'}],calls:[
  {id:'graph',name:'search_entity',callEvent:1,resultEvent:2,response:{items:[{path:'caller.py'}]}},
  {id:'source',name:'read_source',callEvent:3,resultEvent:4,response:{...evidence,status:'ok'}},
  {id:'submit',name:'submit_review',callEvent:5,resultEvent:6,response:{accepted:true}}
 ]}};
 assert.equal(strictEntitySearchEvidence(r,f,s),true);
 assert.equal(strictEntitySearchEvidence(r,{...f,evidence:[{...evidence,contentSha256:'b'.repeat(64)}]},s),false);
 r.trace.calls.push({id:'text',name:'search_text',resultEvent:2.5,response:{items:[{path:'caller.py'}]}});
 assert.equal(strictEntitySearchEvidence(r,f,s),false);
});
