import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {read} from '../microeval/common.mjs';
const out=resolve(process.argv[2]),repo=resolve(import.meta.dirname,'../..'),config=await read(join(out,'run-config.json'));
const allowed=[repo,...['public','state','arm-a-text','arm-b-graph','preflight','run-config.json','input-freeze.json','protocol.json','mechanical-preflight.json','prior-attempts.json'].map(n=>join(out,n))];
for(const c of config.cases)allowed.push((await read(c.path)).case.repositoryPath);
const child=spawnSync(process.execPath,['--experimental-strip-types','--permission','--allow-worker',...allowed.map(p=>'--allow-fs-read='+p),'--allow-fs-write='+out,join(import.meta.dirname,'run.mjs'),out,...process.argv.slice(3)],{cwd:repo,env:process.env,stdio:'inherit',windowsHide:true});
process.exitCode=child.status??1;
