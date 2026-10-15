import { randomUUID } from 'node:crypto';
import { opendir } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { join } from 'node:path';
import type { HistoryScanner, HistorySourceKind, ScanBatch, ScannedSource } from '../../ports/workbench.ts';

/** Directory handles advance between batches without loading the whole state tree. */
export class NativeHistoryScanner implements HistoryScanner {
  private stateDir: string;
  private directories = new Map<HistorySourceKind, { handle: Dir; epoch: string; startedAt: string }>();
  private pending: HistorySourceKind[] = ['run', 'task'];
  private finished = false;

  constructor(stateDir: string) { this.stateDir = stateDir; }

  async scan(limit: number): Promise<ScanBatch> {
    if (this.finished) { this.pending = ['run', 'task']; this.finished = false; }
    const sources: ScannedSource[] = [];
    const completed: ScanBatch['completed'] = [];
    const started = performance.now();
    while (this.pending.length && sources.length < limit && performance.now() - started < 100) {
      const kind = this.pending[0]!;
      let directory = this.directories.get(kind);
      if (!directory) {
        const epoch = randomUUID();
        const startedAt = new Date().toISOString();
        try {
          const path = kind === 'run' ? join(this.stateDir, 'runs') : join(this.stateDir, 'mcp', 'tasks');
          directory = { handle: await opendir(path, { bufferSize: Math.min(limit, 32) }), epoch, startedAt };
          this.directories.set(kind, directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          completed.push({ kind, epoch, startedAt }); this.pending.shift(); continue;
        }
      }
      const entry = await directory.handle.read();
      if (!entry) {
        await directory.handle.close(); this.directories.delete(kind);
        completed.push({ kind, epoch: directory.epoch, startedAt: directory.startedAt }); this.pending.shift();
      } else sources.push({ kind, id: entry.name, directory: entry.isDirectory(), epoch: directory.epoch });
    }
    this.finished = this.pending.length === 0;
    return { sources, completed, truncated: !this.finished };
  }

  async close(): Promise<void> {
    const handles = [...this.directories.values()]; this.directories.clear();
    for (const directory of handles) await directory.handle.close();
  }
}
