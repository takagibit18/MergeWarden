import {spawnSync} from 'node:child_process';
import {join,resolve,dirname} from 'node:path';
import {read} from '../microeval/common.mjs';
const out=resolve(process.argv[2]),offline=process.argv.includes('--offline'),authPath=offline?join(out,'preflight-auth/auth.json'):resolve(process.argv[3]);
const root=resolve(import.meta.dirname,'../..'),config=await read(join(out,'run-config.json'));
const allowed=[root,out,dirname(authPath)];for(const c of config.cases)allowed.push((await read(c.path)).case.repositoryPath);
const result=spawnSync(process.execPath,['--experimental-strip-types','--permission','--allow-worker',...allowed.map(p=>'--allow-fs-read='+p),'--allow-fs-write='+out,'--allow-fs-write='+dirname(authPath),join(import.meta.dirname,'subscription-run.mjs'),out,authPath,...(offline?['--offline']:[])],{cwd:root,env:process.env,stdio:'inherit',windowsHide:true});
process.exitCode=result.status??1;
