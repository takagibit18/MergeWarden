import test from 'node:test';
import assert from 'node:assert/strict';
import {frozenPathProof} from '../eval/route-private-material.mjs';
test('frozen path audit rejects unresolved edges and maps evidence ranges without claiming runtime reach',()=>{
  const symbol=(id,path,startLine,endLine,kind='function')=>({id,path,startLine,endLine,kind,qualifiedName:id});
  const symbols=[symbol('root','a.py',1,10),symbol('helper','b.py',1,8),symbol('target','c.py',1,9)];
  const edge=(id,fromId,toId,resolution='resolved_scoped')=>({id,fromId,toId,relation:'CALLS',resolution});
  const anchor={path:'a.py',startLine:3,endLine:3},targets=[{path:'c.py',startLine:2,endLine:4}];
  const data={symbols,relations:[edge('one','root','helper'),edge('two','helper','target','candidate')]};
  assert.equal(frozenPathProof(data,anchor,targets).anyRelevantPathExists,false);
  data.relations[1].resolution='resolved_import_alias';data.relations.push(edge('cycle','helper','root'));
  const proof=frozenPathProof(data,anchor,targets);assert.equal(proof.anyRelevantPathExists,true);
  assert.deepEqual(proof.targets[0].proof.entityIds,['root','helper','target']);assert.equal(proof.targets[0].proof.edges.length,2);
  assert.equal(frozenPathProof(data,{...anchor,path:'missing.py'},targets).anyRelevantPathExists,false);
});
