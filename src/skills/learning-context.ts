import { digest } from './bank.ts';
import { SKILL_LIMITS } from './contracts.ts';
import type { LearningCatalogEntry, LearningInput, Skill, SkillSource } from './contracts.ts';

export const LEARNING_CONTEXT_VERSION = 'learning-context-1';
export const LEARNING_CONTEXT_LIMITS = Object.freeze({catalog:8,bodies:3,contextBytes:12000});
const weights = Object.freeze({path:8,symbol:4,keyword:3,title:2,condition:1});
export const LEARNING_CONTEXT_POLICY_SHA256 = digest({version:LEARNING_CONTEXT_VERSION,limits:LEARNING_CONTEXT_LIMITS,weights,
  boundary:'repository and explicit language compatibility; unknown language remains eligible',
  ranking:'positive overlap only; unique cue hits capped at 3, title/condition terms at 6; ID codepoint tie-break',
  summary:'title 140 codepoints; first 2 conditions, 180 codepoints each; no generated summary',
  allocation:'catalog then complete managed trial/active bodies in rank order; pretty JSON UTF-8 budgets'});
/** Matches writeJson's on-disk representation, including escaping, indentation and final newline. */
export const learningJsonBytes = (value:unknown):number => Buffer.byteLength(JSON.stringify(value,null,2)+'\n','utf8');
const stopWords = new Set('when where which with this that from into then than only must should before after changes change check inspect compare source current original skill review method contract conditions function return input output code file'.split(' '));
const terms = (text:string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu)??[]).filter(t=>t.length>=3&&!stopWords.has(t)));
const clip = (s:string,n:number) => Array.from(s).slice(0,n).join('');
const languages:Record<string,string>={py:'Python',pyi:'Python',js:'JavaScript',jsx:'JavaScript',ts:'TypeScript',tsx:'TypeScript',rs:'Rust',go:'Go',java:'Java',rb:'Ruby',c:'C',h:'C',cpp:'C++',hpp:'C++',cs:'C#'};
type BaseInput = Omit<LearningInput,'relevantSkills'|'existingSkills'>;

/** Pure, learning-only selection: coverage of old knowledge, never Review eligibility. */
export function selectLearningContext(base:BaseInput, bankSkills:readonly Skill[], supportSources:Readonly<Record<string,SkillSource>> = {}):LearningInput {
  const pages=base.sourcePages as Array<{path?:string;text?:string;fileHash?:string}>;
  const report=base.report as {findings?:Array<{evidence?:Array<{path:string}>}>};
  const paths=[...new Set([...pages.flatMap(p=>p.path?[p.path]:[]),...(base.source.range?[base.source.range.path]:[]),...(report.findings??[]).flatMap(f=>(f.evidence??[]).map(e=>e.path))])];
  const query=JSON.stringify({report:base.report,feedback:base.source.comment??'',pages:base.sourcePages}).toLowerCase(),queryTerms=terms(query);
  const queryLanguages=new Set(paths.flatMap(p=>{const l=languages[p.split('.').at(-1)??''];return l?[l.toLowerCase()]:[];}));
  const compatible=bankSkills.filter(s=>s.repositoryKey===base.source.repositoryKey&&(!queryLanguages.size||!s.languages.length||s.languages.some(l=>queryLanguages.has(l.toLowerCase()))));
  const overlap=(text:string)=>Math.min(6,[...terms(text)].filter(t=>queryTerms.has(t)).length);
  const hits=(cues:readonly string[])=>Math.min(3,[...new Set(cues.map(s=>s.toLowerCase()).filter(Boolean))].filter(s=>query.includes(s)).length);
  const ranked=compatible.map(skill=>{
    const path=Number(skill.paths.some(p=>paths.some(f=>f===p||f.startsWith(p+'/')))),symbol=hits(skill.symbols??[]),keyword=hits(skill.keywords),title=overlap(skill.title),condition=overlap(skill.conditions.join(' '));
    const score=path*weights.path+symbol*weights.symbol+keyword*weights.keyword+title*weights.title+condition*weights.condition;
    return {skill,score,reason:`path=${path}; symbols=${symbol}; keywords=${keyword}; titleTerms=${title}; conditionTerms=${condition}`};
  }).filter(s=>s.score>0).sort((a,b)=>b.score-a.score||(a.skill.id<b.skill.id?-1:a.skill.id>b.skill.id?1:0));
  type Ranked = typeof ranked[number];
  const sourceRef=digest(base.source);
  const assemble=(selected:Ranked[],bodies:Skill[]):LearningInput=>{
    const catalog:LearningCatalogEntry[]=selected.map(({skill:s,score,reason})=>{
      const title=clip(s.title,140),conditions=s.conditions.slice(0,2).map(c=>clip(c,180)),bodyProvided=bodies.some(b=>b.id===s.id);
      return {id:s.id,revision:s.revision,title,conditions,summaryTruncated:title!==s.title||conditions.length!==s.conditions.length||conditions.some((c,i)=>c!==s.conditions[i]),
        ...(s.scopeType?{scopeType:s.scopeType}:{}),type:s.type,state:s.state,owner:s.owner,bodyProvided,readOnly:!bodyProvided,score,selectionReason:reason,
        support:{currentSource:s.sources.includes(sourceRef),sameSnapshot:s.sources.some(r=>supportSources[r]?.snapshotId===base.source.snapshotId),sameIndependenceKey:s.sources.some(r=>supportSources[r]?.independenceKey===base.source.independenceKey)},
        dependenciesAvailable:s.dependencies.every(d=>pages.some(p=>p.path===d.path&&p.fileHash===d.hash))};
    });
    return {...base,relevantSkills:bodies,existingSkills:{version:LEARNING_CONTEXT_VERSION,policySha256:LEARNING_CONTEXT_POLICY_SHA256,limits:LEARNING_CONTEXT_LIMITS,
      bankCount:bankSkills.length,candidateCount:compatible.length,rankedCount:ranked.length,catalogOmittedCount:compatible.length-catalog.length,bodyOmittedCount:compatible.length-bodies.length,catalog}};
  };
  const fits=(input:LearningInput)=>learningJsonBytes({existingSkills:input.existingSkills,relevantSkills:input.relevantSkills})<=LEARNING_CONTEXT_LIMITS.contextBytes&&learningJsonBytes(input)<=SKILL_LIMITS.inputBytes;
  const selected:Ranked[]=[],bodies:Skill[]=[];
  if(!fits(assemble(selected,bodies)))throw Error('Learning input exceeds bounded byte limit without existing knowledge');
  for(const r of ranked){if(selected.length>=LEARNING_CONTEXT_LIMITS.catalog)break;if(fits(assemble([...selected,r],bodies)))selected.push(r);}
  for(const r of selected){if(bodies.length>=LEARNING_CONTEXT_LIMITS.bodies)break;if(r.skill.owner!=='learner'||!['trial','active'].includes(r.skill.state))continue;if(fits(assemble(selected,[...bodies,r.skill])))bodies.push(r.skill);}
  // Selection and whole-body omission finish before any opaque identities are minted.
  return structuredClone(assemble(selected,bodies));
}
