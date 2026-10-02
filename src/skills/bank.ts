import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256, writeJson, safePath } from '../infrastructure/files.ts';
import { BASE_SYSTEM_PROMPT } from '../engine/prompt.ts';
import { SKILL_LIMITS } from './contracts.ts';
import type { BankSnapshot, LearningInput, LearningOperation, Skill, SkillContent, SkillSource } from './contracts.ts';
const empty = (): BankSnapshot => ({ version: 1, parent: null, skills: {}, sources: {}, applied: {} });
export const digest = (value: unknown) => sha256(JSON.stringify(value));
const hash = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) throw Error('Invalid knowledge object hash'); return value; };
export function skillId(value: string): string { if (!/^sk_[a-z0-9_-]{1,64}$/.test(value)) throw Error('Invalid skill ID'); return value; }
export function contentOf(s: Skill): SkillContent { return { ...(s.scopeType?{scopeType:s.scopeType}:{}), ...(s.symbols?{symbols:s.symbols}:{}), type:s.type, title:s.title, conditions:s.conditions, steps:s.steps, counterexamples:s.counterexamples, stopConditions:s.stopConditions, paths:s.paths, languages:s.languages, keywords:s.keywords, dependencies:s.dependencies }; }
function content(value: unknown): SkillContent {
  if (!value || typeof value !== 'object') throw Error('Missing skill content');
  const c = value as SkillContent;
  const keys = ['scopeType','symbols','type','title','conditions','steps','counterexamples','stopConditions','paths','languages','keywords','dependencies'];
  if (Object.keys(c).some(k => !keys.includes(k)) || !['review_procedure','repo_contract','tool_usage'].includes(c.type)) throw Error('Invalid content fields');
  if (c.scopeType !== undefined && !['repository_fact','review_method'].includes(c.scopeType)) throw Error('Invalid scope type');
  if (c.type === 'repo_contract' && c.scopeType === 'review_method') throw Error('Repository contracts require repository_fact scope');
  if (c.symbols !== undefined && (!Array.isArray(c.symbols) || c.symbols.length > 8 || c.symbols.some(s=>typeof s !== 'string'||!s.trim()||s.length>600))) throw Error('Invalid symbols');
  if (typeof c.title !== 'string' || c.title.length < 5 || c.title.length > 140) throw Error('Invalid title');
  for (const k of ['conditions','steps','counterexamples','stopConditions','paths','languages','keywords'] as const) {
    if (!Array.isArray(c[k]) || c[k].length > 8 || c[k].some(v => typeof v !== 'string' || !v.trim() || v.length > 600)) throw Error(`Invalid ${k}`);
  }
  if (!c.conditions.length || c.steps.length < 2 || !c.counterexamples.length || !c.stopConditions.length || !c.paths.length) throw Error('Conditional procedure, scope, counterexample and stop conditions required');
  c.paths.forEach(safePath);
  if (!Array.isArray(c.dependencies) || c.dependencies.length > 4) throw Error('Invalid dependencies');
  for (const d of c.dependencies) { safePath(d.path); hash(d.hash); }
  if (c.type === 'repo_contract' && !c.dependencies.length) throw Error('Repository contracts require frozen file dependencies');
  if (Buffer.byteLength(JSON.stringify(c)) > 4500) throw Error('Skill content exceeds byte limit');
  // Exact overlap is deterministic; broader semantic deduplication remains a model responsibility.
  if (c.steps.every(step => BASE_SYSTEM_PROMPT.toLowerCase().includes(step.toLowerCase()))) throw Error('Procedure already covered by fixed rules');
  return structuredClone(c);
}
export class SkillBank {
  root: string;
  constructor(state: string) { this.root = join(state, 'skills'); }
  async object<T>(id: string): Promise<T> { const value = JSON.parse(await readFile(join(this.root, 'objects', hash(id)+'.json'), 'utf8')); if (digest(value) !== id) throw Error('Knowledge integrity mismatch'); return value as T; }
  async put(value: unknown): Promise<string> {
    const id = digest(value); const path = join(this.root, 'objects', id+'.json');
    await mkdir(join(this.root, 'objects'), {recursive:true, mode:0o700});
    try { const f = await open(path, 'wx', 0o600); try { await f.writeFile(JSON.stringify(value)); await f.sync(); } finally { await f.close(); } }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; await this.object(id); }
    return id;
  }
  async current(): Promise<{ id: string; snapshot: BankSnapshot }> {
    let id: string;
    try { id = JSON.parse(await readFile(join(this.root, 'current.json'), 'utf8')).id; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return {id:digest(empty()),snapshot:empty()}; }
    const snapshot = await this.object<BankSnapshot>(id);
    if (snapshot.version !== 1 || !snapshot.skills || !snapshot.sources || !snapshot.applied) throw Error('Invalid bank snapshot');
    return { id, snapshot };
  }
  async locked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.root, {recursive:true,mode:0o700});
    const path = join(this.root, 'write.lock'); const f = await open(path, 'wx', 0o600).catch(() => { throw Error('Knowledge bank locked; inspect owner before recovery'); });
    try { await f.writeFile(JSON.stringify({pid:process.pid})); await f.sync(); return await work(); } finally { await f.close(); await rm(path); }
  }
  async recoverLock(name:'write'|'learning'='write'): Promise<void> {
    const path = join(this.root,name+'.lock'); let owner;
    try {owner = JSON.parse(await readFile(path,'utf8'));} catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw Error('Invalid knowledge lock owner');
    try { process.kill(owner.pid,0); throw Error('Knowledge lock owner alive'); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    await rm(path);
  }
  async revision(id:string, revision:number):Promise<Skill> {
    skillId(id); if(!Number.isSafeInteger(revision)||revision<1)throw Error('Invalid revision');
    let cursor:BankSnapshot|undefined=(await this.current()).snapshot;
    while(cursor) {const ref:string|undefined=cursor.skills[id];if(ref){const s=await this.object<Skill>(ref);if(s.revision===revision)return s;}cursor=cursor.parent?await this.object<BankSnapshot>(cursor.parent).catch(()=>undefined):undefined;}
    throw Error('Skill revision not found');
  }
  async publish(previous: string, next: BankSnapshot): Promise<string> {
    if ((await this.current()).id !== previous) throw Error('Knowledge version conflict');
    next.parent = previous; const id = await this.put(next); await writeJson(join(this.root,'current.json'), {id}); return id;
  }
  async skills(snapshot?: BankSnapshot): Promise<Skill[]> { return Promise.all(Object.values((snapshot ?? (await this.current()).snapshot).skills).map(id => this.object<Skill>(id))); }
  async source(id: string): Promise<SkillSource> { return this.object<SkillSource>(id); }
  async saveSource(source: SkillSource): Promise<string> {
    return this.locked(async () => {
      const {id,snapshot} = await this.current(); const prior = snapshot.sources[source.eventId];
      if (prior) {
        const old = await this.source(prior);
        if (digest(old) === digest(source)) return prior;
        if (source.version !== old.version+1 || source.repositoryKey !== old.repositoryKey || source.runId !== old.runId || source.identity !== old.identity || source.simulated !== old.simulated) throw Error('Source revision conflict');
      } else if (source.version !== 1) throw Error('First source version must be 1');
      const ref = await this.put(source); snapshot.sources[source.eventId] = ref;
      // Old support is withdrawn immediately, before another extraction can succeed.
      if (prior) for (const s of await this.skills(snapshot)) if (s.sources.includes(prior)) {
        const revised = {...s, revision:s.revision+1, sources:s.sources.filter(x => x!==prior), state:'quarantined' as const, createdAt:new Date().toISOString()};
        snapshot.skills[s.id] = await this.put(revised);
      }
      await this.publish(id,snapshot); return ref;
    });
  }
  async apply(jobId: string, input: LearningInput, output: unknown): Promise<{snapshotId:string; outcome:'applied'|'noop'; operations:string[]}> {
    return this.locked(async () => {
      const {id,snapshot} = await this.current();
      const prior = snapshot.applied[jobId]; if (prior) return {snapshotId:id,...prior};
      const sourceRef = digest(input.source);
      if (snapshot.sources[input.source.eventId] !== sourceRef || input.source.withdrawn) throw Error('Source superseded or withdrawn');
      if (id !== input.bankSnapshotId) throw Error('Knowledge version conflict; retry with fresh input');
      if (!output || typeof output !== 'object' || Object.keys(output).join() !== 'operations') throw Error('Invalid structured learning output');
      const ops = (output as {operations:LearningOperation[]}).operations;
      if (!Array.isArray(ops) || !ops.length || ops.length > SKILL_LIMITS.operations) throw Error('Expected 1..3 learning operations');
      const touched = new Set<string>(); const names: string[] = [];
      for (const op of ops) {
        if (!op || typeof op.reason !== 'string' || !op.reason.trim() || op.reason.length > 1000) throw Error('Operation requires bounded reason');
        if (op.op === 'noop') { if (ops.length!==1 || Object.keys(op).some(k=>!['op','reason'].includes(k))) throw Error('Invalid noop'); names.push('noop'); continue; }
        if (!['add','revise','attach_source','retire'].includes(op.op) || Object.keys(op).some(k=>!['op','id','expectedRevision','sourceIds','reason','content','conflict'].includes(k))) throw Error('Invalid operation');
        skillId(op.id); if (touched.has(op.id)) throw Error('Duplicate operation target'); touched.add(op.id);
        if (!Array.isArray(op.sourceIds) || op.sourceIds.length!==1 || op.sourceIds[0]!==input.source.id) throw Error('Unknown source identity');
        const old = snapshot.skills[op.id] ? await this.object<Skill>(snapshot.skills[op.id]!) : undefined;
        if ((old?.revision ?? 0) !== op.expectedRevision || (op.op==='add') === !!old) throw Error('Skill revision conflict');
        if (old && (old.owner!=='learner' || old.repositoryKey!==input.source.repositoryKey || !input.relevantSkills.some(s=>s.id===old.id))) throw Error('Target is not managed relevant knowledge');
        const trusted = input.source.kind==='feedback' && input.source.trust==='trusted' && input.source.verdict!=='uncertain' && !!(input.source.range || input.source.findingId);
        if (op.op==='retire' && !trusted) throw Error('Retirement requires contextual trusted correction');
        if ((op.op==='add'||op.op==='revise') !== !!op.content) throw Error('Unexpected content replacement');
        const c = op.content ? content(op.content) : contentOf(old!);
        for (const dep of c.dependencies) {
          const pages = input.sourcePages as Array<{path:string; fileHash?:string}>;
          if (!pages.some(p=>p.path===dep.path && p.fileHash===dep.hash)) throw Error('Dependency is absent from frozen learning source');
        }
        const contentSha256 = digest(c);
        const duplicate = (await this.skills(snapshot)).find(s=>s.id!==op.id && s.repositoryKey===input.source.repositoryKey && s.contentSha256===contentSha256);
        if (duplicate) throw Error(`Duplicate content: attach source to ${duplicate.id}`);
        if (old?.state==='active' && !trusted && op.op==='revise') throw Error('Weak experience cannot overwrite active correction');
        const sources = [...new Set([...(old?.sources??[]),sourceRef])].sort();
        if (op.op==='attach_source' && old!.sources.includes(sourceRef)) { names.push('noop'); continue; }
        const state = op.op==='retire' ? 'retired' : op.conflict ? 'quarantined' : trusted ? 'active' : old?.state ?? 'trial';
        const s: Skill = {...c,id:op.id,revision:(old?.revision??0)+1,contentSha256,owner:'learner',repositoryKey:input.source.repositoryKey,state,sources,createdAt:new Date().toISOString()};
        snapshot.skills[s.id] = await this.put(s); names.push(op.op);
      }
      const outcome = names.every(n=>n==='noop') ? 'noop' : 'applied';
      snapshot.applied[jobId] = {outcome,operations:names}; const snapshotId = await this.publish(id,snapshot); return {snapshotId,outcome,operations:names};
    });
  }
  async manage(id: string, revision?: number): Promise<Skill> {
    skillId(id); return this.locked(async () => {
      const current = await this.current(); const s = await this.object<Skill>(current.snapshot.skills[id] ?? ''); let chosen = s;
      if (revision!==undefined) {
        if (!Number.isSafeInteger(revision)||revision<1) throw Error('Invalid revision');
        let cursor: BankSnapshot | undefined = current.snapshot;
        while(cursor) { const ref: string | undefined = cursor.skills[id]; if(ref) { const candidate = await this.object<Skill>(ref); if(candidate.revision===revision) {chosen=candidate;break;} } cursor=cursor.parent ? await this.object<BankSnapshot>(cursor.parent).catch(()=>undefined) : undefined; }
        if(chosen.revision!==revision) throw Error('Skill revision not found');
      }
      const sources: string[]=[]; for(const ref of chosen.sources) {const source=await this.source(ref); if(current.snapshot.sources[source.eventId]===ref && !source.withdrawn) sources.push(ref);}
      const next: Skill={...chosen,revision:s.revision+1,sources,state:revision===undefined?'retired':sources.length?'trial':'quarantined',createdAt:new Date().toISOString()};
      current.snapshot.skills[id]=await this.put(next); await this.publish(current.id,current.snapshot); return next;
    });
  }
}
