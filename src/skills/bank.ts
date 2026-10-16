import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256, writeJson, safePath } from '../infrastructure/files.ts';
import { BASE_SYSTEM_PROMPT } from '../engine/prompt.ts';
import { SKILL_LIMITS } from './contracts.ts';
import type { ApprovalDecision, BankSnapshot, ComparisonEntry, LearningInput, LearningOperation, Proposal, ProposedChange, Skill, SkillContent, SkillSource } from './contracts.ts';
import { nearestSkills, normalizeContent, SIMILARITY_POLICY } from './normalize.ts';
import { checkComparison } from './novelty.ts';
import { parseReferences, SKILL_FORMAT_LIMITS } from './skill-md.ts';
/** Run-derived experience becomes active only after support from this many distinct reviewed changes. */
export const INDEPENDENT_CHANGES_FOR_ACTIVE = 2;
const empty = (): BankSnapshot => ({ version: 1, parent: null, skills: {}, sources: {}, applied: {} });
export const digest = (value: unknown) => sha256(JSON.stringify(value));
const hash = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) throw Error('Invalid knowledge object hash'); return value; };
export function skillId(value: string): string { if (!/^sk_[a-z0-9_-]{1,64}$/.test(value)) throw Error('Invalid skill ID'); return value; }
export function proposalId(value: string): string { if (!/^pr_[a-f0-9]{24}$/.test(value)) throw Error('Invalid proposal ID'); return value; }
export function contentOf(s: Skill): SkillContent { return { ...(s.name?{name:s.name}:{}), ...(s.description?{description:s.description}:{}), ...(s.references?{references:s.references}:{}), ...(s.scopeType?{scopeType:s.scopeType}:{}), ...(s.symbols?{symbols:s.symbols}:{}), type:s.type, title:s.title, conditions:s.conditions, steps:s.steps, counterexamples:s.counterexamples, stopConditions:s.stopConditions, paths:s.paths, languages:s.languages, keywords:s.keywords, dependencies:s.dependencies }; }
/** Layer 2: normalize first, then validate the canonical form that will be hashed and stored. */
function content(value: unknown): SkillContent {
  if (!value || typeof value !== 'object') throw Error('Missing skill content');
  const c = normalizeContent(value as SkillContent);
  const keys = ['name','description','references','scopeType','symbols','type','title','conditions','steps','counterexamples','stopConditions','paths','languages','keywords','dependencies'];
  if (Object.keys(c).some(k => !keys.includes(k)) || !['review_procedure','repo_contract','tool_usage'].includes(c.type)) throw Error('Invalid content fields');
  if (c.scopeType !== undefined && !['repository_fact','review_method'].includes(c.scopeType)) throw Error('Invalid scope type');
  if (c.type === 'repo_contract' && c.scopeType === 'review_method') throw Error('Repository contracts require repository_fact scope');
  // skill-md-1: a name and trigger description travel together; references are bounded Markdown, never scripts.
  if ((c.name === undefined) !== (c.description === undefined)) throw Error('Skill name and description are required together');
  if (c.name !== undefined && (typeof c.name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.name) || c.name.length > 64)) throw Error('Invalid Skill name; use lowercase kebab-case up to 64 characters');
  if (c.description !== undefined && (typeof c.description !== 'string' || c.description.length < 20 || c.description.length > 600)) throw Error('Invalid Skill description; state what it checks and when to use it in 20..600 characters');
  if (c.references !== undefined) parseReferences(c.references);
  // A review method generalizes across a module: scope it by directory, never by the single file it was learned from.
  if (c.name !== undefined && c.scopeType === 'review_method' && Array.isArray(c.paths) && c.paths.some(p => typeof p === 'string' && /\.[A-Za-z0-9]+$/.test(p.split('/').at(-1) ?? ''))) throw Error('Review methods scope by module directory, not single files; use a repository_fact for file-specific knowledge');
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
  if (Buffer.byteLength(JSON.stringify(c)) > (c.references ? 4500 + SKILL_FORMAT_LIMITS.references * SKILL_FORMAT_LIMITS.referenceBytes : 4500)) throw Error('Skill content exceeds byte limit');
  // Exact overlap is deterministic; broader semantic deduplication remains a model responsibility.
  if (c.steps.every(step => BASE_SYSTEM_PROMPT.toLowerCase().includes(step.toLowerCase()))) throw Error('Procedure already covered by fixed rules');
  return structuredClone(c);
}
export interface WriteReceipt { snapshotId: string; outcome: BankSnapshot['applied'][string]['outcome']; operations: string[]; proposalId?: string }
interface Prepared { changes: ProposedChange[]; names: string[]; comparison: ComparisonEntry[]; warnings: string[] }
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
  async proposals(snapshot?: BankSnapshot): Promise<Proposal[]> {
    const refs = Object.values((snapshot ?? (await this.current()).snapshot).proposals ?? {});
    return (await Promise.all(refs.map(ref => this.object<Proposal>(ref)))).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async proposal(id: string): Promise<Proposal> {
    const ref = (await this.current()).snapshot.proposals?.[proposalId(id)];
    if (!ref) throw Error('Unknown proposal');
    return this.object<Proposal>(ref);
  }
  /** Candidate Skills of pending proposals; they occupy their content until approved or rejected. */
  private async pendingCandidates(snapshot: BankSnapshot): Promise<Skill[]> {
    const pending = (await this.proposals(snapshot)).filter(p => p.status === 'pending');
    return Promise.all(pending.flatMap(p => p.changes.filter(c => c.op === 'add' || c.op === 'revise')).map(c => this.object<Skill>(c.candidate)));
  }
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
  /** Validate a learning result against one bank snapshot and build the Skill revisions it would publish. */
  private async prepare(snapshot: BankSnapshot, input: LearningInput, output: unknown): Promise<Prepared> {
    if (!output || typeof output !== 'object' || Object.keys(output).join() !== 'operations') throw Error('Invalid structured learning output');
    const ops = (output as {operations:LearningOperation[]}).operations;
    if (!Array.isArray(ops) || !ops.length || ops.length > SKILL_LIMITS.operations) throw Error('Expected 1..3 learning operations');
    const sourceRef = digest(input.source);
    const bankSkills = await this.skills(snapshot);
    const occupied = [...bankSkills, ...await this.pendingCandidates(snapshot)];
    const shown = (input.existingSkills?.catalog ?? []).map(c => ({ id: c.id, revision: c.revision }));
    const touched = new Set<string>(), staged: Skill[] = [];
    const prepared: Prepared = { changes: [], names: [], comparison: [], warnings: [] };
    for (const op of ops) {
      if (!op || typeof op.reason !== 'string' || !op.reason.trim() || op.reason.length > 1000) throw Error('Operation requires bounded reason');
      if (op.op === 'noop') { if (ops.length!==1 || Object.keys(op).some(k=>!['op','reason'].includes(k))) throw Error('Invalid noop'); prepared.names.push('noop'); continue; }
      if (!['add','revise','attach_source','retire'].includes(op.op) || Object.keys(op).some(k=>!['op','id','expectedRevision','sourceIds','reason','content','conflict','comparison'].includes(k))) throw Error('Invalid operation');
      skillId(op.id); if (touched.has(op.id)) throw Error('Duplicate operation target'); touched.add(op.id);
      if (!Array.isArray(op.sourceIds) || op.sourceIds.length!==1 || op.sourceIds[0]!==input.source.id) throw Error('Unknown source identity');
      const previous = snapshot.skills[op.id];
      const old = previous ? await this.object<Skill>(previous) : undefined;
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
      const duplicate = [...occupied, ...staged].find(s=>s.id!==op.id && s.repositoryKey===input.source.repositoryKey && s.contentSha256===contentSha256);
      if (duplicate) throw Error(`Duplicate content: attach source to ${duplicate.id}`);
      if (old?.state==='active' && !trusted && op.op==='revise') throw Error('Weak experience cannot overwrite active correction');
      // Layer 1: inputs that carried a catalog must say how this experience relates to each shown Skill.
      if (input.existingSkills) prepared.comparison.push(...checkComparison(op, shown).filter(e => !prepared.comparison.some(x => x.id === e.id)));
      // Layer 2: restated experience is refused against the whole bank, not only what the learner saw.
      if (op.content) {
        const near = nearestSkills(c, [...occupied, ...staged], { repositoryKey: input.source.repositoryKey, exclude: op.id });
        const blocking = near.find(m => m.score >= SIMILARITY_POLICY.block);
        if (blocking) throw Error(`Near-duplicate of ${blocking.id} (similarity ${blocking.score}): attach source to it or revise it`);
        for (const m of near) prepared.warnings.push(`${op.id} resembles ${m.id} (similarity ${m.score})`);
      }
      const sources = [...new Set([...(old?.sources??[]),sourceRef])].sort();
      if (op.op==='attach_source' && old!.sources.includes(sourceRef)) { prepared.names.push('noop'); continue; }
      // Independence is per reviewed change: a run and the feedback on that same run are one event, not two supports.
      const changes = new Set(await Promise.all((old?.sources ?? []).map(async r => (await this.source(r)).snapshotId)));
      if (op.op==='attach_source' && changes.has(input.source.snapshotId)) { prepared.names.push('noop'); continue; }
      changes.add(input.source.snapshotId);
      const corroborated = op.op==='attach_source' && changes.size >= INDEPENDENT_CHANGES_FOR_ACTIVE;
      const state = op.op==='retire' ? 'retired' : op.conflict ? 'quarantined' : trusted || corroborated ? 'active' : old?.state ?? 'trial';
      const s: Skill = {...c,id:op.id,revision:(old?.revision??0)+1,contentSha256,owner:'learner',repositoryKey:input.source.repositoryKey,state,sources,createdAt:new Date().toISOString()};
      staged.push(s);
      prepared.changes.push({ op: op.op, id: op.id, expectedRevision: op.expectedRevision, reason: op.reason.trim(), candidate: await this.put(s), ...(previous ? { previous } : {}) });
      prepared.names.push(op.op);
    }
    return prepared;
  }
  /** Validate and stage a learning result. Nothing becomes visible knowledge until approval. */
  async propose(jobId: string, input: LearningInput, output: unknown): Promise<WriteReceipt> {
    return this.locked(async () => {
      const {id,snapshot} = await this.current();
      const prior = snapshot.applied[jobId]; if (prior) return {snapshotId:id,...prior};
      const sourceRef = digest(input.source);
      if (snapshot.sources[input.source.eventId] !== sourceRef || input.source.withdrawn) throw Error('Source superseded or withdrawn');
      if (id !== input.bankSnapshotId) throw Error('Knowledge version conflict; retry with fresh input');
      const prepared = await this.prepare(snapshot, input, output);
      if (!prepared.changes.length) {
        snapshot.applied[jobId] = {outcome:'noop',operations:prepared.names};
        return {snapshotId:await this.publish(id,snapshot),outcome:'noop',operations:prepared.names};
      }
      const proposal: Proposal = { schemaVersion: 1, id: 'pr_' + digest([jobId, id]).slice(0, 24), origin: 'learning', status: 'pending', jobId, sourceRef,
        baseSnapshotId: id, repositoryKey: input.source.repositoryKey, changes: prepared.changes, comparison: prepared.comparison,
        warnings: prepared.warnings, createdAt: new Date().toISOString() };
      snapshot.proposals = { ...snapshot.proposals, [proposal.id]: await this.put(proposal) };
      snapshot.applied[jobId] = {outcome:'proposed',operations:prepared.names,proposalId:proposal.id};
      return {snapshotId:await this.publish(id,snapshot),...snapshot.applied[jobId]};
    });
  }
  /** Stage host-generated changes, such as curation retirements, for the same approval queue. */
  async stage(proposal: Omit<Proposal, 'schemaVersion'|'id'|'status'|'baseSnapshotId'|'createdAt'>): Promise<Proposal> {
    return this.locked(async () => {
      const {id,snapshot} = await this.current();
      const staged: Proposal = { schemaVersion: 1, id: 'pr_' + digest([proposal, id]).slice(0, 24), status: 'pending', baseSnapshotId: id, createdAt: new Date().toISOString(), ...proposal };
      snapshot.proposals = { ...snapshot.proposals, [staged.id]: await this.put(staged) };
      await this.publish(id, snapshot);
      return staged;
    });
  }
  private async decide(snapshot: BankSnapshot, proposal: Proposal, status: Proposal['status'], decision?: ApprovalDecision): Promise<void> {
    const next: Proposal = { ...proposal, status, ...(decision ? { decision } : {}) };
    snapshot.proposals = { ...snapshot.proposals, [proposal.id]: await this.put(next) };
    if (proposal.jobId && snapshot.applied[proposal.jobId]) {
      // A stale learning job is released so the next learning pass re-extracts it against the current bank.
      if (status === 'stale') delete snapshot.applied[proposal.jobId];
      else snapshot.applied[proposal.jobId] = { ...snapshot.applied[proposal.jobId]!, outcome: status === 'approved' ? 'applied' : 'rejected' };
    }
  }
  /** Publish a pending proposal after re-checking it against the bank as it is now. */
  async approve(id: string, decision: ApprovalDecision): Promise<WriteReceipt> {
    return this.locked(async () => {
      const current = await this.current(), snapshot = current.snapshot;
      const ref = snapshot.proposals?.[proposalId(id)]; if (!ref) throw Error('Unknown proposal');
      const proposal = await this.object<Proposal>(ref);
      if (proposal.status !== 'pending') throw Error(`Proposal is already ${proposal.status}`);
      const stale = async (reason: string): Promise<never> => { await this.decide(snapshot, proposal, 'stale'); await this.publish(current.id, snapshot); throw Error(`${reason}; proposal is stale`); };
      if (proposal.sourceRef) {
        const source = await this.source(proposal.sourceRef);
        if (snapshot.sources[source.eventId] !== proposal.sourceRef || source.withdrawn) await stale('Source superseded or withdrawn');
      }
      const others = (await this.skills(snapshot)).filter(s => !proposal.changes.some(c => c.id === s.id));
      for (const change of proposal.changes) {
        const live = snapshot.skills[change.id];
        if ((live ? (await this.object<Skill>(live)).revision : 0) !== change.expectedRevision) await stale(`Knowledge changed since proposal for ${change.id}`);
        if (change.op !== 'add' && change.op !== 'revise') continue;
        const candidate = await this.object<Skill>(change.candidate);
        const duplicate = others.find(s => s.repositoryKey === candidate.repositoryKey && s.contentSha256 === candidate.contentSha256);
        if (duplicate) await stale(`Duplicate content of ${duplicate.id} was approved meanwhile`);
        const blocking = nearestSkills(candidate, others, { repositoryKey: candidate.repositoryKey }).find(m => m.score >= SIMILARITY_POLICY.block);
        if (blocking) await stale(`Near-duplicate ${blocking.id} was approved meanwhile`);
      }
      for (const change of proposal.changes) snapshot.skills[change.id] = change.candidate;
      await this.decide(snapshot, proposal, 'approved', decision);
      const snapshotId = await this.publish(current.id, snapshot);
      return { snapshotId, outcome: 'applied', operations: proposal.changes.map(c => c.op), proposalId: proposal.id };
    });
  }
  async reject(id: string, decision: ApprovalDecision): Promise<Proposal> {
    return this.locked(async () => {
      const current = await this.current(), snapshot = current.snapshot;
      const ref = snapshot.proposals?.[proposalId(id)]; if (!ref) throw Error('Unknown proposal');
      const proposal = await this.object<Proposal>(ref);
      if (proposal.status !== 'pending') throw Error(`Proposal is already ${proposal.status}`);
      await this.decide(snapshot, proposal, 'rejected', decision);
      await this.publish(current.id, snapshot);
      return { ...proposal, status: 'rejected', decision };
    });
  }
  /** Internal/evaluation path: stage and approve at once. Product entry points use propose plus human approval. */
  async apply(jobId: string, input: LearningInput, output: unknown): Promise<WriteReceipt> {
    const staged = await this.propose(jobId, input, output);
    if (staged.outcome !== 'proposed' || !staged.proposalId) return staged;
    const pending = await this.proposal(staged.proposalId);
    if (pending.status !== 'pending') return staged;
    return this.approve(staged.proposalId, { by: 'host_auto', at: new Date().toISOString() });
  }
  async pin(id: string, note?: string): Promise<void> {
    skillId(id); await this.locked(async () => {
      const current = await this.current();
      if (!current.snapshot.skills[id]) throw Error('Skill not found');
      current.snapshot.pins = { ...current.snapshot.pins, [id]: { at: new Date().toISOString(), ...(note ? { note } : {}) } };
      await this.publish(current.id, current.snapshot);
    });
  }
  async unpin(id: string): Promise<void> {
    skillId(id); await this.locked(async () => {
      const current = await this.current();
      if (!current.snapshot.pins?.[id]) return;
      const { [id]: _removed, ...rest } = current.snapshot.pins;
      current.snapshot.pins = rest;
      await this.publish(current.id, current.snapshot);
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
