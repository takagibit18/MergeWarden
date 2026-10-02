import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,copyFile,link,stat,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {sha256,writeJson} from '../../src/infrastructure/files.ts';
export {sha256,writeJson};
export const repo=resolve(import.meta.dirname,'../..');
export const read=async p=>JSON.parse(await readFile(p,'utf8'));
export const exclusiveJson=async(p,v)=>{await mkdir(dirname(p),{recursive:true});await writeFile(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});};
export async function clone(src,dst,immutable=false){const info=await stat(src);if(info.isDirectory()){await mkdir(dst,{recursive:true});for(const n of await readdir(src))await clone(join(src,n),join(dst,n),immutable);}else{await mkdir(dirname(dst),{recursive:true});if(immutable)try{await link(src,dst);}catch(e){if(e.code==='ERR_ACCESS_DENIED')await copyFile(src,dst);else if(e.code!=='EEXIST')throw e;}else await copyFile(src,dst);}}
export async function snapshotCopy(from,to,id){const m=await read(join(from,'snapshots',id+'.json'));await mkdir(join(to,'snapshots'),{recursive:true});await copyFile(join(from,'snapshots',id+'.json'),join(to,'snapshots',id+'.json'));await mkdir(join(to,'blobs'),{recursive:true});for(const hash of new Set([...Object.values(m.base),...Object.values(m.head)].filter(f=>f.status==='text').map(f=>f.hash)))await clone(join(from,'blobs',hash),join(to,'blobs',hash),true);}
export async function verifyCode(ex){for(const f of ex.code)assert.equal(sha256(await readFile(join(repo,f.path))),f.sha256,'Code drift: '+f.path);}
export async function freezeBank(root,arm){const {SkillBank,digest,contentOf}=await import('../../src/skills/bank.ts');const state=join(root,'execution',arm),bank=new SkillBank(state),skills=await bank.skills(),jobs=[];for(const f of await readdir(join(state,'skills/jobs')))if(f.endsWith('.json')){const j=await read(join(state,'skills/jobs',f));assert(!['pending','running'].includes(j.status));jobs.push(j);}const frozen={status:'FROZEN',at:new Date().toISOString(),bankSnapshotId:(await bank.current()).id,catalogSha256:digest(skills),effectiveDigest:digest(skills.map(s=>({id:s.id,content:contentOf(s),state:s.state,repositoryKey:s.repositoryKey}))),skills,jobs};await exclusiveJson(join(root,'execution',arm+'-frozen.json'),frozen);return frozen;}
