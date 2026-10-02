import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {analyzeRetrieval} from '../src/experiments/locagent/traces.ts';
const directory=new URL('./fixtures/attribution-v3/',import.meta.url);
for(const name of await readdir(directory))test('v3 frozen historical replay: '+name,async()=>{
 const f=JSON.parse(await readFile(new URL(name,directory),'utf8'));
 const first=analyzeRetrieval(f.input),second=analyzeRetrieval(f.input);
 assert.equal(JSON.stringify(first),JSON.stringify(second));assert.equal(first.version,'trace-attribution-3');
 assert.equal(first.findings[0].discoveryPath,f.expected);assert.ok(first.metrics.submissionValidationFailures>0);
 if(f.expected==='text_only')assert.ok(first.sourceLinks.some(l=>l.strictNovel));
 else assert.equal(first.findings[0].strictCallerAssisted,true);
});
