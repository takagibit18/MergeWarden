import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git } from '../git.ts';

export interface RegisteredRepositoryDirectory {
  repositoryPath: string;
  commonGitDirectory: string;
}

/** Resolve only a directory explicitly supplied by the host. No worktrees are discovered. */
export async function repositoryDirectory(path: string): Promise<RegisteredRepositoryDirectory> {
  if (typeof path !== 'string' || !path.trim() || path.length > 4096 || /[\x00-\x1f]/.test(path)) {
    throw new Error('A repository root directory is required');
  }
  const repositoryPath = await realpath(resolve(path));
  if (!(await lstat(repositoryPath)).isDirectory()) throw new Error('Choose a repository root directory');
  const root = (await git(repositoryPath, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  if (await realpath(root) !== repositoryPath) throw new Error('Choose the repository root directory');
  const common = (await git(repositoryPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString('utf8').trim();
  if (!common || /[\x00-\x1f]/.test(common)) throw new Error('Repository identity could not be resolved');
  const commonGitDirectory = await realpath(common);
  if (!(await lstat(commonGitDirectory)).isDirectory()) throw new Error('Repository identity is unavailable');
  return { repositoryPath, commonGitDirectory };
}
