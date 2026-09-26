import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {read} from './common.mjs';
const out=resolve(process.argv[2]),repo=resolve(import.meta.dirname,'../..'),config=await read(join(out,'run-config.json'));
const allowed=[repo,join(out,'public'),join(out,'state'),...['input-freeze.json','case-manifest.json','protocol.json','run-config.json'].map(n=>join(out,n)),join(out,'arm-a-text'),join(out,'arm-b-graph'),...config.cases.map(c=>c.path)];
// The repository path is only realpath-checked on immutable rerun, never read as working source.
for(const c of config.cases)allowed.push((await read(c.path)).case.repositoryPath);
const args=['--experimental-strip-types','--permission','--allow-worker',...allowed.map(p=>'--allow-fs-read='+p),'--allow-fs-write='+out,join(import.meta.dirname,'run.mjs'),out,...process.argv.slice(3)];
const run=spawnSync(process.execPath,args,{cwd:repo,env:process.env,stdio:'inherit'});process.exitCode=run.status??1;
