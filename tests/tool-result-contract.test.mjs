import test from 'node:test';
import assert from 'node:assert/strict';
import {parseToolResult,annotateResult} from '../src/engine/tool-result.ts';
import {decodePiTrace} from '../src/eval/provenance/decode.ts';
const content=text=>[{type:'text',text}];
const trace=(text,isError=false)=>[
 {id:'a',parentId:null,type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'t',name:'submit_review',arguments:{}}]}},
 {id:'b',parentId:'a',type:'message',message:{role:'toolResult',toolCallId:'t',toolName:'submit_review',isError,content:content(text),details:{snapshotId:'hidden',status:'ok'}}}
].map(JSON.stringify).join('\n');
test('canonical visible result preserves business fields and carries host notices in one object',()=>{
 const value={snapshotId:'s',status:'ok',items:[{path:'a.py'}]};
 const result=annotateResult(value,[{kind:'structural_investigation',routeId:'r',text:'unchanged card'}]);
 assert.deepEqual(parseToolResult(content(JSON.stringify(result))).value,result);
 assert.deepEqual(result.items,value.items);assert.equal(value._mergewarden,undefined);
 assert.equal(result._mergewarden.schemaVersion,1);
});
test('legacy notice compatibility is read-only, bounded and never recovers hidden details',()=>{
 const c=[...content('{"status":"ok"}'),...content('[Structural investigation]\ncard')];
 assert.equal(parseToolResult(c).value,undefined);
 assert.equal(parseToolResult(c,true).value.status,'ok');
 c.push(...content('arbitrary invalid suffix'));assert.equal(parseToolResult(c,true).value,undefined);
 const decoded=decodePiTrace(trace('SDK validation error',true));
 assert.equal(decoded.calls[0].response,undefined);
 assert.deepEqual(decoded.issues.map(i=>[i.kind,i.scope,i.severity]),[['non_json_result','call','warning']]);
});
test('timeline identity corruption remains fatal while missing results are explicit call issues',()=>{
 assert.equal(decodePiTrace('{broken').issues[0].severity,'fatal');
 const rows=trace('{}').split('\n').map(JSON.parse);rows[1].parentId='missing';
 assert.ok(decodePiTrace(rows.map(JSON.stringify).join('\n')).issues.some(i=>i.kind==='missing_parent'&&i.scope==='trace'));
 rows[1].parentId='a';rows[1].id='a';
 assert.ok(decodePiTrace(rows.map(JSON.stringify).join('\n')).issues.some(i=>i.kind==='duplicate_entry'));
 const only=decodePiTrace(trace('{}').split('\n')[0]);assert.equal(only.issues[0].kind,'missing_result');
});
