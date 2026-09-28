import {join,resolve,toNamespacedPath} from 'node:path';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {identity,checkIdentities} from './candidate-dataset-context.mjs';
const out=resolve(process.argv[2]),history=resolve(process.argv[3]),repo=resolve(import.meta.dirname,'..');
await mkdir(out); // Refuse to overwrite a prior experiment identity, including a failed run.
const plansFile=join(history,'phase-a-v2/plans.json'),{plans}=JSON.parse(await readFile(plansFile,'utf8'));
const files=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(p);}}
await walk(join(repo,'src'));await walk(join(repo,'integrations/pi/src'));
for(const f of ['investigation-gate1-launch.mjs','investigation-gate1.mjs','frontier-data.mjs','candidate-dataset-context.mjs','route-utility-graph.mjs'])files.push(join(repo,'eval',f));
files.push(join(repo,'package.json'),join(repo,'package-lock.json'),plansFile,...plans.map(p=>p.inputPath));
const denied=[join(history,'phase-b'),join(history,'phase-c'),resolve(history,'../realgolden40-closure/corpus-v1-final/hidden/gold.jsonl'),resolve(history,'../complex-graph-value-20260924/private/audit.json')];
const freeze={identity:out.split(/[\\/]/).at(-1),replays:100,diagnosticReplays:100,files:await Promise.all(files.map(identity)),plans,denied,
  comparison:'First actual deterministic activation per prefix. Separate forced-END historical diagnostic is not real routing timing.',modelCalls:0};
await writeFile(join(out,'input-freeze.json'),JSON.stringify(freeze,null,2));await mkdir(join(out,'execution'));
const allowed=[join(repo,'src'),join(repo,'integrations/pi/src'),join(repo,'integrations/pi/package.json'),join(repo,'node_modules'),
  ...files.filter(p=>!p.startsWith(join(repo,'src'))&&!p.startsWith(join(repo,'integrations/pi/src'))&&!plans.some(plan=>plan.inputPath===p)),
  join(history,'phase-a-v2/pre-route-inputs'),join(out,'input-freeze.json'),join(out,'execution')];
for(const p of plans)allowed.push(join(p.state,'snapshots',p.snapshotId+'.json'),join(p.state,'graphs'),join(p.state,'blobs'));
const unique=[...new Set(allowed.flatMap(p=>[p,toNamespacedPath(p)]))];
await writeFile(join(out,'access-policy.json'),JSON.stringify({read:unique,write:[join(out,'execution')],denied,child:false,modelCalls:0},null,2));
const child=spawnSync(process.execPath,['--experimental-strip-types','--preserve-symlinks','--permission',...unique.map(p=>'--allow-fs-read='+p),'--allow-fs-write='+join(out,'execution'),join(repo,'eval/investigation-gate1.mjs'),out],{cwd:repo,encoding:'utf8',maxBuffer:4e6});
process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');
await checkIdentities(freeze.files);await writeFile(join(out,'execution-exit.json'),JSON.stringify({exit:child.status,error:child.error?.message??null,inputsUnchanged:true}));assert.equal(child.status,0);
