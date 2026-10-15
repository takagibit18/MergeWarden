import { randomUUID } from 'node:crypto';
import type { ProjectDto, WorkspaceDto } from '../../../packages/contracts/src/types.ts';
import { isCanonicalTimestamp, isUuid } from '../../domain/validation.ts';
import { sha256 } from '../files.ts';
import { WorkbenchError } from '../../ports/workbench.ts';
import type { ProjectRegistration, ProjectRegistryPort } from '../../ports/workbench.ts';
import type { WorkbenchDatabase } from './database.ts';

interface ProjectRow { project_id: string; name: string; repository_path: string; common_git_directory: string; created_at: string }
interface WorkspaceRow { workspace_id: string; name: string; repository_path: string; kind: WorkspaceDto['kind']; registered_at: string }
const MAX_PROJECTS = 50, MAX_WORKSPACES = 50;
const isName = (name: unknown): name is string => typeof name === 'string' && name === name.trim() && name.length > 0 && name.length <= 80 && !/[\x00-\x1f\x7f]/.test(name);

/** Durable project and directory membership. Registration never scans or executes repository files. */
export class ProjectRegistry implements ProjectRegistryPort {
  private database: WorkbenchDatabase;

  constructor(database: WorkbenchDatabase) { this.database = database; }

  private get sql() { return this.database.connection; }

  private projectRow(projectId: string): ProjectRow {
    if (!isUuid(projectId)) throw new WorkbenchError('INVALID_QUERY', 'A valid project UUID is required.', 400);
    const row = this.sql.prepare(`SELECT p.project_id,p.name,r.repository_path,p.common_git_directory,p.created_at
      FROM projects p JOIN repositories r ON r.repository_id=p.primary_repository_id WHERE p.project_id=?`).get(projectId) as ProjectRow | undefined;
    if (!row) throw new WorkbenchError('NOT_FOUND', 'Project was not found in the workbench registry.', 404);
    if (!isName(row.name) || !isCanonicalTimestamp(row.created_at) || !row.repository_path || !row.common_git_directory) throw new Error('Invalid project registry record');
    return row;
  }

  project(projectId: string): ProjectDto {
    const row = this.projectRow(projectId);
    const records = this.sql.prepare(`SELECT w.workspace_id,w.name,r.repository_path,w.kind,w.registered_at
      FROM project_workspaces w JOIN repositories r ON r.repository_id=w.workspace_id WHERE w.project_id=?
      ORDER BY w.kind='primary' DESC,w.registered_at,w.workspace_id`).all(projectId) as unknown as WorkspaceRow[];
    if (!records.length || records.length > MAX_WORKSPACES) throw new Error('Invalid project workspace membership');
    const workspaces = records.map(record => {
      if (sha256(record.repository_path) !== record.workspace_id || !isName(record.name) || !isCanonicalTimestamp(record.registered_at) ||
        !['primary', 'worktree'].includes(record.kind)) throw new Error('Invalid workspace registry record');
      return { id: record.workspace_id, name: record.name, path: record.repository_path, kind: record.kind, registeredAt: record.registered_at };
    });
    if (workspaces.filter(workspace => workspace.kind === 'primary').length !== 1 ||
      workspaces.find(workspace => workspace.kind === 'primary')?.path !== row.repository_path) throw new Error('Invalid primary workspace');
    return { id: row.project_id, name: row.name, repositoryPath: row.repository_path, createdAt: row.created_at, workspaces };
  }

  projects(): ProjectDto[] {
    const rows = this.sql.prepare('SELECT project_id FROM projects ORDER BY created_at,project_id').all() as unknown as { project_id: string }[];
    if (rows.length > MAX_PROJECTS) throw new Error('Invalid project registry size');
    return rows.map(row => this.project(row.project_id));
  }

  private registerRepository(path: string): string {
    const repositoryId = sha256(path);
    this.sql.prepare('INSERT INTO repositories(repository_id,repository_path) VALUES(?,?) ON CONFLICT(repository_id) DO NOTHING').run(repositoryId, path);
    const row = this.sql.prepare('SELECT repository_path FROM repositories WHERE repository_id=?').get(repositoryId) as { repository_path: string };
    if (row.repository_path !== path) throw new Error('Repository projection identity mismatch');
    return repositoryId;
  }

  private membership(repositoryId: string): string | undefined {
    return (this.sql.prepare('SELECT project_id FROM project_workspaces WHERE workspace_id=?').get(repositoryId) as { project_id: string } | undefined)?.project_id;
  }

  private addWorktree(projectId: string, repositoryId: string, input: ProjectRegistration): ProjectDto {
    const count = this.sql.prepare('SELECT count(*) AS n FROM project_workspaces WHERE project_id=?').get(projectId) as { n: number };
    if (count.n >= MAX_WORKSPACES) throw new WorkbenchError('REGISTRY_LIMIT', `A project supports at most ${MAX_WORKSPACES} registered directories.`, 409);
    this.sql.prepare(`INSERT INTO project_workspaces(workspace_id,project_id,name,kind,registered_at) VALUES(?,?,?,'worktree',?)`)
      .run(repositoryId, projectId, input.name, input.registeredAt);
    return this.project(projectId);
  }

  /** A directory whose Git common directory already belongs to a project joins it as a worktree. */
  registerProject(input: ProjectRegistration): ProjectDto {
    return this.database.transaction(() => {
      const repositoryId = this.registerRepository(input.repositoryPath);
      const existing = this.membership(repositoryId);
      if (existing) {
        if (this.projectRow(existing).common_git_directory !== input.commonGitDirectory) {
          throw new WorkbenchError('REPOSITORY_MISMATCH', 'The registered directory now belongs to a different repository.', 409);
        }
        return this.project(existing);
      }
      const sibling = this.sql.prepare('SELECT project_id FROM projects WHERE common_git_directory=? ORDER BY created_at,project_id LIMIT 1')
        .get(input.commonGitDirectory) as { project_id: string } | undefined;
      if (sibling) return this.addWorktree(sibling.project_id, repositoryId, input);
      const count = this.sql.prepare('SELECT count(*) AS n FROM projects').get() as { n: number };
      if (count.n >= MAX_PROJECTS) throw new WorkbenchError('REGISTRY_LIMIT', `The workbench supports at most ${MAX_PROJECTS} registered projects.`, 409);
      const id = randomUUID();
      this.sql.prepare('INSERT INTO projects(project_id,name,primary_repository_id,common_git_directory,created_at) VALUES(?,?,?,?,?)')
        .run(id, input.name, repositoryId, input.commonGitDirectory, input.registeredAt);
      this.sql.prepare(`INSERT INTO project_workspaces(workspace_id,project_id,name,kind,registered_at) VALUES(?,?,?,'primary',?)`)
        .run(repositoryId, id, input.name, input.registeredAt);
      return this.project(id);
    });
  }

  registerWorkspace(projectId: string, input: ProjectRegistration): ProjectDto {
    return this.database.transaction(() => {
      const project = this.projectRow(projectId);
      if (project.common_git_directory !== input.commonGitDirectory) throw new WorkbenchError('REPOSITORY_MISMATCH', 'Only a directory from this project repository can be registered.', 409);
      const repositoryId = this.registerRepository(input.repositoryPath);
      const existing = this.membership(repositoryId);
      if (existing) {
        if (existing !== projectId) throw new WorkbenchError('WORKSPACE_CONFLICT', 'This directory is registered to another project.', 409);
        return this.project(projectId);
      }
      return this.addWorktree(projectId, repositoryId, input);
    });
  }
}
