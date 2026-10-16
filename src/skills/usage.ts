import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readRun, runPath } from '../engine/reports.ts';
import { writeJson } from '../infrastructure/files.ts';
import { SkillBank } from './bank.ts';
import type { SkillSource } from './contracts.ts';

/**
 * Skill usage is a rebuildable projection of immutable run artifacts. Reviews never write it:
 * each run already records which Skills its frozen catalog exposed (run.json `skills.available`)
 * and which bodies the model actually read (`skill-reads.json`).
 */
export const USAGE_POLICY_VERSION = 'skill-usage-1';

export interface FeedbackSignals { supports: number; contradicts: number; addsMissingIssue: number; addsContext: number; unclassified: number }
export interface SkillUsage {
  id: string;
  /** Runs whose frozen catalog listed this Skill (comparable to Hermes `use_count`). */
  exposures: number;
  /** Runs in which the model loaded the full body (comparable to Hermes `view_count`). */
  reads: number;
  firstExposedAt: string | null; lastExposedAt: string | null; lastReadAt: string | null;
  revisionsRead: number[];
  /** Feedback left on runs that read this Skill. Co-occurrence only: it does not show the Skill caused the outcome. */
  feedbackOnReadingRuns: FeedbackSignals;
}
export interface UsageIndex {
  version: string; computedAt: string; bankSnapshotId: string;
  runsScanned: number; runsWithSkills: number; unreadableRuns: number;
  skills: Record<string, SkillUsage>;
}

const emptySignals = (): FeedbackSignals => ({ supports: 0, contradicts: 0, addsMissingIssue: 0, addsContext: 0, unclassified: 0 });
const later = (a: string | null, b: string) => (!a || b > a ? b : a);
const earlier = (a: string | null, b: string) => (!a || b < a ? b : a);

async function reads(state: string, runId: string): Promise<Array<{ id: string; revision: number; at: string }>> {
  try {
    const value = JSON.parse(await readFile(join(runPath(state, runId), 'skill-reads.json'), 'utf8'));
    return Array.isArray(value) ? value.filter(e => e && typeof e.id === 'string' && Number.isInteger(e.revision) && typeof e.at === 'string') : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function computeUsage(state: string, now = new Date()): Promise<UsageIndex> {
  const bank = new SkillBank(state), { id: bankSnapshotId, snapshot } = await bank.current();
  const skills: Record<string, SkillUsage> = {};
  const entry = (id: string) => (skills[id] ??= { id, exposures: 0, reads: 0, firstExposedAt: null, lastExposedAt: null, lastReadAt: null, revisionsRead: [], feedbackOnReadingRuns: emptySignals() });
  for (const s of await bank.skills(snapshot)) entry(s.id);

  // Current feedback versions only: an edited or withdrawn comment no longer counts.
  const feedbackByRun = new Map<string, SkillSource[]>();
  for (const ref of Object.values(snapshot.sources)) {
    const source = await bank.source(ref);
    if (source.kind !== 'feedback' || source.withdrawn) continue;
    feedbackByRun.set(source.runId, [...feedbackByRun.get(source.runId) ?? [], source]);
  }

  let runIds: string[] = [];
  try { runIds = (await readdir(join(state, 'runs'))).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let runsWithSkills = 0, unreadableRuns = 0;
  for (const runId of runIds) {
    let manifest;
    try { manifest = await readRun(state, runId); } catch { unreadableRuns++; continue; }
    if (!manifest.skills?.available.length) continue;
    runsWithSkills++;
    for (const exposed of new Set(manifest.skills.available.map(a => a.id))) {
      const usage = entry(exposed);
      usage.exposures++;
      usage.firstExposedAt = earlier(usage.firstExposedAt, manifest.createdAt);
      usage.lastExposedAt = later(usage.lastExposedAt, manifest.createdAt);
    }
    let loaded: Awaited<ReturnType<typeof reads>>;
    try { loaded = await reads(state, runId); } catch { unreadableRuns++; continue; }
    const readIds = new Set<string>();
    for (const event of loaded) {
      const usage = entry(event.id);
      if (!readIds.has(event.id)) usage.reads++;
      readIds.add(event.id);
      usage.lastReadAt = later(usage.lastReadAt, event.at);
      if (!usage.revisionsRead.includes(event.revision)) usage.revisionsRead.push(event.revision);
    }
    for (const source of feedbackByRun.get(runId) ?? []) {
      for (const id of readIds) {
        const signals = entry(id).feedbackOnReadingRuns;
        if (source.relationToReview === 'supports') signals.supports++;
        else if (source.relationToReview === 'contradicts') signals.contradicts++;
        else if (source.relationToReview === 'adds_missing_issue') signals.addsMissingIssue++;
        else if (source.relationToReview === 'adds_context') signals.addsContext++;
        else signals.unclassified++;
      }
    }
  }
  for (const usage of Object.values(skills)) usage.revisionsRead.sort((a, b) => a - b);
  return { version: USAGE_POLICY_VERSION, computedAt: now.toISOString(), bankSnapshotId, runsScanned: runIds.length, runsWithSkills, unreadableRuns, skills };
}

/** Recompute from run artifacts and cache the result for inspection. The cache is never an input to reviews. */
export async function refreshUsage(state: string, now = new Date()): Promise<UsageIndex> {
  const index = await computeUsage(state, now);
  await writeJson(join(state, 'skills', 'usage.json'), index);
  return index;
}
