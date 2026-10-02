import {readFile,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {buildInvestigationQuery} from '../src/experiments/locagent/investigation-query.ts';
import {rankCandidateRelevance,selectRelevance} from '../src/experiments/locagent/candidate-relevance.ts';
import {selectHybrid} from '../src/experiments/locagent/hybrid-selector.ts';
import {selectPathCoverage,derivePathCoverage,pathCoverageMetrics} from '../src/experiments/locagent/path-coverage.ts';
const out=resolve(process.argv[2]),read=async p=>JSON.parse(await readFile(p,'utf8')),hash=b=>createHash('sha256').update(b).digest('hex'),save=(n,v)=>writeFile(join(out,n),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const ids=await read(join(out,'frozen-inputs.json')),protocol=await read(join(out,'protocol.json')),queries=await read(join(out,'investigation-query.json')),observations=await read(join(out,'preselection-observations.json')),qfreeze=await read(join(out,'query-freeze.json'));
assert.ok(process.permission);assert.ok(global.gc,'Run --expose-gc');
for(const i of ids)if(['frozen online input','frozen implementation'].includes(i.role))assert.equal(hash(await readFile(i.path)),i.sha256);else assert.equal(process.permission.has('fs.read',i.path),false);
for(const f of qfreeze.artifacts)assert.equal(hash(await readFile(join(out,f.name))),f.sha256);
assert.equal(hash(await readFile(new URL('../src/experiments/locagent/investigation-query.ts',import.meta.url))),qfreeze.sourceSha256);
const get=async suffix=>read(ids.find(i=>i.path.replaceAll('\\','/').endsWith(suffix)).path);
const pools=await get('/path-coverage-candidate-selection-20260925/eligible-pools.json'),priorA=await get('/path-coverage-candidate-selection-20260925/arm-b-selection.json'),retained=await get('/arm-b-traces/candidate-replay.json');
const codeFiles=['src/experiments/locagent/investigation-query.ts','src/experiments/locagent/candidate-relevance.ts','src/experiments/locagent/hybrid-selector.ts','src/experiments/locagent/path-coverage.ts','src/experiments/locagent/sparse.ts','eval/hybrid-candidate-diagnostic.mjs'];
const implementation=[],staticChecks=[];
for(const file of codeFiles){const bytes=await readFile(new URL('../'+file,import.meta.url));implementation.push({file,sha256:hash(bytes)});if(file.startsWith('src/')&&!file.endsWith('/sparse.ts')){const forbidden=/merge_attrs|_encode_coordinates|_ensure_no_complex_data|to_cnf|\b[a-f0-9]{64}\b|private[\\/]|audit\.json|node:fs|read_source|GraphData\.sources/i;staticChecks.push({file,pass:!forbidden.test(bytes.toString())});}}
assert.ok(staticChecks.every(c=>c.pass));await save('leakage-audit.json',{staticChecks,pass:true,nodePermissionModel:true,privateAuditReadable:false,priorScoreReadable:false,sourceRepositoryReadable:false,scope:'Deny all target-name literals and all 64-hex literal IDs in query/selector implementation; target labels never loaded',graphBackendRequests:0,sourceReads:0,realModelCalls:0});
const A=[],baseline=[];
for(const p of pools){const selection=selectPathCoverage(p.eligible,p.context,protocol.coverage.patternLengths,p.importTemplateOrder),old=priorA.find(r=>r.id===p.id).selection;assert.equal(JSON.stringify(selection),JSON.stringify(old));A.push({id:p.id,selection});baseline.push({id:p.id,byteIdentical:true,eligiblePoolHash:p.eligiblePoolHash});}
await save('baseline-reproduction.json',{pass:true,checks:baseline});await save('arm-a-selection.json',A);
const B=[],C=[],documents=[],relevance=[],reasons=[],metrics=[],perfs=[],stability=[];
const longest=xs=>{let n=0,m=0;for(let i=1;i<xs.length;i++){n=xs[i]>xs[i-1]?n+1:0;m=Math.max(m,n);}return m;};
const summary=xs=>{const v=[...xs].sort((a,b)=>a-b);return {p50:v[Math.ceil(v.length*.5)-1],p95:v[Math.ceil(v.length*.95)-1],max:v.at(-1)};};
for(const p of pools){
 const obs=observations.find(r=>r.id===p.id).observations,q=queries.find(r=>r.id===p.id),entities=[...new Map(retained.find(r=>r.id===p.id).retained.states.map(s=>{const e=s.entity;return [e.id,{id:e.id,snapshotId:e.snapshotId,name:e.name,qualifiedName:e.qualifiedName,path:e.path}];})).values()];
 const run=(pool,arm)=>{const start=performance.now(),query=buildInvestigationQuery(obs),tq=performance.now(),ranking=rankCandidateRelevance(pool,entities,query.query,protocol.coverage.patternLengths),tr=performance.now(),selection=(arm==='B'?selectRelevance:selectHybrid)(pool,p.context,ranking,protocol.coverage.patternLengths,p.importTemplateOrder),end=performance.now();return {result:{query,ranking,selection},times:{queryBuildMs:tq-start,indexSearchMs:tr-tq,selectionMs:end-tr,endToEndMs:end-start}};};
 assert.equal(hash(JSON.stringify(p.eligible)),p.eligiblePoolHash);
 const first=run(p.eligible,'C').result;const {id:queryId,observationLimit,...frozenQuery}=q;assert.equal(JSON.stringify(first.query),JSON.stringify(frozenQuery));
 const armb=run(p.eligible,'B').result;const expected={B:JSON.stringify(armb),C:JSON.stringify(first)};
 for(const arm of ['B','C']){
  const hashes=new Set(),orders=[p.eligible,[...p.eligible].reverse(),[...p.eligible.filter((_,i)=>i%2===0),...p.eligible.filter((_,i)=>i%2===1)]];
  for(let i=0;i<100;i++)for(const order of orders){const s=JSON.stringify(run(order,arm).result);assert.equal(s,expected[arm]);hashes.add(hash(s));}
  stability.push({id:p.id,arm,repeatsPerOrder:100,orders:3,byteStable:hashes.size===1,sha256:[...hashes][0]});
  const times={queryBuildMs:[],indexSearchMs:[],selectionMs:[],endToEndMs:[]},heap=[],rss=[];
  for(let i=0;i<1000;i++){const r=run(p.eligible,arm);assert.equal(JSON.stringify(r.result),expected[arm]);for(const key of Object.keys(times))times[key].push(r.times[key]);if(i%10===0){global.gc();heap.push(process.memoryUsage().heapUsed);rss.push(process.memoryUsage().rss);}}
  const latency=Object.fromEntries(Object.entries(times).map(([k,v])=>[k,summary(v)])),memory={heap,rss,heapGrowthBytes:heap.at(-1)-heap[0],longestMonotonicHeapIncrease:longest(heap),longestMonotonicRssIncrease:longest(rss)};
  const result=arm==='B'?armb:first;const perf={id:p.id,arm,replays:1000,latency,candidateDocumentBytes:Buffer.byteLength(JSON.stringify(result.ranking.documents)),indexBytesProxy:Buffer.byteLength(JSON.stringify({documents:result.ranking.documents.map(d=>d.text),stats:result.ranking.indexStats})),temporaryBytesProxy:Buffer.byteLength(expected[arm]),memory};perf.pass=latency.endToEndMs.p95<=protocol.performance.p95LimitMs&&memory.heapGrowthBytes<=protocol.performance.heapGrowthLimitBytes&&memory.longestMonotonicHeapIncrease<protocol.performance.maxConsecutivePostGcGrowth;perfs.push(perf);
 }
 assert.equal(hash(JSON.stringify(p.eligible)),p.eligiblePoolHash);
 B.push({id:p.id,selection:armb.selection});C.push({id:p.id,selection:first.selection});documents.push({id:p.id,documents:first.ranking.documents});
 relevance.push({id:p.id,indexStats:first.ranking.indexStats,relevanceFallback:first.ranking.relevanceFallback,rows:first.ranking.rows.map(({candidate,coverage,...r})=>({candidateId:candidate.terminalEntityId,terminalName:candidate.terminalEntity.qualifiedName,...r}))});
 reasons.push({id:p.id,B:armb.selection.selected.map(({candidate,...s})=>({candidateId:candidate.terminalEntityId,...s})),C:first.selection.selected.map(({candidate,...s})=>({candidateId:candidate.terminalEntityId,...s})),rounds:first.selection.rounds});
 const ds=p.eligible.map(c=>derivePathCoverage(c,protocol.coverage.patternLengths)),sets=Object.fromEntries([['A',A.find(r=>r.id===p.id).selection],['B',armb.selection],['C',first.selection]].map(([arm,s])=>[arm,{...pathCoverageMetrics(ds,s.selected.map(s=>ds.find(d=>d.candidate.terminalEntityId===s.candidate.terminalEntityId))),uniqueFileCount:new Set(s.selected.map(s=>s.candidate.terminalPath)).size}]));
 metrics.push({id:p.id,eligiblePoolHash:p.eligiblePoolHash,eligibleCount:p.eligible.length,sets});
 console.log(JSON.stringify({id:p.id,complete:true}));
}
await save('arm-b-relevance.json',B);await save('arm-c-hybrid.json',C);await save('candidate-documents.json',documents);await save('candidate-relevance.json',relevance);await save('selection-reasons.json',reasons);await save('set-metrics.json',metrics);await save('determinism.json',stability);await save('performance.json',{pass:perfs.every(p=>p.pass),rows:perfs});await save('implementation-sha.json',implementation);
const names=['protocol.json','frozen-inputs.json','query-freeze.json','investigation-query.json','preselection-observations.json','arm-a-selection.json','arm-b-relevance.json','arm-c-hybrid.json','candidate-documents.json','candidate-relevance.json','selection-reasons.json','leakage-audit.json','set-metrics.json','determinism.json','performance.json','implementation-sha.json','baseline-reproduction.json'];
await save('prediction-freeze.json',{frozenAt:new Date().toISOString(),auditRead:false,artifacts:await Promise.all(names.map(async name=>({name,sha256:hash(await readFile(join(out,name)))})))});
console.log(JSON.stringify({predictionFrozen:true,performancePass:perfs.every(p=>p.pass)}));
