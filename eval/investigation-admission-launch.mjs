import {join,resolve,toNamespacedPath} from 'node:path';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {identity,checkIdentities} from './candidate-dataset-context.mjs';
const out=resolve(process.argv[2]),history=resolve(process.argv[3]),gate1=resolve(process.argv[4]),repo=resolve(import.meta.dirname,'..'),workspace=resolve(repo,'..');
assert.equal(JSON.parse(await readFile(join(gate1,'execution/results.json'),'utf8')).gate1,'PASS');
await mkdir(out);await mkdir(join(out,'phase-a'));
const universe=join(history,'universe.json'),original=JSON.parse(await readFile(universe,'utf8')).plans;
// Historical checkout paths may contain a legacy damaged workspace prefix. Only
// relocate the registered /output suffix; snapshot and graph hashes must still match.
const relocate=p=>{const suffix=p.replaceAll('\\','/').split('/output/')[1];assert(suffix);return join(workspace,'output',suffix);};
const plans=original.map(p=>({...p,state:relocate(p.state),graphPath:relocate(p.graphPath),contextPath:join(history,'phase-a/review-contexts',p.caseId+'.json')}));
const files=[universe,join(history,'protocol.json'),join(gate1,'execution/results.json')];
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(p);}}
await walk(join(repo,'src'));await walk(join(repo,'integrations/pi/src'));
for(const name of ['investigation-admission.mjs','investigation-admission-launch.mjs','candidate-dataset-context.mjs','frontier-data.mjs'])files.push(join(repo,'eval',name));
files.push(join(repo,'package.json'),join(repo,'package-lock.json'),...plans.filter(p=>!p.duplicate).map(p=>p.contextPath));
const denied=[join(history,'phase-b'),join(history,'dataset-final'),join(workspace,'output/realgolden40-closure/corpus-v1-final/hidden/gold.jsonl'),join(workspace,'output/complex-graph-value-20260924/private/audit.json')];
const freeze={identity:out.split(/[\\/]/).at(-1),plans,files:await Promise.all(files.map(identity)),denied,minimumValid:6,minimumBaselineHits:2,minimumBaselineMisses:2,
  fallback:'Only pre-existing registered D3/D4/D6; duplicate reviewed snapshots cannot count twice.',
  protocol:{tools:[],temperature:0,maxSelected:3,retry:false,repair:false},
  phaseOrder:'Public generation and hash freeze; if public upper bound < 6 STOP without private target access or model calls. Otherwise models/predictions freeze before private scoring.'};
await writeFile(join(out,'input-freeze.json'),JSON.stringify(freeze,null,2));
const allowed=[join(repo,'src'),join(repo,'integrations/pi/src'),join(repo,'integrations/pi/package.json'),join(repo,'node_modules'),join(repo,'package.json'),join(repo,'package-lock.json'),
 ...files.filter(p=>p.startsWith(join(repo,'eval'))),join(history,'phase-a/review-contexts'),universe,join(history,'protocol.json'),join(gate1,'execution/results.json'),join(out,'input-freeze.json'),join(out,'phase-a')];
for(const p of plans.filter(p=>!p.duplicate))allowed.push(join(p.state,'snapshots',p.snapshotId+'.json'),join(p.state,'graphs'),join(p.state,'blobs'));
const unique=[...new Set(allowed.flatMap(p=>[p,toNamespacedPath(p)]))];await writeFile(join(out,'access-policy.json'),JSON.stringify({read:unique,write:[join(out,'phase-a')],denied,child:false,modelRuntime:false},null,2));
const child=spawnSync(process.execPath,['--experimental-strip-types','--preserve-symlinks','--permission',...unique.map(p=>'--allow-fs-read='+p),'--allow-fs-write='+join(out,'phase-a'),join(repo,'eval/investigation-admission.mjs'),out],{cwd:repo,encoding:'utf8',maxBuffer:4e6});
process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');await checkIdentities(freeze.files);
await writeFile(join(out,'exit.json'),JSON.stringify({exit:child.status,error:child.error?.message??null,inputsUnchanged:true}));assert.equal(child.status,0);
