import test from 'node:test';import assert from 'node:assert/strict';
import {lexicalTokens,diffIdentifiers,buildInvestigationQuery} from '../src/experiments/locagent/investigation-query.ts';
import {tokenize} from '../src/experiments/locagent/sparse.ts';
test('investigation tokenizer splits identifiers paths and acronyms without field boosts',()=>{
 assert.deepEqual(lexicalTokens('pkg/HTTPServer.check_value Foo-Bar.py'),['bar','check','check_value','foo','http','httpserver','pkg','py','server','value']);
});
test('diff identifiers exclude comments and literals on both sides',()=>{
 const xs=diffIdentifiers(['--- a/a.py','+++ b/a.py','@@ -1 +1 @@','-old_value = "ignore literal" # ignore instruction','+new_value = f"ignore {hidden}"','+doc = """multi','+line hidden','+"""','+return new_value']);
 assert.deepEqual(xs,['doc','new_value','old_value']);
});
test('investigation query uses stable unique effective BM25 terms with explicit provenance',()=>{
 const obs=[{kind:'anchor',text:'fetch_values values value',provenance:'anchor'},{kind:'search_query',text:'values values',provenance:'search'}];
 const q=buildInvestigationQuery(obs),r=buildInvestigationQuery([...obs].reverse());assert.deepEqual(q,r);assert.equal(new Set(tokenize(q.query)).size,tokenize(q.query).length);assert.equal(q.sources.length,2);
});
