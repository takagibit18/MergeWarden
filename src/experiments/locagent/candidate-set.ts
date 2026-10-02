import {classifyPythonPath} from '../../graph/scope-policy.ts';
import type {CandidateUnit} from './path-candidates.ts';
import type {RetainedGraph} from './path-retention.ts';

export const CANDIDATE_SLOTS = 3;
export interface SelectionContext {
  snapshotId: string; generationId: string; route: string;
  changedPaths: readonly string[];
  visibleRanges: readonly {path: string; startLine: number; endLine: number}[];
}
export interface PathCandidate extends CandidateUnit {
  terminalEntityId: string;
  sourceRange: {startLine: number; endLine: number};
  entityKind: string; patternIds: string[]; relationSequences: string[][];
  rootEntityIds: string[]; rootPaths: string[];
  distinctPredecessorCount: number; pathSupportCount: number;
  changed: boolean; classification: string; alreadyVisible: boolean; sameRootFile: boolean;
  buckets: {depth: 'shallow'|'multi_hop'; file: 'root_file'|'cross_file'; visibility: 'already_visible'|'unseen'; change: 'changed'|'untouched'};
}
const cmp = (a: string,b: string) => a < b ? -1 : a > b ? 1 : 0;
const pathKey = (p: CandidateUnit['bestPath']) => JSON.stringify([p.stateIds,p.entityIds,p.edgeIds,p.directions,p.patternId,p.depth]);
/** Validate and annotate the frozen pool. Never reconstruct paths or acquire graph/source data. */
export function describeCandidates(units: readonly CandidateUnit[], graph: RetainedGraph, context: SelectionContext) {
  const states = new Map(graph.states.map(s=>[s.stateId,s]));
  const eligible: PathCandidate[] = [], rejected: {entityId: string; reason: string}[] = [];
  for (const u of [...units].sort((a,b)=>cmp(a.terminalEntity.id,b.terminalEntity.id))) {
    const e = u.terminalEntity;
    let reason = '';
    if (graph.snapshotId!==context.snapshotId || graph.generationId!==context.generationId || u.snapshotId!==context.snapshotId || u.generationId!==context.generationId || e.snapshotId!==context.snapshotId) reason='identity_mismatch';
    else if (!['file','class','function'].includes(e.kind) || !e.path || u.terminalPath!==e.path || !Number.isInteger(e.startLine) || !Number.isInteger(e.endLine) || e.startLine<1 || e.endLine<e.startLine) reason='invalid_source_location';
    else if (!graph.states.some(s=>JSON.stringify(s.entity)===JSON.stringify(e))) reason='terminal_not_in_frozen_states';
    else if (!u.retainedPaths.length || u.retainedPaths.length>2 || !u.retainedPaths.some(p=>pathKey(p)===pathKey(u.bestPath)) || u.depth!==u.bestPath.depth) reason='invalid_retained_paths';
    const sequences: string[][] = [], roots: string[] = [], rootPaths: string[] = [];
    for (const p of u.retainedPaths) {
      const first=states.get(p.stateIds[0]!),last=states.get(p.stateIds.at(-1)!);
      if (!Number.isInteger(p.depth) || p.depth<1 || p.depth>3 || p.stateIds.length!==p.depth+1 || p.entityIds.length!==p.depth+1 || p.edgeIds.length!==p.depth || p.directions.length!==p.depth || !first || !last || first.stepIndex!==0 || first.entity.id!==first.rootEntityId || p.entityIds.at(-1)!==e.id || last.entity.id!==e.id || !last.paths.some(x=>pathKey(x)===pathKey(p))) { reason ||= 'incomplete_or_unretained_path'; continue; }
      const sequence: string[]=[];
      for (let i=0;i<=p.depth;i++) {
        const s=states.get(p.stateIds[i]!);
        if (!s || s.stepIndex!==i || s.patternId!==p.patternId || s.entity.id!==p.entityIds[i] || s.rootEntityId!==first.entity.id || s.entity.snapshotId!==context.snapshotId) {reason ||= 'invalid_path_state';continue;}
        if (!i) continue;
        const link=s.predecessorPaths.find(l=>l.previousStateId===p.stateIds[i-1] && l.stateId===s.stateId && l.edge.id===p.edgeIds[i-1] && l.direction===p.directions[i-1]);
        const edge=link?.edge,up=p.directions[i-1]==='upstream';
        if (!edge || !['upstream','downstream'].includes(p.directions[i-1]!) || edge.snapshotId!==context.snapshotId || !['resolved_scoped','resolved_import_alias'].includes(edge.resolution) || edge.fromId!==p.entityIds[up?i:i-1] || edge.toId!==p.entityIds[up?i-1:i]) reason ||= 'invalid_provenance_edge';
        else sequence.push(edge.relation);
      }
      sequences.push(sequence); roots.push(first.entity.id); rootPaths.push(first.entity.path);
    }
    if (reason) {rejected.push({entityId:e.id,reason});continue;}
    const changed=context.changedPaths.includes(e.path),alreadyVisible=context.visibleRanges.some(r=>r.path===e.path && r.startLine<=e.startLine && r.endLine>=e.endLine),sameRootFile=rootPaths.includes(e.path);
    eligible.push({...u,terminalEntityId:e.id,sourceRange:{startLine:e.startLine,endLine:e.endLine},entityKind:e.kind,
      patternIds:[...new Set(u.retainedPaths.map(p=>p.patternId))].sort(cmp),relationSequences:sequences,
      rootEntityIds:[...new Set(roots)].sort(cmp),rootPaths:[...new Set(rootPaths)].sort(cmp),
      distinctPredecessorCount:Math.min(2,new Set(u.retainedPaths.map(p=>p.entityIds.at(-2))).size),
      pathSupportCount:Math.min(2,new Set(u.retainedPaths.map(p=>JSON.stringify([p.entityIds,p.edgeIds,p.directions,p.patternId]))).size),
      changed,classification:classifyPythonPath(e.path),alreadyVisible,sameRootFile,
      buckets:{depth:u.depth>=2?'multi_hop':'shallow',file:sameRootFile?'root_file':'cross_file',visibility:alreadyVisible?'already_visible':'unseen',change:changed?'changed':'untouched'}});
  }
  return {eligible:eligible.sort((a,b)=>cmp(a.terminalPath,b.terminalPath)||a.sourceRange.startLine-b.sourceRange.startLine||cmp(a.terminalEntityId,b.terminalEntityId)),rejected};
}

export type SelectionReason = 'multi_hop_obligation'|'cross_file_obligation'|'pattern_diversity'|'stable_fill'|'direct_caller'|'import_template'|'inheritance_terminal';
export interface CandidateChoice {candidate: PathCandidate; selectedBecause: SelectionReason}
const routeCompatible = (u: PathCandidate, route: string) => u.retainedPaths.some((p,i)=>
  route==='CALLER_CHECK' ? p.depth===1 && p.directions[0]==='upstream' && u.relationSequences[i]?.every(r=>r==='CALLS')
  : route==='IMPORT_CHECK' ? u.relationSequences[i]?.every(r=>r==='IMPORTS')
  : route==='INHERITANCE_CHECK' ? u.relationSequences[i]?.every(r=>r==='INHERITS') : true);
/** Fixed slots, explicit coverage obligations, then stable fill. No I/O or target labels. */
export function selectCandidateSet(pool: readonly PathCandidate[], context: SelectionContext, importTemplateOrder: readonly string[] = []) {
  const selected: CandidateChoice[] = [], remaining=[...pool];
  const compare=(a:PathCandidate,b:PathCandidate)=>Number(a.alreadyVisible)-Number(b.alreadyVisible)
    ||Number(a.changed || a.classification!=='production')-Number(b.changed || b.classification!=='production')
    ||b.pathSupportCount-a.pathSupportCount||Number(a.sameRootFile)-Number(b.sameRootFile)
    ||Number(!routeCompatible(a,context.route))-Number(!routeCompatible(b,context.route))
    ||a.depth-b.depth||cmp(a.terminalPath,b.terminalPath)||a.sourceRange.startLine-b.sourceRange.startLine||cmp(a.terminalEntityId,b.terminalEntityId);
  const sameRange=(a:PathCandidate,b:PathCandidate)=>a.terminalPath===b.terminalPath && a.sourceRange.startLine===b.sourceRange.startLine && a.sourceRange.endLine===b.sourceRange.endLine;
  const available=()=>remaining.filter(u=>!selected.some(s=>s.candidate.terminalEntityId===u.terminalEntityId || sameRange(s.candidate,u)));
  const take=(u:PathCandidate,reason:SelectionReason)=>{selected.push({candidate:u,selectedBecause:reason});remaining.splice(remaining.indexOf(u),1);};
  const best=(choices:PathCandidate[],reason:SelectionReason)=>{if(selected.length<CANDIDATE_SLOTS && choices.length)take(choices.sort(compare)[0]!,reason);};
  const covered=()=>new Set(selected.flatMap(s=>s.candidate.patternIds));
  if(context.route==='IMPORT_CHECK') {
    for(const id of importTemplateOrder){const u=available().find(u=>u.terminalEntityId===id && routeCompatible(u,context.route));if(u && selected.length<CANDIDATE_SLOTS)take(u,'import_template');}
  } else if(context.route==='CALLER_CHECK' || context.route==='INHERITANCE_CHECK') {
    for(const u of available().filter(u=>routeCompatible(u,context.route)).sort(compare)) {
      if(selected.length>=CANDIDATE_SLOTS)break;
      if(available().includes(u))take(u,context.route==='CALLER_CHECK'?'direct_caller':'inheritance_terminal');
    }
  } else {
    best(available().filter(u=>u.depth>=2),'multi_hop_obligation');
    if(!selected.some(s=>!s.candidate.sameRootFile))best(available().filter(u=>!u.sameRootFile),'cross_file_obligation');
    while(selected.length<CANDIDATE_SLOTS){const lanes=covered(),novel=available().filter(u=>u.patternIds.some(p=>!lanes.has(p)));if(!novel.length)break;best(novel,'pattern_diversity');}
  }
  const overlaps=(u:PathCandidate)=>selected.some(({candidate:s})=>s.terminalPath===u.terminalPath &&
    Math.max(0,Math.min(s.sourceRange.endLine,u.sourceRange.endLine)-Math.max(s.sourceRange.startLine,u.sourceRange.startLine)+1)/Math.min(s.sourceRange.endLine-s.sourceRange.startLine+1,u.sourceRange.endLine-u.sourceRange.startLine+1)>=0.8);
  while(selected.length<CANDIDATE_SLOTS){
    const choices=available(),files=new Set(selected.map(s=>s.candidate.terminalPath));if(!choices.length)break;
    choices.sort((a,b)=>Number(files.has(a.terminalPath))-Number(files.has(b.terminalPath))||Number(overlaps(a))-Number(overlaps(b))||compare(a,b));take(choices[0]!,'stable_fill');
  }
  const structural=context.route==='STRUCTURAL_ESCALATION';
  return {selected,omitted:remaining.sort(compare).map(u=>u.terminalEntityId),obligations:{
    applicable:structural,
    multiHop:!structural || !pool.some(u=>u.depth>=2) || selected.some(s=>s.candidate.depth>=2),
    crossFile:!structural || !pool.some(u=>!u.sameRootFile) || selected.some(s=>!s.candidate.sameRootFile),
    patternEligibleCount:new Set(pool.flatMap(u=>u.patternIds)).size,patternSelectedCount:covered().size},candidateSlots:CANDIDATE_SLOTS};
}
