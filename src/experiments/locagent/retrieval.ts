import type { RelationFact, SymbolFact } from '../../graph/contracts.ts';
import type { ExplorationBudget, GraphData, RetrievalConfig, SearchInput, TraverseInput } from './contracts.ts';
import {progressiveWalk,STRUCTURAL_PATTERNS} from './patterns.ts';
import { SparseIndex, fuzzyScore } from './sparse.ts';
import {resolveChangeHints} from '../../engine/change-resolution.ts';
import {hostStructuralInvestigation} from './host-investigation.ts';
import {declarationPreview} from '../../engine/candidate-catalog.ts';
const order = (a:string,b:string)=>a<b?-1:a>b?1:0;
const size = (v:unknown)=>Buffer.byteLength(JSON.stringify(v));
const measured = <T extends {responseBytes:number}>(value:T):T=>{let next=size(value);while(next!==value.responseBytes){value.responseBytes=next;next=size(value);}return value;};
const requireThat = (condition:unknown, message:string):void=>{if(!condition)throw Error(message);};
export function entityName(s:SymbolFact):string {
  const module=s.path.replace(/\.py$/,'').replace(/\/__init__$/,'').replaceAll('/','.');
  if(s.kind==='directory'||s.kind==='file')return s.path;
  return `${s.path}:${s.qualifiedName.startsWith(module+'.')?s.qualifiedName.slice(module.length+1):s.qualifiedName}`;
}
const metadata=(s:SymbolFact)=>({entityId:s.id,entityName:entityName(s),snapshotId:s.snapshotId,kind:s.kind,...(s.functionKind?{functionKind:s.functionKind}:{}),name:s.name,qualifiedName:s.qualifiedName,path:s.path,startLine:s.startLine,endLine:s.endLine});
function glob(pattern:string,path:string):boolean {
  const parts=pattern.replaceAll('\\','/').split('**');
  const escape=(s:string)=>s.replace(/[.+^${}()|[\]\\]/g,'\\$&').replaceAll('*','[^/]*').replaceAll('?','[^/]');
  return new RegExp('^'+parts.map(escape).join('.*')+'$').test(path) || pattern==='**/*.py'&&path.endsWith('.py');
}
/** Retrieval over already-resolved immutable Graph data. It never creates semantic edges. */
export class LocAgentRetrieval {
  private data:GraphData; private config:RetrievalConfig; private symbols:SymbolFact[];
  private byId:Map<string,SymbolFact>; private entities:SparseIndex; private contents:SparseIndex|undefined; private contentWarning:string|undefined;
  private chunks:{path:string;startLine:number;endLine:number;text:string}[]=[];
  private contentDocumentBytes=0;
  private incomingByEntity=new Map<string,RelationFact[]>();
  private outgoingByEntity=new Map<string,RelationFact[]>();
  private relationIndexBuildMs=0;
  private relationIndexBuildCount=0;
  constructor(data:GraphData,config:RetrievalConfig={}) {
    this.data=data;this.config=config;
    requireThat(Number.isInteger(config.maxHops??20)&&(config.maxHops??20)>=1&&(config.maxHops??20)<=20,'Invalid configured hop bound');
    this.symbols=[...data.symbols].sort((a,b)=>order(entityName(a),entityName(b))||order(a.id,b.id));
    this.byId=new Map(this.symbols.map(s=>[s.id,s]));
    for(const s of this.symbols)requireThat(s.snapshotId===data.snapshotId,'Cross-snapshot symbol');
    for(const e of data.relations)requireThat(e.snapshotId===data.snapshotId,'Cross-snapshot relation');
    const indexStarted=performance.now();
    for(const edge of data.relations){
      if(!['resolved_scoped','resolved_import_alias'].includes(edge.resolution))continue;
      for(const [index,id] of [[this.outgoingByEntity,edge.fromId],[this.incomingByEntity,edge.toId]] as const){
        let list=index.get(id);if(!list){list=[];index.set(id,list);}list.push(edge);
      }
    }
    for(const [index,direction] of [[this.outgoingByEntity,'downstream'],[this.incomingByEntity,'upstream']] as const){
      for(const [id,list] of index){const fallback=this.byId.get(id);
        const name=(edge:RelationFact)=>{const s=this.byId.get(direction==='upstream'?edge.fromId:edge.toId)??fallback;return s?entityName(s):'';};
        list.sort((a,b)=>order(name(a),name(b))||order(a.relation,b.relation)||order(a.id,b.id));Object.freeze(list);
      }
    }
    this.relationIndexBuildCount=1;this.relationIndexBuildMs=performance.now()-indexStarted;
    // Entity ID includes path/file and the nested entity name, as in the reference.
    this.entities=new SparseIndex(this.symbols.map(entityName));
    let bytes=0,disabled=false;const byteLimit=config.contentIndexByteLimit??64*1024*1024,chunkLimit=config.contentIndexChunkLimit??200_000;
    requireThat(Number.isSafeInteger(byteLimit)&&byteLimit>=0&&Number.isSafeInteger(chunkLimit)&&chunkLimit>=0,'Invalid content index bounds');
    // Each file contributes a non-overlapping content stream once. Entity mapping happens per hit.
    for(const [path,source] of Object.entries(data.sources).sort(([a],[b])=>order(a,b))){
      const lines=source.split('\n');
      for(let first=1;first<=lines.length;first+=200){
        const last=Math.min(first+199,lines.length),text=lines.slice(first-1,last).join('\n');bytes+=Buffer.byteLength(text);
        if(bytes>byteLimit||this.chunks.length>=chunkLimit){disabled=true;break;}
        this.chunks.push({path,startLine:first,endLine:last,text});
      }
      if(disabled)break;
    }
    if(disabled){this.chunks=[];this.contentWarning='Content retrieval index is unavailable because its configured bound was exceeded; exact/entity search and graph traversal remain available.';}
    else try{this.contents=new SparseIndex(this.chunks.map(c=>c.text));this.contentDocumentBytes=bytes;}catch{this.chunks=[];this.contentWarning='Content retrieval index failed to initialize; exact/entity search and graph traversal remain available.';}
  }
  stats(){return {relationIndexBuildMs:this.relationIndexBuildMs,relationIndexBuildCount:this.relationIndexBuildCount,entityIndex:this.entities.stats(),contentIndex:this.contents?.stats(),contentDocumentBytes:this.contentDocumentBytes,contentChunks:this.chunks.length,contentAvailable:Boolean(this.contents)};}
  resolveChangeUnits(input: {anchors: import('../../engine/investigation-contracts.ts').ChangeHint[]}) {
    return {...this.envelope(), resolutions: resolveChangeHints(this.symbols, this.data.snapshotId, input.anchors)};
  }
  investigate(input: Parameters<typeof hostStructuralInvestigation>[0]) {
    if (input.context.snapshotId !== this.data.snapshotId || input.context.generationId !== this.data.generationId) throw Error('Investigation identity mismatch');
    const result = hostStructuralInvestigation(input, {
      entity: id => this.byId.get(id), neighbors: (id, direction) => (direction === 'upstream' ? this.incomingByEntity : this.outgoingByEntity).get(id) ?? [],
      compare: (a, b) => order(entityName(a), entityName(b)) || order(a.id, b.id),
    });
    const previews: Record<string, string> = {};
    for (const c of result.pool.eligible) {
      const preview = declarationPreview(this.data.sources[c.terminalPath] ?? '', c.terminalEntity.startLine, c.entityKind);
      if (preview) previews[c.terminalEntityId] = preview;
    }
    return {...this.envelope(), ...result, previews};
  }
  /** Host-only exact metadata query. Uses the same frozen entities; never creates edges. */
  locate(input: { anchors: import('../../engine/dispatch-contracts.ts').AnchorHint[] }) {
    requireThat(Array.isArray(input.anchors) && input.anchors.length > 0 && input.anchors.length <= 32, 'Expected 1..32 observed anchor hints');
    const found = new Map<string, SymbolFact>();
    for (const hint of input.anchors) {
      requireThat(typeof hint.path === 'string' && hint.path.length > 0, 'Exact anchor path required');
      // Search is candidate generation only. The complete file metadata prevents topK
      // or filePattern fallback from silently choosing a different file/scope.
      if (hint.name) this.search({ searchTerms: [hint.name], filePattern: hint.path, topK: 10 });
      let matches = this.symbols.filter(s => s.path === hint.path && s.snapshotId === this.data.snapshotId
        && (hint.kind ? s.kind === hint.kind : s.kind === 'function' || s.kind === 'class')
        && (!hint.name || s.name === hint.name) && (!hint.qualifiedName || s.qualifiedName === hint.qualifiedName)
        && (hint.startLine === undefined || s.startLine <= hint.startLine && s.endLine >= (hint.endLine ?? hint.startLine)));
      if (!hint.kind && hint.startLine !== undefined && matches.length) {
        const narrowest = Math.min(...matches.map(s => s.endLine - s.startLine));
        matches = matches.filter(s => s.endLine - s.startLine === narrowest);
      }
      for (const s of matches) found.set(s.id, s);
    }
    const all = [...found.values()];
    return { ...this.envelope(), items: all.slice(0, 10).map(metadata), truncated: all.length > 10,
      anchorStatus: all.length === 0 ? 'anchor_missing' : all.length === 1 ? 'resolved' : 'anchor_ambiguous' };
  }
  private envelope(){return {status:this.data.coverage.parseIncompleteFiles?'parse_incomplete':this.data.generationState==='partial'?'partial':this.data.coverage.unsupportedFiles||!this.data.coverage.eligibleFiles?'unsupported':'ok',snapshotId:this.data.snapshotId,generationId:this.data.generationId,generationState:this.data.generationState,graphScope:this.data.graphScope,revision:'head',coverage:this.data.coverage,warnings:[...this.data.warnings.slice(0,10).map(w=>w.slice(0,512)),...(this.contentWarning?[this.contentWarning]:[]),'Candidate matches and previews are exploration only; use read_source for evidence.'],explorationOnly:true};}
  private exact(term:string):SymbolFact[]{const found=this.symbols.filter(s=>s.id===term||entityName(s)===term||s.qualifiedName===term);return found.length||!term.endsWith('.__init__')?found:this.exact(term.slice(0,-9));}
  private contentEntity(chunk:{path:string;startLine:number;endLine:number;text:string},term:string):SymbolFact|undefined{
    const lines=chunk.text.split('\n'),needle=term.toLowerCase();let line=chunk.startLine;
    const exact=lines.findIndex(value=>value.toLowerCase().includes(needle));if(exact>=0)line+=exact;
    const overlapping=this.symbols.filter(s=>s.path===chunk.path&&s.kind!=='directory'&&s.startLine<=line&&s.endLine>=line);
    return overlapping.sort((a,b)=>(a.endLine-a.startLine)-(b.endLine-b.startLine)||Number(a.kind==='file')-Number(b.kind==='file')||order(a.id,b.id))[0]
      ??this.symbols.find(s=>s.path===chunk.path&&s.kind==='file');
  }
  private preview(s:SymbolFact,mode:string){
    if(mode==='fold')return {};
    const lines=(this.data.sources[s.path]??'').split('\n'),end=Math.min(s.endLine,s.startLine+(mode==='full'?99:5));
    const selected=lines.slice(s.startLine-1,end).join('\n'),text=Buffer.from(selected).subarray(0,mode==='full'?8192:1024).toString('utf8');
    return {preview:{revision:'head',path:s.path,startLine:s.startLine,endLine:end,text,truncated:end<s.endLine||text!==selected,explorationOnly:true}};
  }
  search(input:SearchInput){
    requireThat(this.config.searchEntityEnabled!==false,'search_entity disabled by eval configuration');
    requireThat(Array.isArray(input.searchTerms)&&input.searchTerms.length>=1&&input.searchTerms.length<=5&&input.searchTerms.every(t=>typeof t==='string'&&t.trim().length>0&&t.length<=256),'Expected 1..5 bounded search terms');
    requireThat(Number.isInteger(input.topK)&&input.topK>=1&&input.topK<=10,'topK must be 1..10');
    requireThat(input.filePattern===undefined||typeof input.filePattern==='string'&&input.filePattern.length>0&&input.filePattern.length<=256,'Invalid file pattern');
    const selected=this.symbols.filter(s=>!input.filePattern||glob(input.filePattern,s.path));
    const include=selected.length?new Set(selected.map(s=>s.id)):new Set(this.symbols.map(s=>s.id));
    type Hit={s:SymbolFact;matchMode:string;score?:number;renderMode:string;query:string;contentRange?:{startLine:number;endLine:number}};
    const hits:Hit[]=[],stages:{query:string;exactIdHits:number;exactNameHits:number;bm25EntityCalls:number;bm25ContentCalls:number;fuzzyCalls:number}[]=[];
    const terms=[...input.searchTerms];if(terms.length>1)terms.push(terms.join(' '));
    for(const raw of terms){
      const term=raw.trim().replace(/^\.+|\.+$/g,'');if(!term)continue;
      const stage={query:term,exactIdHits:0,exactNameHits:0,bm25EntityCalls:0,bm25ContentCalls:0,fuzzyCalls:0};stages.push(stage);
      let found=this.exact(term);
      if(found.length===1){stage.exactIdHits=1;hits.push({s:found[0]!,matchMode:'exact_id',renderMode:terms.length===1?'full':'preview',query:term});continue;}
      let clean=term.replace(/^(class|function|method|def)\s+/i,'');
      const byName=(name:string,scope:boolean)=>{const candidates=this.symbols.filter(s=>!scope||include.has(s.id));const names=(s:SymbolFact)=>[s.name,...(s.kind==='file'?[s.path.split('/').at(-1)!,s.path.split('/').at(-1)!.replace(/\.py$/,'')]:[])];const exact=candidates.filter(s=>names(s).includes(name));return exact.length?exact:candidates.filter(s=>names(s).some(n=>n.toLowerCase()===name.toLowerCase()));};
      found=byName(clean,true);if(!found.length)found=byName(clean,false);
      let continueSparse=false;
      if(!found.length&&clean.includes('.')){
        const names=clean.split('.'),suffix=names.pop()!,prefix=names.map(s=>s.toLowerCase());
        const all=byName(suffix,false),matching=all.filter(s=>prefix.every(p=>entityName(s).toLowerCase().replace('.py','').split(/[./:]/).slice(0,-1).includes(p)));
        found=matching.length?matching:all;continueSparse=!matching.length;
      }
      if(found.length){stage.exactNameHits=found.length;for(const s of found)hits.push({s,matchMode:'exact_name',renderMode:found.length<=3?'preview':'fold',query:term});if(!continueSparse)continue;}
      if(this.config.bm25Enabled!==false){
        stage.bm25EntityCalls++;
        const all=this.entities.search(term,10),local=all.filter(r=>include.has(this.symbols[r.index]!.id));
        for(const row of (local.length?local:all).slice(0,5)){const s=this.symbols[row.index]!;hits.push({s,matchMode:'bm25_entity',score:row.score,renderMode:['directory','file'].includes(s.kind)?'fold':'preview',query:term});}
        // Reference keeps continue_search true after BM25 entity hits, so content is supplemental.
        if(this.contents){stage.bm25ContentCalls++;
          const chunks=this.contents.search(term,10).map(row=>({row,chunk:this.chunks[row.index]!,symbol:this.contentEntity(this.chunks[row.index]!,term)})).filter(value=>value.symbol&&include.has(value.symbol.id));
          for(const {row,chunk,symbol} of chunks.slice(0,5))hits.push({s:symbol!,matchMode:'bm25_content',score:row.score,renderMode:symbol!.kind==='file'?'fold':'preview',query:term,contentRange:{startLine:chunk.startLine,endLine:chunk.endLine}});
        }
      }
      // Task requires fuzzy LAST. Reference invokes it before content; explicitly documented adaptation.
      if(this.config.fuzzyEnabled!==false&&!hits.some(h=>h.query===term)){
        stage.fuzzyCalls++;
        const candidates=this.symbols.map(s=>({s,score:fuzzyScore(term,entityName(s))})).sort((a,b)=>b.score-a.score||order(entityName(a.s),entityName(b.s))).slice(0,3);
        for(const row of candidates)hits.push({s:row.s,matchMode:'fuzzy',score:row.score,renderMode:['directory','file'].includes(row.s.kind)?'fold':'preview',query:term});
      }
    }
    // Preserve all retrieval modes on deduplicated entities, while retaining exact-first ordering.
    const grouped=new Map<string,Hit[]>();for(const h of hits)grouped.set(h.s.id,[...grouped.get(h.s.id)??[],h]);
    const all=[...grouped.values()];let truncated=all.length>input.topK;
    const result={...this.envelope(),items:[] as Record<string,unknown>[],truncated:false,stages,resultCount:0,renderMode:'fold',retrievalMode:[...new Set(hits.map(h=>h.matchMode))],responseBytes:0};
    for(const group of all.slice(0,input.topK)){
      const priority:Record<string,number>={full:0,preview:1,fold:2};
      const first=[...group].sort((a,b)=>priority[a.renderMode]!-priority[b.renderMode]!)[0]!;let mode=this.config.sourcePolicy==='fold'?'fold':this.config.sourcePolicy==='preview'&&first.renderMode==='full'?'preview':first.renderMode;
      if(all.length>3)mode='fold';
      const item={...metadata(first.s),matchMode:first.matchMode,matchModes:[...new Set(group.map(h=>h.matchMode))],renderMode:mode,...(first.score!==undefined?{retrievalScore:first.score}:{}),matches:group.map(h=>({query:h.query,matchMode:h.matchMode,...(h.score!==undefined?{retrievalScore:h.score}:{}),...(h.contentRange?{contentRange:h.contentRange}:{})})),...this.preview(first.s,mode)};
      result.items.push(item);if(size(result)>30_000){result.items.pop();truncated=true;break;}
    }
    result.truncated=truncated;result.resultCount=result.items.length;result.renderMode=[...new Set(result.items.map(i=>String(i.renderMode)))].join('+')||'fold';
    if(truncated)result.warnings.push('Bounded candidate output; refine the query to retrieve omitted entities.');
    return measured(result);
  }
  private prepareTraversal(input:TraverseInput){
    requireThat(this.config.traverseEnabled!==false,'traverse_graph disabled by eval configuration');
    requireThat(Array.isArray(input.startEntities)&&input.startEntities.length>=1&&input.startEntities.length<=5&&input.startEntities.every(s=>typeof s==='string'&&s.length>0&&s.length<=512),'Expected 1..5 bounded start entities');
    requireThat(['upstream','downstream','both'].includes(input.direction),'Invalid direction');
    requireThat(Number.isInteger(input.maxHops)&&input.maxHops>=1&&input.maxHops<=20,'maxHops must be 1..20');
    requireThat(Number.isInteger(input.maxNodes)&&input.maxNodes>=1&&input.maxNodes<=100,'maxNodes must be 1..100');
    requireThat(Array.isArray(input.entityTypeFilter)&&input.entityTypeFilter.every(k=>['directory','file','class','function'].includes(k)),'Invalid entity type filter');
    requireThat(Array.isArray(input.relationTypeFilter)&&input.relationTypeFilter.every(k=>['CONTAINS','IMPORTS','CALLS','INHERITS'].includes(k)),'Invalid relation type filter');
    const maxBytes=input.maxBytes??32768;requireThat(Number.isInteger(maxBytes)&&maxBytes>=2048&&maxBytes<=32768,'maxBytes must be 2048..32768');
    const maxHops=Math.min(input.maxHops,this.config.maxHops??20);
    const roots:SymbolFact[]=[],hints:{query:string;matchMode:string;candidates:ReturnType<typeof metadata>[]}[]=[];
    for(const id of input.startEntities){const found=this.exact(id);if(found.length===1)roots.push(found[0]!);else hints.push({query:id,matchMode:'bm25_entity',candidates:this.entities.search(id,10).slice(0,5).map(r=>metadata(this.symbols[r.index]!))});}
    requireThat(new Set(roots.map(r=>r.id)).size<=input.maxNodes,'maxNodes is smaller than the root set');
    return {roots,hints,maxBytes,maxHops};
  }
  /** Bounded DFS in historical entity/relation/direction order. No rendering or byte checks. */
  walkGraph(input:TraverseInput, budget:ExplorationBudget={maxVisitedNodes:input.maxNodes,maxVisitedEdges:100_000,maxExpandedStates:10_000}, signal?:AbortSignal){
    const prepared=this.prepareTraversal(input),{roots,maxHops}=prepared;
    for(const [key,value] of Object.entries(budget))requireThat(Number.isSafeInteger(value)&&value>=1,'Invalid exploration budget: '+key);
    requireThat(budget.maxVisitedNodes>=new Set(roots.map(s=>s.id)).size,'Exploration budget is smaller than root set');
    const discoveries:{entity:SymbolFact;depth:number;rootEntityId:string;direction:string;via?:RelationFact;parentStateId?:number;stateId:number;show:boolean}[]=[];
    const nodeIds=new Set<string>();let visitedEdges=0,expandedStates=0,stopped=false;
    let stopReason='exhausted';
    const stop=(reason:string)=>{stopReason=reason;stopped=true;};
    for(const root of roots){
      const bestDepth=new Map<string,number>(),structuralEdges=new Set<string>();
      const visit=(s:SymbolFact,depth:number,direction:string,via?:RelationFact,parentStateId?:number)=>{
        signal?.throwIfAborted();if(stopped)return;
        const state=`${s.id}:${input.direction==='both'?'both':direction}`,previous=bestDepth.get(state),improves=previous===undefined||depth<previous;
        const structuralKey=via?JSON.stringify([via.fromId,via.relation,via.toId]):undefined,show=!structuralKey||!structuralEdges.has(structuralKey);
        if(!show&&!improves)return;
        if(!nodeIds.has(s.id)&&nodeIds.size>=budget.maxVisitedNodes){stopReason='visited_nodes';return;}
        if(expandedStates>=budget.maxExpandedStates){stop('expanded_states');return;}
        expandedStates++;nodeIds.add(s.id);if(improves)bestDepth.set(state,depth);if(structuralKey&&show)structuralEdges.add(structuralKey);
        const stateId=discoveries.length;discoveries.push({entity:s,depth,rootEntityId:root.id,direction,...(via?{via}:{}),...(parentStateId===undefined?{}:{parentStateId}),stateId,show});
        if(depth>=maxHops||!improves)return;
        const dirs=input.direction==='both'?['downstream','upstream']:[direction];
        for(const dir of dirs){
          for(const edge of (dir==='upstream'?this.incomingByEntity:this.outgoingByEntity).get(s.id)??[]){
            signal?.throwIfAborted();if(stopped)return;
            if(visitedEdges>=budget.maxVisitedEdges){stop('visited_edges');return;}visitedEdges++;
            const next=this.byId.get(dir==='upstream'?edge.fromId:edge.toId);if(!next)continue;
            if(input.relationTypeFilter.length&&!input.relationTypeFilter.includes(edge.relation)||input.entityTypeFilter.length&&!input.entityTypeFilter.includes(next.kind))continue;
            visit(next,depth+1,dir,edge,stateId);
          }
        }
      };
      visit(root,0,input.direction);
    }
    return {...prepared,discoveries,visitedNodes:nodeIds.size,visitedEdges,expandedStates,stopReason,
      coverageLimited:this.envelope().status!=='ok'||stopReason!=='exhausted'};
  }
  private renderTraversal(input:TraverseInput,search:ReturnType<LocAgentRetrieval['walkGraph']>,compact=false){
    const {maxHops,maxBytes,roots}=search,hints=structuredClone(search.hints);
    const items:Record<string,unknown>[]=[],edges:RelationFact[]=[],lines:string[]=[],nodeIds=new Set<string>(),edgeIds=new Set<string>();
    const result={...this.envelope(),items,edges,...(compact?{}:{tree:''}),hints,truncated:search.stopReason!=='exhausted',maxHops,direction:input.direction,resultCount:0,returnedEdges:0,responseBytes:0,
      ...(compact?{searchMetrics:{visitedNodes:search.visitedNodes,visitedEdges:search.visitedEdges,expandedStates:search.expandedStates,stopReason:search.stopReason,coverageLimited:search.coverageLimited},renderStopReason:'exhausted'}:{})};
    if(hints.length)result.warnings.push('Invalid start entities were not traversed. BM25 hints identify candidates only; retry with an exact returned entity ID. Empty output does not establish absence.');
    while(size(result)>maxBytes-512&&hints.some(h=>h.candidates.length)){hints.findLast(h=>h.candidates.length)!.candidates.pop();result.truncated=true;}
    while(size(result)>maxBytes-512&&hints.length){hints.pop();result.truncated=true;}
    let omittedDiagnostics=false;
    while(size(result)>maxBytes-512&&result.warnings.length>1){result.warnings.shift();result.truncated=true;omittedDiagnostics=true;}
    if(omittedDiagnostics)result.warnings.unshift('Some diagnostic details were omitted to respect maxBytes; inspect coverage.');
    for(const d of search.discoveries){
      const s=d.entity,via=d.via,fresh=!nodeIds.has(s.id);
      if(fresh&&nodeIds.size>=input.maxNodes){result.truncated=true;if(compact)result.renderStopReason='max_nodes';break;}
      if(fresh){nodeIds.add(s.id);items.push({...metadata(s),depth:d.depth,rootEntityId:d.rootEntityId,...(via?{discoveredVia:{edgeId:via.id,relation:via.relation,direction:d.direction,resolution:via.resolution,pathResolved:true}}:{})});}
      const newEdge=d.show&&via&&!edgeIds.has(via.id);if(newEdge){edges.push(via);edgeIds.add(via.id);}
      if(d.show&&!compact)lines.push(d.depth===0?`${entityName(s)} [${s.kind}; id=${s.id}]`:`${'    '.repeat(d.depth)}└── ${via!.relation}${d.direction==='upstream'?'-by ←':' →'} [${via!.resolution}] ${entityName(s)} [${s.kind}; id=${s.id}]`);
      if(edges.length>200||size({...result,...(compact?{}:{tree:lines.join('\n')})})>maxBytes-512){
        if(d.show&&!compact)lines.pop();if(fresh){nodeIds.delete(s.id);items.pop();}if(newEdge){edges.pop();edgeIds.delete(via!.id);}result.truncated=true;if(compact)result.renderStopReason=edges.length>=200?'max_edges':'max_bytes';break;
      }
    }
    if(!compact)result.tree=lines.join('\n');result.resultCount=items.length;result.returnedEdges=edges.length;
    if(result.truncated)result.warnings.push('Traversal output bound reached; query a narrower root/filter/depth. Omitted nodes do not establish absence.');
    if(!items.length&&roots.length)throw Error('Even one entity exceeds the requested output bound');
    measured(result);requireThat(size(result)<=maxBytes,'Traversal envelope exceeds requested output bound');
    return result;
  }
  traverse(input:TraverseInput){return this.renderTraversal(input,this.walkGraph(input));}
  /** V2 offline experimental consumer; never selected by the legacy tool or dispatch_v1. */
  patternWalk(input:TraverseInput,signal?:AbortSignal){
    const prepared=this.prepareTraversal(input);
    requireThat(input.direction==='both'&&input.maxHops===3&&input.entityTypeFilter.length===0
      &&JSON.stringify([...input.relationTypeFilter].sort())===JSON.stringify(['CALLS','IMPORTS','INHERITS']),'Pattern experiment requires frozen escalation query');
    return {...prepared,...progressiveWalk(prepared.roots,STRUCTURAL_PATTERNS,{maxVisitedNodes:input.maxNodes,maxVisitedEdges:200,maxExpandedStates:200},4,{
      entity:id=>this.byId.get(id),neighbors:(id,dir)=>(dir==='upstream'?this.incomingByEntity:this.outgoingByEntity).get(id)??[],
      compare:(a,b)=>order(entityName(a),entityName(b))||order(a.id,b.id)
    },signal)};
  }
  patternTraverse(input:TraverseInput,signal?:AbortSignal){
    const search=this.patternWalk(input,signal),rootPaths=new Set(search.roots.map(r=>r.path));
    const items:Record<string,unknown>[]=[],edges:RelationFact[]=[];
    const result={...this.envelope(),items,edges,hints:search.hints,truncated:search.coverageLimited,maxHops:search.maxHops,direction:input.direction,resultCount:0,returnedEdges:0,responseBytes:0,
      searchMetrics:{visitedNodes:search.visitedNodes,visitedEdges:search.visitedEdges,expandedStates:search.expandedStates,stopReason:search.stopReason,coverageLimited:search.coverageLimited||this.envelope().status!=='ok',frontierDropped:search.frontierDropped},renderStopReason:'exhausted'};
    // Reserve room for path metadata, retaining the coverage object and explicit warning.
    while(size(result)>search.maxBytes-1024&&result.warnings.length>1){result.warnings.shift();result.truncated=true;}
    const item=(d:typeof search.discoveries[number])=>{const m=metadata(d.entity);return {entityId:m.entityId,snapshotId:m.snapshotId,path:m.path,name:m.name,qualifiedName:m.qualifiedName,kind:m.kind,startLine:m.startLine,endLine:m.endLine,depth:d.depth,rootEntityId:d.rootEntityId};};
    const nodeIds=new Set<string>(),edgeIds=new Set<string>();
    for(const root of search.roots){const d=search.discoveries.find(d=>d.entity.id===root.id)!;if(!nodeIds.has(root.id)){items.push(item(d));nodeIds.add(root.id);}}
    const candidates=search.discoveries.filter(d=>d.depth>0).sort((a,b)=>Number(rootPaths.has(a.entity.path))-Number(rootPaths.has(b.entity.path))||a.depth-b.depth||order(a.entity.path,b.entity.path)||a.entity.startLine-b.entity.startLine||order(a.entity.id,b.entity.id)||a.stateId-b.stateId);
    for(const candidate of candidates){
      signal?.throwIfAborted();const chain:typeof search.discoveries=[];let d:typeof candidate|undefined=candidate;
      while(d){chain.unshift(d);d=d.parentStateId===undefined?undefined:search.discoveries[d.parentStateId];}
      const newNodes=chain.filter(d=>!nodeIds.has(d.entity.id)).filter((d,i,a)=>a.findIndex(x=>x.entity.id===d.entity.id)===i),newEdges=chain.filter(d=>d.via&&!edgeIds.has(d.via.id)).map(d=>d.via!);
      const beforeNodes=items.length,beforeEdges=edges.length;items.push(...newNodes.map(item));edges.push(...newEdges);
      if(items.length>input.maxNodes||size(result)>search.maxBytes-512){items.length=beforeNodes;edges.length=beforeEdges;result.truncated=true;result.renderStopReason='max_bytes';continue;}
      for(const d of newNodes)nodeIds.add(d.entity.id);for(const e of newEdges)edgeIds.add(e.id);
    }
    result.resultCount=items.length;result.returnedEdges=edges.length;
    if(result.truncated)result.warnings.push('Bounded pattern frontier or candidate delivery; omitted paths do not establish absence.');
    measured(result);requireThat(size(result)<=search.maxBytes,'Pattern envelope exceeds requested output bound');return result;
  }
  /** Host-only consumer; exploration caps do not depend on the delivery byte limit. */
  hostTraverse(input:TraverseInput,signal?:AbortSignal){
    return this.renderTraversal(input,this.walkGraph(input,{maxVisitedNodes:input.maxNodes,maxVisitedEdges:200,maxExpandedStates:200},signal),true);
  }
}
