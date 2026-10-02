import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeRetrieval} from '../src/experiments/locagent/traces.ts';
function fixture({priorText=false,priorSearch=false,priorHint=false,candidate=false,sameBatch=false,missingUsage=false,diffEvidence=false}={}){
 const evidence={snapshotId:'s',revision:'head',path:diffEvidence?'changed.py':'caller.py',startLine:1,endLine:2,contentSha256:'a'.repeat(64)};
 const finding={id:'f',title:'bug',claim:'claim',trigger:'trigger',impact:'impact',severity:'medium',evidence:[evidence]};
 const entries=[];let parent=null,n=0;
 const message=m=>{const id=`e${++n}`;entries.push({id,parentId:parent,type:'message',message:m});parent=id;};
 const assistant=blocks=>message({role:'assistant',content:blocks,stopReason:'toolUse',...(missingUsage?{}:{usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2}})});
 const block=(id,name,args)=>({type:'toolCall',id,name,arguments:args});
 const result=(id,name,response)=>message({role:'toolResult',toolCallId:id,toolName:name,isError:false,content:[{type:'text',text:JSON.stringify(response)}]});
 const page=items=>({status:'ok',snapshotId:'s',items});
 if(priorText){assistant([block('text','search_text',{query:'caller'})]);result('text','search_text',page([{path:'caller.py'}]));}
 if(priorSearch){assistant([block('search','search_entity',{searchTerms:['caller'],topK:3})]);result('search','search_entity',page([{entityId:'caller',path:'caller.py'}]));}
 if(priorHint){assistant([block('hint','traverse_graph',{startEntities:['caller']})]);result('hint','traverse_graph',{...page([]),hints:[{query:'caller',matchMode:'bm25_entity',candidates:[{entityId:'caller',path:'caller.py'}]}]});}
 const read=block('source','read_source',{revision:'head',path:evidence.path,startLine:1,endLine:2});
 assistant([block('walk','traverse_graph',{startEntities:['root'],direction:'upstream',maxHops:2}),...(sameBatch?[read]:[])]);
 result('walk','traverse_graph',page([{entityId:'caller',path:'caller.py',startLine:1,endLine:2,depth:1,discoveredVia:{edgeId:'edge',direction:'upstream',relation:'CALLS',resolution:candidate?'candidate':'resolved_scoped',pathResolved:!candidate}}]));
 if(!sameBatch)assistant([read]);result('source','read_source',{status:'ok',...evidence,text:'code'});
 assistant([block('submit','submit_review',{findings:[finding]})]);result('submit','submit_review',{accepted:true});
 return analyzeRetrieval({runKey:'fixture',snapshotId:'s',findings:[finding],jsonl:entries.map(e=>JSON.stringify(e)).join('\n')});
}
test('strict G1 native attribution requires novel, resolved and temporally separate source evidence',()=>{
 assert.equal(fixture().findings[0].discoveryPath,'graph_assisted');
 for(const option of ['priorText','priorSearch','priorHint','candidate','sameBatch','diffEvidence'])assert.notEqual(fixture({[option]:true}).findings[0].discoveryPath,'graph_assisted',option);
 assert.equal(fixture({missingUsage:true}).metrics.totalTokens,null);
 assert.equal(fixture({priorSearch:true}).metrics.novelPaths,0);
});
