import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {read} from '../microeval/common.mjs';
const out=resolve(process.argv[2]),repo=resolve(import.meta.dirname,'../..'),input=await read(join(out,'public/D1.json'));
const allowed=[repo,join(out,'public'),join(out,'state'),join(out,'arm-a-text'),join(out,'arm-b-graph'),join(out,'preflight'),input.case.repositoryPath,...['run-config.json','input-freeze.json','protocol.json','successor-lineage.json','case-manifest.json','baseline-exit.txt','mechanical-preflight.json'].map(n=>join(out,n))];
const args=['--experimental-strip-types','--permission','--allow-worker',...allowed.map(p=>'--allow-fs-read='+p),'--allow-fs-write='+out,join(import.meta.dirname,'run.mjs'),out,...process.argv.slice(3)];
const r=spawnSync(process.execPath,args,{cwd:repo,env:process.env,stdio:'inherit'});process.exitCode=r.status??1;
