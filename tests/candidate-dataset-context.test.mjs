import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectPrefix,hash,save,identity,checkIdentities} from '../eval/candidate-dataset-context.mjs';

test('dataset context projection stops before structural/final outcomes and excludes reasoning',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mw-context-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'session.jsonl'),rows=[
    {type:'session',id:'header'},
    {type:'message',id:'a',parentId:null,message:{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE_NOT_INPUT'},{type:'toolCall',id:'c',name:'read_diff',arguments:{path:'x.py'}}]}},
    {type:'message',id:'b',parentId:'a',message:{role:'toolResult',toolName:'read_diff',toolCallId:'c',isError:false,content:[]}},
    {type:'message',id:'c',parentId:'b',message:{role:'assistant',content:[{type:'toolCall',id:'g',name:'search_entity',arguments:{}}]}},
  ];
  await writeFile(path,rows.map(JSON.stringify).join('\n')+'\nMALFORMED PRIVATE FUTURE');
  const p=await projectPrefix(path);assert.equal(p.actions.length,1);assert.equal(p.stoppedAt,'search_entity');assert.ok(!JSON.stringify(p).includes('PRIVATE'));
  rows[2].parentId='wrong';await writeFile(path,rows.map(JSON.stringify).join('\n'));assert.equal((await projectPrefix(path)).actions.length,0);
});
test('dataset frozen identities reject mutation and creation never overwrites',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mw-freeze-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'input.json');
  await save(path,{a:1});const i=await identity(path);await checkIdentities([i]);await assert.rejects(save(path,{a:2}),/EEXIST/);
  await writeFile(path,'changed');await assert.rejects(checkIdentities([i]),/Frozen artifact changed/);assert.equal(hash({a:1}),hash({a:1}));
});
