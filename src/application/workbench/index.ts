/** Public surface of the workbench application layer for transport adapters and tests. */
export { WorkbenchService } from './service.ts';
export { buildEvidenceDiff, unsupportedEvidenceDiff } from './evidence-diff.ts';
export type { EvidenceDiffInput, EvidenceDiffLimits, FrozenFileFacts } from './evidence-diff.ts';
export { WorkbenchError } from '../../ports/workbench.ts';
export type { WorkbenchStorage } from '../../ports/workbench.ts';
