import { createHash } from 'node:crypto';
import { EvidenceRegistry, evidenceIdentity, evidenceRefId } from '../../application/evidence-registry.ts';
import type { FindingInput } from '../../application/evidence-registry.ts';
import type { FindingCandidate } from '../../domain/contracts.ts';
import { INVESTIGATION_MESSAGE, INVESTIGATION_EVENT, INVESTIGATION_VERSION } from '../../engine/investigation-contracts.ts';
import type { CandidateCard, CandidateSource, ContextPackageV2 } from '../../engine/investigation-contracts.ts';
import { stableId } from '../../engine/investigation-focus.ts';
import { isObject } from '../../engine/tool-result.ts';
import { decodePiTrace } from './decode.ts';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const canonical = (f: FindingCandidate) => JSON.stringify([f.id, f.title, f.claim, f.trigger, f.impact, f.severity, f.evidence.map(evidenceIdentity).sort()]);

/** Versioned independently from Attribution v3 and host-dispatch-attribution-1. */
export function analyzeInvestigation(input: { runId: string; snapshotId: string; findings: FindingCandidate[]; jsonl: string }) {
  const trace = decodePiTrace(input.jsonl);
  const result = { version: 'host-dispatch-attribution-2', traceIssues: trace.issues, host_prefetched_structural_assistance: 0,
    model_expanded_structural_assistance: 0, packagesDelivered: 0,
    findings: [] as { findingId: string; hostPrefetchedRefs: string[]; modelExpandedRefs: string[]; requestIds: string[] }[] };
  if (trace.issues.some(i => i.severity === 'fatal')) return result;
  const rows = input.jsonl.trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(isObject), byId = new Map(rows.map(r => [r.id, r]));
  const branch: Record<string, unknown>[] = []; let row = rows.findLast(r => typeof r.id === 'string');
  while (row) { branch.unshift(row); row = byId.get(row.parentId); }
  const packages: { pack: ContextPackageV2; delivered: number; cards: CandidateCard[] }[] = [];
  for (const [event, r] of branch.entries()) {
    if (r.type !== 'custom_message' || r.customType !== INVESTIGATION_MESSAGE || typeof r.content !== 'string') continue;
    try {
      const pack = JSON.parse(r.content) as ContextPackageV2;
      if (pack.version !== INVESTIGATION_VERSION || pack.runId !== input.runId || pack.snapshotId !== input.snapshotId || !pack.generationId) continue;
      const delivered = branch.findIndex((entry, i) => i > event && entry.type === 'custom' && entry.customType === INVESTIGATION_EVENT && isObject(entry.data)
        && entry.data.type === 'context_delivered' && entry.data.runId === input.runId && entry.data.snapshotId === input.snapshotId
        && entry.data.generationId === pack.generationId && entry.data.requestId === pack.requestId && entry.data.packageSha256 === hash(String(r.content)));
      if (delivered < 0) continue;
      const cards = pack.investigations.flatMap(inv => inv.candidateCatalog.filter(c => c.entity.snapshotId === input.snapshotId
        && c.candidateRefId === stableId('cand_', [pack.requestId, c.entity.entityId])
        && c.roots.length > 0 && c.roots.every(root => inv.changeUnits.some(u => u.changeUnitId === root.changeUnitId && u.resolution === 'resolved' && u.entity?.snapshotId === input.snapshotId))));
      packages.push({ pack, delivered, cards }); result.packagesDelivered++;
    } catch { /* Malformed candidate metadata cannot grant assistance. */ }
  }
  const valid = (source: CandidateSource, card: CandidateCard) => source.snapshotId === input.snapshotId && source.revision === 'head'
    && source.path === card.entity.path && source.entity?.entityId === card.entity.entityId && source.startLine >= card.entity.startLine
    && source.endLine <= card.entity.endLine && source.endLine >= source.startLine && source.endLine - source.startLine < 80
    && typeof source.text === 'string' && hash(source.text) === source.contentSha256 && evidenceRefId(source) === source.evidenceRefId;
  for (const finding of input.findings) {
    const host = new Set<string>(), expanded = new Set<string>(), requests = new Set<string>();
    for (const submit of trace.calls.filter(c => c.name === 'submit_review' && !c.isError && c.response?.accepted === true)) {
      const registry = new EvidenceRegistry(input.snapshotId), eligible: { source: CandidateSource; requestId: string; origin: 'host' | 'expanded' }[] = [];
      for (const call of trace.calls) if (call.name === 'read_source' && !call.isError && call.response?.status === 'ok'
        && call.response.snapshotId === input.snapshotId && (call.resultEvent ?? Infinity) < submit.callEvent) registry.register(call.response as unknown as CandidateSource);
      for (const p of packages.filter(p => p.delivered < submit.callEvent)) {
        for (const s of p.pack.sources) { const card = p.cards.find(c => c.candidateRefId === s.candidateRefId);
          if (card && valid(s, card)) eligible.push({ source: s, requestId: p.pack.requestId, origin: 'host' }); }
        for (const call of trace.calls.filter(c => c.name === 'expand_structural_candidate' && !c.isError && c.response?.status === 'ok'
          && c.callEvent > p.delivered && (c.resultEvent ?? Infinity) < submit.callEvent)) {
          const s = call.response as unknown as CandidateSource & { requestId: string; generationId: string }, card = p.cards.find(c => c.candidateRefId === call.args.candidateRefId);
          if (card && s.candidateRefId === card.candidateRefId && s.requestId === p.pack.requestId && s.generationId === p.pack.generationId && valid(s, card))
            eligible.push({ source: s, requestId: p.pack.requestId, origin: 'expanded' });
        }
      }
      for (const e of eligible) registry.register(e.source);
      let normalized: FindingCandidate[]; try { normalized = registry.normalize(submit.args.findings as FindingInput[]); } catch { continue; }
      if (!normalized.some(f => canonical(f) === canonical(finding))) continue;
      for (const e of eligible) if (finding.evidence.some(ref => evidenceIdentity(ref) === evidenceIdentity(e.source))) {
        (e.origin === 'host' ? host : expanded).add(e.source.evidenceRefId); requests.add(e.requestId);
      }
    }
    result.findings.push({ findingId: finding.id, hostPrefetchedRefs: [...host], modelExpandedRefs: [...expanded], requestIds: [...requests] });
    if (host.size) result.host_prefetched_structural_assistance++; if (expanded.size) result.model_expanded_structural_assistance++;
  }
  return result;
}
