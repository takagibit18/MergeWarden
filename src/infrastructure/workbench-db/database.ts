import { DatabaseSync } from 'node:sqlite';
import { migrateWorkbenchDatabase } from './migrations.ts';

/** One migrated connection shared by the project registry and the history projection. */
export class WorkbenchDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    this.connection = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
    try { migrateWorkbenchDatabase(this.connection); }
    catch (error) { this.connection.close(); throw error; }
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.connection.exec('COMMIT'); return result; }
    catch (error) {
      try { this.connection.exec('ROLLBACK'); } catch { /* Preserve the storage failure. */ }
      throw error;
    }
  }

  close(): void { this.connection.close(); }
}
