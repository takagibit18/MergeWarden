import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCorpus } from './validate.mjs';

/** Explicit corpus selection; historical results must never use replacement labels. */
export async function loadCorpus(directory, expectedSha256) {
 const root=directory===undefined?fileURLToPath(new URL('./',import.meta.url)):resolve(directory);
 const bytes=await readFile(join(root,'cases.json'),'utf8');
 const lock=JSON.parse(await readFile(join(root,'corpus.lock.json'),'utf8'));
 const corpus=validateCorpus(JSON.parse(bytes),lock,bytes);
 if(expectedSha256!==undefined&&lock.sha256!==expectedSha256)throw Error('Result corpus mismatch; select the original frozen directory with --corpus');
 return {corpus,bytes,lock};
}
