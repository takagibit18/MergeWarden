import { WorkbenchService } from '../application/workbench/index.ts';
import { openWorkbenchStorage } from '../infrastructure/workbench-storage.ts';

export interface OpenWorkbenchOptions {
  repositoryPath: string;
  stateDir: string;
  syncBatchSize?: number;
}

/** Composition root: wire SQLite and native file storage into the workbench application service. */
export async function openWorkbench(options: OpenWorkbenchOptions): Promise<WorkbenchService> {
  const storage = await openWorkbenchStorage(options);
  return WorkbenchService.open(storage, options.syncBatchSize === undefined ? {} : { syncBatchSize: options.syncBatchSize });
}
