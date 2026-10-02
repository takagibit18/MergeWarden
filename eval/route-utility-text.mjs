import {classifyPythonPath} from '../src/graph/scope-policy.ts';

export const TEXT_POLICY=Object.freeze({version:'route-utility-text-1',maxSearchTextCalls:3,maxSourceReads:3,sourceWindowLines:80,maxContextBytes:24576,searchLimit:50});
const cmp=(a,b)=>a<b?-1:a>b?1:0;
const production=p=>p.endsWith('.py')&&classifyPythonPath(p)==='production';
// Lexical identifier harvesting only. This does not build graph facts or infer calls.
const code=s=>s.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|#[^\n]*/g,' ');
export function lexicalSeeds(text,path,origin,priority=2){
  const clean=code(text),seeds=[];
  const add=(query,kind,index)=>seeds.push({query,priority:priority+(kind==='definition'?0:kind==='call'?1:2),kind,path,index,origin,production:production(path)});
  // A diff may begin inside a docstring. Do not let an unmatched closing quote
  // consume subsequent visible declarations. These are lexical seeds, not AST facts.
  const declarations=origin?.tool==='read_diff'?text:clean;
  for(const m of declarations.matchAll(/^[ \t]*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm))add(m[1],'definition',m.index);
  for(const m of clean.matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)){
    if(/(?:def|class)\s+$/.test(clean.slice(Math.max(0,m.index-8),m.index)))continue;
    if(['if','for','while','return','print','len','range','isinstance','issubclass','type','int','float','str','bool','list','dict','tuple','set','super'].includes(m[1]))continue;
    add(m[1],'call',m.index);
  }
  for(const m of clean.matchAll(/\bimport\s+([^\n]+)/g))for(const n of m[1].matchAll(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g))if(n[0]!=='as')add(n[0],'import',m.index+n.index);
  return seeds;
}
export function initialSeeds(prefix){
  const seeds=[],pages=new Map();
  for(const e of prefix.observations){
    if(e.toolName==='search_text'&&typeof e.input.query==='string')seeds.push({query:e.input.query,priority:1,kind:'historical_query',path:'',index:e.ordinal,origin:{ordinal:e.ordinal},production:true});
    if(e.toolName==='read_diff'&&e.result.status==='ok'){
      const p=pages.get(e.result.path)??new Map();pages.set(e.result.path,p);e.result.lines.forEach((l,i)=>p.set(e.result.offset+i,l));
    }
    if(e.toolName==='read_source'&&e.result.revision==='head')seeds.push(...lexicalSeeds(e.result.text,e.result.path,{ordinal:e.ordinal,tool:'read_source'}));
  }
  for(const [path,lines]of pages){const text=[...lines].sort((a,b)=>a[0]-b[0]).map(([,s])=>/^[ +]/.test(s)&&!s.startsWith('+++')?s.slice(1):'').join('\n');seeds.push(...lexicalSeeds(text,path,{tool:'read_diff',path}));}
  return orderSeeds(seeds);
}
export function orderSeeds(seeds){return [...seeds].sort((a,b)=>a.priority-b.priority||Number(b.production)-Number(a.production)||cmp(a.path,b.path)||a.index-b.index||cmp(a.query,b.query)).filter((s,i,a)=>a.findIndex(x=>x.query===s.query)===i);}
const proximity=(path,changed)=>Math.max(0,...changed.map(c=>{const a=path.split('/'),b=c.split('/');let n=0;while(n<Math.min(a.length-1,b.length-1)&&a[n]===b[n])n++;return n;}));
function exact(text,q){const i=text.indexOf(q);return i>=0&&!/\w/.test(text[i-1]??'')&&!/\w/.test(text[i+q.length]??'');}
export function rankMatches(items,query,changedPaths){return [...items].sort((a,b)=>Number(production(b.path))-Number(production(a.path))||Number(changedPaths.includes(a.path))-Number(changedPaths.includes(b.path))||Number(exact(b.text,query))-Number(exact(a.text,query))||proximity(b.path,changedPaths)-proximity(a.path,changedPaths)||cmp(a.path,b.path)||a.line-b.line);}
export async function textComparator(prefix,store){
  let seeds=initialSeeds(prefix),stopReason='results_exhausted';const initial=structuredClone(seeds),used=new Set(),queries=[],sourceReads=[],packet={searchResults:[],sources:[]};
  const visible=prefix.observations.filter(e=>e.toolName==='read_source'&&e.result.revision==='head').map(e=>e.result);
  const seenPaths=new Set(prefix.observations.flatMap(e=>e.result.path?[e.result.path]:e.result.items?.map(i=>i.path)??[]));
  const fits=()=>Buffer.byteLength(JSON.stringify(packet))<=TEXT_POLICY.maxContextBytes;
  while(queries.length<TEXT_POLICY.maxSearchTextCalls&&sourceReads.length<TEXT_POLICY.maxSourceReads){
    const seed=seeds.find(s=>!used.has(s.query));if(!seed){stopReason='no_new_exact_identifiers';break;}used.add(seed.query);
    const result=await store.search('head',seed.query,TEXT_POLICY.searchLimit);
    const q={query:seed.query,seed,result,resultCount:result.items.length,returnedPaths:[...new Set(result.items.map(i=>i.path))],truncated:result.truncated,coverage:result.coverage,selectedRead:null,selectionBasis:'production > untouched file > exact identifier > changed package proximity > stable path/line'};queries.push(q);
    packet.searchResults.push(result);if(!fits()){packet.searchResults.pop();stopReason='context_budget';break;}
    const match=rankMatches(result.items,seed.query,prefix.changedPaths).find(i=>![...visible,...sourceReads].some(s=>s.path===i.path&&s.startLine<=i.line&&s.endLine>=i.line));
    if(!match)continue;
    const startLine=Math.max(1,match.line-10),page=await store.source('head',match.path,startLine,startLine+TEXT_POLICY.sourceWindowLines-1);
    sourceReads.push(page);q.selectedRead={path:page.path,startLine:page.startLine,endLine:page.endLine};packet.sources.push(page);
    if(!fits()){packet.sources.pop();stopReason='context_budget';break;}
    seeds=orderSeeds([...seeds,...lexicalSeeds(page.text,page.path,{tool:'counterfactual_read_source',readOrdinal:sourceReads.length,contentSha256:page.contentSha256},3)]);
  }
  if(stopReason!=='context_budget'){if(queries.length>=3)stopReason='search_budget';else if(sourceReads.length>=3)stopReason='source_budget';}
  return {arm:'T',version:TEXT_POLICY.version,initialSeeds:initial,queries,sourceReads,packet,novelPaths:[...new Set(packet.sources.map(s=>s.path))].filter(p=>!seenPaths.has(p)),untouchedPaths:[...new Set(packet.sources.map(s=>s.path))].filter(p=>!prefix.changedPaths.includes(p)),observedFacts:packet.sources.map(s=>({path:s.path,startLine:s.startLine,endLine:s.endLine,contentSha256:s.contentSha256,text:s.text})),budgetUsed:{searchCalls:queries.length,graphOps:0,sourceReads:sourceReads.length,contextBytes:Buffer.byteLength(JSON.stringify(packet)),rawSearchResultBytes:queries.reduce((n,q)=>n+Buffer.byteLength(JSON.stringify(q.result)),0)},stopReason};
}
