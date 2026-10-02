import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {sha256,writeJson} from '../../src/infrastructure/files.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const paths=['src/graph','src/snapshot','src/domain','src/application','src/eval','src/engine/prompt.ts','src/engine/reports.ts','schemas','integrations/tree-sitter/src','eval/cases.json','eval/corpus.lock.json','eval/experiment.json','integrations/pi/src/bigmodel.ts','integrations/pi/src/extension.ts','integrations/pi/src/journal.ts'];
export async function assertFrozen(){
 const protocol=JSON.parse(await readFile(new URL('./protocol.json',import.meta.url)));
 const files=execFileSync('git',['ls-tree','-r','--name-only',protocol.baselineCommit,'--',...paths],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
 const hashes={};for(const file of files){const expected=sha256(execFileSync('git',['show',`${protocol.baselineCommit}:${file}`],{cwd:root,encoding:'utf8'}).replaceAll('\r\n','\n')),bytes=await readFile(join(root,file)),actual=sha256(bytes.toString('utf8').replaceAll('\r\n','\n'));if(actual!==expected)throw Error('Frozen baseline content changed: '+file);hashes[file]={checkoutSha256:sha256(bytes),lfNormalizedSha256:actual};}
 return {baselineCommit:protocol.baselineCommit,files:hashes};
}
if(process.argv.includes('--write'))await writeJson(fileURLToPath(new URL('./frozen-baseline.json',import.meta.url)),await assertFrozen());
