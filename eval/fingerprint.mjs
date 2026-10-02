import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sha256 } from '../src/infrastructure/files.ts';
/** Freeze executable review/evaluation code as well as prompts, configuration and dependencies. */
export async function implementationFingerprint(){
 const root=fileURLToPath(new URL('../',import.meta.url));const files=[];
 async function walk(path){for(const e of await readdir(join(root,path),{withFileTypes:true})){const child=path+'/'+e.name;if(e.isDirectory())await walk(child);else if(/\.(ts|mjs|json|sql)$/.test(e.name))files.push(child);}}
 for(const dir of ['src','integrations/pi/src','integrations/tree-sitter/src','eval','schemas'])await walk(dir);
 files.push('package-lock.json','integrations/pi/package-lock.json','integrations/tree-sitter/package-lock.json','integrations/tree-sitter/grammars/python.lock.json');
 return sha256(JSON.stringify(await Promise.all(files.sort().map(async path=>[path,sha256(await readFile(join(root,path)))]))));
}
