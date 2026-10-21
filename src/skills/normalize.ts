import type { Skill, SkillContent } from './contracts.ts';

/**
 * Layer 2 (write-time): deterministic normalization and near-duplicate detection.
 * Semantic equivalence stays a model and approver judgement; these checks only catch
 * the same experience restated with different whitespace, casing, ordering or wording overlap.
 */
export const SIMILARITY_POLICY = Object.freeze({
  version: 'skill-similarity-2',
  /** At or above: refuse the write and name the existing Skill. */
  block: 0.85,
  /** At or above: stage the write with a warning for the approver. */
  warn: 0.6,
});

const LANGUAGE_NAMES: Record<string, string> = {
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', rust: 'Rust', go: 'Go',
  java: 'Java', ruby: 'Ruby', c: 'C', 'c++': 'C++', 'c#': 'C#',
};

const text = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Trim, collapse whitespace and drop case-insensitive repeats while keeping the first spelling. */
function list(values: readonly string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') { out.push(raw); continue; }
    const value = text(raw), key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key); out.push(value);
  }
  return out;
}

const path = (value: string) => text(value).replace(/^(\.\/)+/, '').replace(/\/+$/, '');

/** Canonical form used for validation, hashing and storage. Unknown shapes pass through for validation to reject. */
export function normalizeContent(value: SkillContent): SkillContent {
  if (!value || typeof value !== 'object') return value;
  const c = { ...value };
  if (typeof c.title === 'string') c.title = text(c.title);
  if (typeof c.name === 'string') c.name = text(c.name).toLowerCase();
  if (typeof c.description === 'string') c.description = text(c.description);
  if (c.references && typeof c.references === 'object') {
    c.references = Object.fromEntries(Object.entries(c.references).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim() + '\n' : v]));
  }
  for (const key of ['conditions', 'steps', 'counterexamples', 'stopConditions', 'keywords'] as const) {
    if (Array.isArray(c[key])) c[key] = list(c[key]);
  }
  if (Array.isArray(c.symbols)) c.symbols = list(c.symbols);
  if (Array.isArray(c.stillReportWhen)) c.stillReportWhen = list(c.stillReportWhen);
  if (Array.isArray(c.paths)) c.paths = list(c.paths.map(p => typeof p === 'string' ? path(p) : p));
  if (Array.isArray(c.languages)) c.languages = list(c.languages.map(l => typeof l === 'string' ? LANGUAGE_NAMES[text(l).toLowerCase()] ?? text(l) : l));
  if (Array.isArray(c.dependencies)) {
    c.dependencies = c.dependencies
      .map(d => d && typeof d === 'object' && typeof d.path === 'string' ? { ...d, path: path(d.path) } : d)
      .sort((a, b) => String(a?.path).localeCompare(String(b?.path)));
  }
  return c;
}

const STOP_WORDS = new Set('the and for are but not you all any can has have its may into than that then this when where which with from only must should before after each also does more such other there these those their them they been being while what will would could inspect check review read verify'.split(' '));

/** Word tokens for Latin text plus character bigrams for CJK runs, so Chinese restatements also overlap. */
export function tokens(value: string): Set<string> {
  const out = new Set<string>();
  const lower = value.normalize('NFC').toLowerCase();
  for (const word of lower.match(/[a-z0-9_]+/g) ?? []) if (word.length >= 3 && !STOP_WORDS.has(word)) out.add(word);
  for (const run of lower.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

const behaviour = (c: SkillContent) => tokens([c.title, c.description ?? '', ...c.conditions, ...c.steps, ...c.counterexamples, ...c.stopConditions].join('\n'));

/** Jaccard overlap of the checking behaviour: title, description, conditions, steps, counterexamples and stop conditions. */
export function similarity(a: SkillContent, b: SkillContent): number {
  const x = behaviour(a), y = behaviour(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const token of x) if (y.has(token)) shared++;
  return shared / (x.size + y.size - shared);
}

export interface SimilarityMatch { id: string; score: number }

/** Closest same-repository Skills by behaviour, excluding the target itself and retired knowledge. */
export function nearestSkills(content: SkillContent, skills: readonly Skill[], options: { repositoryKey: string; exclude?: string }): SimilarityMatch[] {
  return skills
    .filter(s => s.repositoryKey === options.repositoryKey && s.id !== options.exclude && s.state !== 'retired')
    .map(s => ({ id: s.id, score: Math.round(similarity(content, s) * 1000) / 1000 }))
    .filter(m => m.score >= SIMILARITY_POLICY.warn)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
