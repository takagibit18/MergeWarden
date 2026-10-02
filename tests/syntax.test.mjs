import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir,readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
async function files(dir){const all=[];for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.name==='node_modules')continue;const p=join(dir,entry.name);if(entry.isDirectory())all.push(...await files(p));else if(p.endsWith('.ts'))all.push(p);}return all;}
test('all checked-in TypeScript can be syntax stripped, including uninstalled adapters',async()=>{
  for(const file of [...await files('src'),...await files('integrations')]){
    const source=await readFile(file,'utf8');
    assert.doesNotThrow(()=>stripTypeScriptTypes(source),file);
  }
});
