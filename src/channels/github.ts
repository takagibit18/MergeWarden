import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SkillBank } from '../skills/bank.ts';
import { feedback } from '../skills/learning.ts';
import type { GithubProvenance, LearningJob, SkillSource } from '../skills/contracts.ts';
import { readRun } from '../engine/reports.ts';
import { SnapshotStore } from '../snapshot/store.ts';
import { hydrateSnapshot } from '../snapshot/hydrate.ts';
import { atomicWrite, writeJson } from '../infrastructure/files.ts';
import { git } from '../infrastructure/git.ts';

/** ADR 0024. Only these associations count as trusted; bots never do, whatever their association. */
export const TRUSTED_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR'] as const);
const VERDICTS: Readonly<Record<string, NonNullable<SkillSource['verdict']>>> = Object.freeze({
  wrong: 'correction', missed: 'missed_defect', contract: 'contract', tradeoff: 'accepted_tradeoff', unsure: 'uncertain',
});
export const COMMAND_HELP = '/mw [wrong|missed|contract|tradeoff|unsure] [finding:ID] then your explanation';

export interface GithubComment {
  id: number; body: string; url: string; html_url: string; author_association: string; user: { login: string; type: string };
  path?: string; side?: string | null; start_side?: string | null;
  original_line?: number | null; original_start_line?: number | null; original_commit_id?: string;
}
export type CommentEventName = 'issue_comment' | 'pull_request_review_comment';
export interface PullRuns { schemaVersion: 1; repository: string; pullNumber: number; runs: Array<{ runId: string; baseCommit: string; headCommit: string; recordedAt: string }> }
export interface ParsedCommand { comment: string; verdict?: NonNullable<SkillSource['verdict']>; findingId?: string }
export type IngestOutcome =
  | { status: 'ignored'; reason: string }
  | { status: 'rejected'; reason: string; eventId: string }
  | { status: 'unchanged' | 'saved' | 'withdrawn'; eventId: string; source: SkillSource; job?: LearningJob };

/** First non-empty line must start with `/mw`. Everything after the command tokens is the feedback text. */
export function parseCommand(body: string): ParsedCommand | null {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex(line => line.trim());
  if (first < 0) return null;
  const tokens = lines[first]!.trim().split(/\s+/);
  if (tokens[0] !== '/mw') return null;
  let index = 1, verdict: ParsedCommand['verdict'], findingId: string | undefined;
  if (tokens[index] && Object.hasOwn(VERDICTS, tokens[index]!)) verdict = VERDICTS[tokens[index++]!];
  const finding = tokens[index]?.match(/^finding:([A-Za-z0-9_-]{1,64})$/);
  if (finding) { findingId = finding[1]; index++; }
  const comment = [tokens.slice(index).join(' '), ...lines.slice(first + 1)].join('\n').trim();
  return { comment, ...(verdict ? { verdict } : {}), ...(findingId ? { findingId } : {}) };
}

export function trustedAuthor(comment: Pick<GithubComment, 'user' | 'author_association'>): comment is typeof comment & { author_association: GithubProvenance['association'] } {
  return comment.user?.type === 'User' && (TRUSTED_ASSOCIATIONS as readonly string[]).includes(comment.author_association);
}

export const eventIdFor = (name: CommentEventName, commentId: number): string => {
  if (!Number.isSafeInteger(commentId) || commentId < 1) throw Error('Invalid GitHub comment id');
  return `fb-gh-${name === 'issue_comment' ? 'ic' : 'rc'}-${commentId}`;
};

const pullsPath = (state: string, pullNumber: number) => join(state, 'channels', 'github', 'pulls', `${pullNumber}.json`);
async function readPull(state: string, pullNumber: number): Promise<PullRuns | undefined> {
  try { return JSON.parse(await readFile(pullsPath(state, pullNumber), 'utf8')) as PullRuns; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Remember which delivered run reviewed which PR head, so later comments can find their frozen snapshot. */
export async function recordRun(state: string, repository: string, pullNumber: number, runId: string): Promise<PullRuns> {
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw Error('Invalid pull request number');
  const run = await readRun(state, runId);
  if (run.status !== 'delivered') throw Error('Only delivered runs can be recorded');
  const { identity } = (await SnapshotStore.load(state, run.snapshotId)).manifest;
  if (!identity.baseCommit || !identity.headCommit) throw Error('GitHub runs must review commits');
  const record = await readPull(state, pullNumber) ?? { schemaVersion: 1, repository, pullNumber, runs: [] };
  if (record.repository !== repository) throw Error('Pull request record belongs to another repository');
  if (!record.runs.some(r => r.runId === runId)) record.runs.push({ runId, baseCommit: identity.baseCommit, headCommit: identity.headCommit, recordedAt: new Date().toISOString() });
  await writeJson(pullsPath(state, pullNumber), record);
  return record;
}

const sameFeedback = (a: SkillSource, b: { comment: string; verdict?: string; findingId?: string; range?: SkillSource['range'] }) =>
  !a.withdrawn && a.comment === b.comment && a.verdict === b.verdict && a.findingId === b.findingId && JSON.stringify(a.range) === JSON.stringify(b.range);

/**
 * Converge the bank to the comment's current state. `current` is the comment as GitHub returns it now (null once deleted),
 * not the webhook body, so redelivered or out-of-order events all reach the same end state.
 */
export async function ingestComment(state: string, input: { repository: string; eventName: CommentEventName; pullNumber: number; commentId: number; current: GithubComment | null; repositoryPath?: string }): Promise<IngestOutcome> {
  const restore = async (snapshotId: string) => { if (input.repositoryPath) await hydrateSnapshot(state, snapshotId, input.repositoryPath); };
  const eventId = eventIdFor(input.eventName, input.commentId);
  const bank = new SkillBank(state);
  const prior = (await bank.current()).snapshot.sources[eventId];
  const existing = prior ? await bank.source(prior) : undefined;
  const command = input.current ? parseCommand(input.current.body) : null;
  const withdraw = async (reason: string): Promise<IngestOutcome> => {
    if (!existing) return { status: 'ignored', reason };
    if (existing.withdrawn) return { status: 'unchanged', eventId, source: existing };
    await restore(existing.snapshotId);
    const { source, job } = await feedback(state, { runId: existing.runId, comment: existing.comment!, eventId, version: existing.version + 1, withdrawn: true, channel: existing.channel!,
      ...(existing.findingId ? { findingId: existing.findingId } : {}), ...(existing.range ? { range: existing.range } : {}), ...(existing.verdict ? { verdict: existing.verdict } : {}) });
    return { status: 'withdrawn', eventId, source, job };
  };
  if (!input.current) return withdraw('Comment deleted before it was recorded');
  if (input.current.id !== input.commentId) throw Error('GitHub comment identity mismatch');
  if (!command) return withdraw('Not a /mw command');
  if (!trustedAuthor(input.current)) return withdraw(`Author is not a trusted collaborator (${input.current.user?.type ?? 'unknown'} ${input.current.author_association})`);
  if (!command.comment) return { status: 'rejected', reason: `Empty feedback; use ${COMMAND_HELP}`, eventId };

  const record = await readPull(state, input.pullNumber);
  if (!record?.runs.length) return { status: 'rejected', reason: 'No delivered MergeWarden run is recorded for this pull request', eventId };
  const reviewed = input.current.original_commit_id;
  const run = existing ? record.runs.find(r => r.runId === existing.runId) : (reviewed && record.runs.findLast(r => r.headCommit === reviewed)) || record.runs.at(-1);
  if (!run) return { status: 'rejected', reason: 'The run this feedback was attached to is no longer recorded', eventId };
  const c = input.current;
  const onHead = input.eventName === 'pull_request_review_comment' && c.side === 'RIGHT' && (c.start_side ?? 'RIGHT') === 'RIGHT' && c.original_commit_id === run.headCommit && typeof c.path === 'string' && Number.isInteger(c.original_line);
  const range = onHead ? { path: c.path!, startLine: c.original_start_line ?? c.original_line!, endLine: c.original_line! } : undefined;
  if (command.verdict === 'accepted_tradeoff' && !range) return { status: 'rejected', reason: 'tradeoff needs an inline comment on head lines of the reviewed commit', eventId };
  const desired = { comment: command.comment, ...(command.verdict ? { verdict: command.verdict } : {}), ...(command.findingId ? { findingId: command.findingId } : {}), ...(range ? { range } : {}) };
  if (existing && sameFeedback(existing, desired)) return { status: 'unchanged', eventId, source: existing };
  const channel: GithubProvenance = { kind: 'github', repository: input.repository, pullNumber: input.pullNumber, commentKind: input.eventName === 'issue_comment' ? 'issue_comment' : 'review_comment',
    commentId: input.commentId, author: c.user.login, association: c.author_association as GithubProvenance['association'], url: c.html_url };
  await restore((await readRun(state, run.runId)).snapshotId);
  try {
    const { source, job } = await feedback(state, { runId: run.runId, eventId, version: (existing?.version ?? 0) + 1, channel: existing?.channel ?? channel, ...desired });
    return { status: 'saved', eventId, source, job };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Feedback failed';
    if (/^(Feedback |Unknown finding|Invalid |Accepted |Missing feedback|Source revision)/.test(message)) return { status: 'rejected', reason: message, eventId };
    throw error;
  }
}

/** Learning reads frozen source; restore blobs for every feedback source that still waits for extraction. */
export async function hydratePendingFeedback(state: string, repositoryPath: string): Promise<{ hydrated: string[]; unavailable: string[] }> {
  const bank = new SkillBank(state), hydrated: string[] = [], unavailable: string[] = [];
  let names: string[] = [];
  try { names = (await readdir(join(bank.root, 'jobs'))).filter(n => /^[a-f0-9]{64}\.json$/.test(n)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const snapshots = new Set<string>();
  for (const name of names) {
    const job = JSON.parse(await readFile(join(bank.root, 'jobs', name), 'utf8')) as LearningJob;
    if (!['pending', 'running', 'failed'].includes(job.status)) continue;
    const source = await bank.source(job.sourceId);
    if (source.kind === 'feedback') snapshots.add(source.snapshotId);
  }
  for (const id of snapshots) {
    try { await hydrateSnapshot(state, id, repositoryPath); hydrated.push(id); } catch { unavailable.push(id); }
  }
  return { hydrated, unavailable };
}

/**
 * The state directory is committed through an allowlist: knowledge, delivered reports, manifests and channel records.
 * Blobs come back from Git, graphs are rebuilt, and locks or credentials never leave the runner.
 */
export const STATE_IGNORE = ['/*', '!/.gitignore', '!/.gitattributes', '!/skills/', '!/runs/', '!/snapshots/', '!/channels/',
  '/skills/**/*.lock', '/runs/*/*', '!/runs/*/run.json', '!/runs/*/report.json', '!/runs/*/report.md', '!/runs/*/navigation.json', ''].join('\n');
/** Hashes cover exact bytes, so Git must never rewrite line endings of persisted state. */
export const STATE_ATTRIBUTES = ['* -text', ''].join('\n');
export async function writeStateIgnore(state: string): Promise<void> {
  await atomicWrite(join(state, '.gitignore'), STATE_IGNORE);
  await atomicWrite(join(state, '.gitattributes'), STATE_ATTRIBUTES);
}

const author = ['-c', 'user.name=mergewarden-state', '-c', 'user.email=mergewarden-state@users.noreply.github.com'];
/**
 * One commit per job, published with optimistic concurrency: a rejected push means another job advanced the branch,
 * so rebase onto it and try again. Project state directories are disjoint, so a rebase conflict signals a real race.
 */
export async function publishState(stateRepo: string, message: string, attempts = 4): Promise<{ pushed: boolean; commit?: string; attempts: number }> {
  await git(stateRepo, ['add', '-A']);
  if (!(await git(stateRepo, ['status', '--porcelain'])).toString().trim()) return { pushed: false, attempts: 0 };
  await git(stateRepo, [...author, 'commit', '-q', '-m', message]);
  const branch = (await git(stateRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toString().trim();
  for (let attempt = 1; ; attempt++) {
    try {
      await git(stateRepo, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
      return { pushed: true, commit: (await git(stateRepo, ['rev-parse', 'HEAD'])).toString().trim(), attempts: attempt };
    } catch (error) {
      if (attempt >= attempts) throw error;
      try { await git(stateRepo, [...author, 'pull', '-q', '--rebase', 'origin', branch]); }
      catch { await git(stateRepo, ['rebase', '--abort']).catch(() => {}); throw Error('State push conflicts with another writer of the same project; rerun the job'); }
    }
  }
}
