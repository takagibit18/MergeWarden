import { createHash } from 'node:crypto';
export const snapshot = { id: 'snapshot-1', repositoryId: 'fixture', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), inputFingerprint: 'input-v1', configurationFingerprint: 'config-v1' };
export const snippet = 'return cache[key]';
export const candidate = (id = 'C1') => ({ id, title: 'Synthetic candidate', claim: 'Fixture-only claim', trigger: 'Fixture trigger', impact: 'Fixture impact', severity: 'medium', evidence: [{snapshotId: snapshot.id, revision:'head', path: 'src/cache.py', startLine: 1, endLine: 1, contentSha256: createHash('sha256').update(snippet).digest('hex')}] });
export const request = () => ({ id: 'D1', runId: 'run-1', snapshotId: snapshot.id, stateVersion: 3, point: 'tool_shortlist', catalogVersion: 'tools-v1', allowedOptions: ['TRACE_CALLERS','SEARCH_LITERAL'], facts: { evidenceNeed: 'callers' } });
