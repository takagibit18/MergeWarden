import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkbenchError } from '../ports/workbench.ts';
import type { WorkbenchStorage } from '../ports/workbench.ts';
import { isolatedState } from './files.ts';
import { WorkbenchDatabase } from './workbench-db/database.ts';
import { HistoryProjection } from './workbench-db/history-projection.ts';
import { ProjectRegistry } from './workbench-db/project-registry.ts';
import { repositoryDirectory } from './workbench-fs/git-registration.ts';
import { NativeHistoryScanner } from './workbench-fs/scanner.ts';

/** Open the host-side storage for one launch repository. The state directory must stay outside every checkout. */
export async function openWorkbenchStorage(options: { repositoryPath: string; stateDir: string }): Promise<WorkbenchStorage> {
  let database: WorkbenchDatabase | undefined;
  try {
    const launchRepository = await repositoryDirectory(options.repositoryPath);
    const stateDir = await isolatedState(options.stateDir, launchRepository.repositoryPath);
    const path = join(stateDir, 'workbench.sqlite');
    try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid projection file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const opened = database = new WorkbenchDatabase(path);
    return {
      stateDir, launchRepository,
      registry: new ProjectRegistry(opened), projection: new HistoryProjection(opened),
      createScanner: () => new NativeHistoryScanner(stateDir),
      resolveRepository: repositoryDirectory,
      close: () => opened.close(),
    };
  } catch (error) {
    database?.close();
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError('STORAGE_UNAVAILABLE', 'Workbench storage could not be opened for this repository.', 503);
  }
}
