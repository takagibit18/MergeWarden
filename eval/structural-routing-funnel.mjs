/** Development funnel includes Graph search discoveries. It does not classify findings. */
export function graphNovelSourceChains(trace, snapshotId, changedPaths) {
 const seen=new Set(changedPaths),pending=[],chains=[];
 for(const c of trace.calls){
  const r=c.response;if(c.isError||r?.snapshotId!==snapshotId||!['ok','parse_incomplete','partial'].includes(r.status))continue;
  if(c.name==='read_source'&&r.revision==='head'){
   for(const p of pending)if(!p.verified&&p.path===r.path&&r.startLine<=p.startLine&&r.endLine>=p.endLine){p.verified=true;chains.push({graphCallId:p.graphCallId,graphTool:p.graphTool,entityId:p.entityId,path:p.path,sourceCallId:c.id});}
  }
  if(['search_entity','traverse_graph'].includes(c.name)&&r.revision==='head'){
   for(const e of r.items??[])if(e.entityId&&e.path&&!seen.has(e.path))pending.push({...e,graphCallId:c.id,graphTool:c.name});
  }
  if(['read_source','read_diff'].includes(c.name)&&r.path)seen.add(r.path);
  if(['search_text','search_entity','traverse_graph'].includes(c.name))for(const e of r.items??[])if(e.path)seen.add(e.path);
 }
 return chains;
}
