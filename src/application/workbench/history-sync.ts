import type { HistoryItem, HistoryResponse, ProjectDto } from '../../../packages/contracts/src/types.ts';
import { isUuid } from '../../domain/validation.ts';
import { WorkbenchError } from '../../ports/workbench.ts';
import type { HistoryProjectionPort, HistoryScanner, ProjectionUpdate } from '../../ports/workbench.ts';
import { unverifiable, VerifiedArtifacts } from './verified-artifacts.ts';

const SKIPPED_ERRORS = ['REPORT_INTEGRITY', 'REPOSITORY_MISMATCH', 'NOT_FOUND'];

/** Advances one bounded scan per project and projects each native source after fresh verification. */
export class HistorySync {
  private scanners = new Map<string, HistoryScanner>();
  private projection: HistoryProjectionPort;
  private stateDir: string;
  private createScanner: () => HistoryScanner;
  private batchSize: number;

  constructor(options: { projection: HistoryProjectionPort; stateDir: string; createScanner: () => HistoryScanner; batchSize: number }) {
    this.projection = options.projection; this.stateDir = options.stateDir;
    this.createScanner = options.createScanner; this.batchSize = options.batchSize;
  }

  async sync(project: ProjectDto): Promise<HistoryResponse['sync']> {
    let scanner = this.scanners.get(project.id);
    if (!scanner) { scanner = this.createScanner(); this.scanners.set(project.id, scanner); }
    const artifacts = new VerifiedArtifacts(project, this.stateDir);
    try {
      const batch = await scanner.scan(this.batchSize);
      const updates: ProjectionUpdate[] = [];
      let skipped = 0;
      for (const entry of batch.sources) {
        const update: ProjectionUpdate = { kind: entry.kind, sourceId: entry.id, epoch: entry.epoch };
        updates.push(update);
        if (!entry.directory || !isUuid(entry.id)) { skipped++; continue; }
        let item: HistoryItem | undefined;
        try { item = entry.kind === 'run' ? await artifacts.runItem(entry.id) : await artifacts.taskItem(entry.id); }
        catch (error) {
          if (!(error instanceof WorkbenchError) || !SKIPPED_ERRORS.includes(error.code)) throw error;
          if (error.code === 'REPORT_INTEGRITY') {
            const known = this.projection.sourceItem(project, entry.kind, entry.id);
            if (known) update.item = unverifiable(known);
            skipped++;
          }
          continue;
        }
        if (item) update.item = item;
        if (item?.reportAvailability === 'unavailable') skipped++;
      }
      this.projection.apply(project, updates, batch.completed, new Date().toISOString());
      return { lastSyncedAt: this.projection.lastSyncedAt(project), scanned: batch.sources.length, skipped, truncated: batch.truncated };
    } catch {
      await this.forget(project.id);
      throw new WorkbenchError('STORAGE_UNAVAILABLE', 'The native history projection could not be synchronized.', 503);
    }
  }

  /** Restart the scan for a project, e.g. after its directory membership changed. */
  async forget(projectId: string): Promise<void> {
    const scanner = this.scanners.get(projectId);
    this.scanners.delete(projectId);
    await scanner?.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    const scanners = [...this.scanners.values()];
    this.scanners.clear();
    for (const scanner of scanners) await scanner.close();
  }
}
