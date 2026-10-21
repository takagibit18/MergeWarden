import type { Skill, SkillContent } from './contracts.ts';

/**
 * SKILL.md interchange format (skill-md-2), modelled on agent Skill packages: YAML frontmatter with a
 * name and a trigger-oriented description, a concise Markdown body, and optional reference files that
 * the reviewer opens only when needed. Storage stays content-addressed JSON; this module converts both ways.
 * Learned Skills never carry scripts: reviews are read-only and must not execute learned code.
 */
export const SKILL_FORMAT = 'skill-md-2';
/** skill-md-2 only adds *Still report when*; Skills without it keep reading as skill-md-1 so replays see the same body. */
export const skillFormat = (skill: SkillContent) => skill.stillReportWhen ? SKILL_FORMAT : 'skill-md-1';
export const SKILL_FORMAT_LIMITS = Object.freeze({ markdownBytes: 6000, references: 2, referenceBytes: 2500 });

/** Body sections, in order. Each maps to one structured field so validation and similarity keep working. */
const SECTIONS = [
  ['when to use', 'conditions'],
  ['procedure', 'steps'],
  ['not a defect when', 'counterexamples'],
  ['stop when', 'stopConditions'],
  ['still report when', 'stillReportWhen'],
] as const;
const HEADINGS: Record<(typeof SECTIONS)[number][1], string> = { conditions: 'When to use', steps: 'Procedure', counterexamples: 'Not a defect when', stopConditions: 'Stop when', stillReportWhen: 'Still report when' };
const LIST_KEYS = ['paths', 'languages', 'keywords', 'symbols', 'dependencyRefs'] as const;
const SCALAR_KEYS = ['name', 'description', 'type', 'scope'] as const;

export interface ParsedSkill { content: Omit<SkillContent, 'dependencies'>; dependencyRefs: string[] }

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.startsWith('"') ? JSON.parse(v) as string : v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/** Comma split that respects double and single quotes, for `[a, "b, c"]` flow lists. */
function flowList(value: string): string[] {
  const inner = value.trim().slice(1, -1), out: string[] = [];
  let current = '', quote = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) { current += ch; if (ch === quote && inner[i - 1] !== '\\') quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ',') { out.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out.map(unquote).filter(Boolean);
}

/** A deliberately small YAML subset: `key: scalar`, `key: [flow, list]` and `key:` followed by `- item` lines. */
function frontmatter(block: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const raw of block.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item) {
      if (!listKey) throw Error('Skill frontmatter list item without a key');
      (out[listKey] as string[]).push(unquote(item[1]!));
      continue;
    }
    // Models sometimes indent a top-level key; a key line is still unambiguous because list items start with '-'.
    const pair = /^\s*([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(raw);
    if (!pair) throw Error(`Unsupported Skill frontmatter line: ${raw.slice(0, 80)}`);
    const [, key, rest] = pair as unknown as [string, string, string];
    if (Object.hasOwn(out, key)) throw Error(`Duplicate Skill frontmatter key ${key}`);
    const value = rest.trim();
    if (!value) { out[key] = []; listKey = key; continue; }
    listKey = undefined;
    out[key] = value.startsWith('[') && value.endsWith(']') ? flowList(value) : unquote(value);
  }
  return out;
}

/** Parse a learned SKILL.md into structured content. Unknown keys, sections or scripts are rejected. */
export function parseSkillMarkdown(markdown: string): ParsedSkill {
  if (typeof markdown !== 'string' || !markdown.trim()) throw Error('Missing SKILL.md');
  if (Buffer.byteLength(markdown) > SKILL_FORMAT_LIMITS.markdownBytes) throw Error('SKILL.md exceeds byte limit');
  const text = markdown.replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.trimStart());
  if (!match) throw Error('SKILL.md requires YAML frontmatter between --- lines');
  const meta = frontmatter(match[1]!);
  for (const key of Object.keys(meta)) {
    if (![...SCALAR_KEYS, ...LIST_KEYS].includes(key as never)) throw Error(`Unknown Skill frontmatter key ${key}`);
  }
  for (const key of SCALAR_KEYS) if (Array.isArray(meta[key])) throw Error(`Skill frontmatter ${key} must be a scalar`);
  for (const key of LIST_KEYS) if (meta[key] !== undefined && !Array.isArray(meta[key])) throw Error(`Skill frontmatter ${key} must be a list`);

  const lines = match[2]!.split('\n');
  let title: string | undefined, section: string | undefined;
  const fields: Record<string, string[]> = { conditions: [], steps: [], counterexamples: [], stopConditions: [] };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const h1 = /^#\s+(.+)$/.exec(line), h2 = /^##\s+(.+)$/.exec(line);
    if (h1) { if (title) throw Error('SKILL.md has more than one title'); title = h1[1]!.trim(); continue; }
    if (h2) {
      const heading = h2[1]!.trim().toLowerCase().replace(/:$/, '');
      // The rendered References index is derived from the reference files, never parsed as content.
      if (heading === 'references') { section = 'ignore'; continue; }
      const known = SECTIONS.find(([h]) => h === heading);
      if (!known) throw Error(`Unknown SKILL.md section "${h2[1]!.trim()}"; use ${Object.values(HEADINGS).join(', ')}`);
      section = known[1];
      fields[section] ??= [];
      continue;
    }
    const bullet = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (!section) throw Error('SKILL.md body text must sit inside a known section');
    if (section === 'ignore') continue;
    if (bullet) fields[section]!.push(bullet[1]!.trim());
    else if (fields[section]!.length) fields[section]![fields[section]!.length - 1] += ' ' + line.trim();
    else throw Error(`SKILL.md section ${HEADINGS[section as keyof typeof HEADINGS]} must use list items`);
  }
  if (!title) throw Error('SKILL.md requires a # title');
  if (typeof meta.name !== 'string' || typeof meta.description !== 'string') throw Error('SKILL.md frontmatter requires name and description');
  const scope = meta.scope as string | undefined;
  const list = (key: (typeof LIST_KEYS)[number]) => (meta[key] as string[] | undefined) ?? [];
  return {
    content: {
      name: meta.name as string, description: meta.description as string,
      type: meta.type as SkillContent['type'], ...(scope !== undefined ? { scopeType: scope as NonNullable<SkillContent['scopeType']> } : {}),
      title, conditions: fields.conditions!, steps: fields.steps!, counterexamples: fields.counterexamples!, stopConditions: fields.stopConditions!,
      ...(fields.stillReportWhen ? { stillReportWhen: fields.stillReportWhen } : {}),
      paths: list('paths'), languages: list('languages'), keywords: list('keywords'), symbols: list('symbols'),
    },
    dependencyRefs: list('dependencyRefs'),
  };
}

/** Learned references are plain Markdown documents; executable scripts are refused. */
export function parseReferences(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Skill references must be an object of file names to Markdown');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > SKILL_FORMAT_LIMITS.references) throw Error(`At most ${SKILL_FORMAT_LIMITS.references} Skill references`);
  const out: Record<string, string> = {};
  for (const [name, body] of entries) {
    if (/\.(py|js|mjs|ts|sh|ps1|bat|exe|rb|pl)$/i.test(name)) throw Error('Learned Skills cannot carry scripts; reviews are read-only');
    if (!/^[a-z0-9][a-z0-9-]{0,39}\.md$/.test(name)) throw Error(`Invalid Skill reference name ${name}`);
    if (typeof body !== 'string' || !body.trim() || Buffer.byteLength(body) > SKILL_FORMAT_LIMITS.referenceBytes) throw Error(`Invalid Skill reference ${name}`);
    out[name] = body;
  }
  return entries.length ? out : undefined;
}

const yamlValue = (v: string) => /^[A-Za-z0-9 _./()+-]+$/.test(v) && !/^[-\s]/.test(v) && !v.endsWith(' ') ? v : JSON.stringify(v);
const yamlList = (values: readonly string[]) => `[${values.map(yamlValue).join(', ')}]`;

/** Render stored content as SKILL.md. Legacy Skills without name/description render from their title. */
export function renderSkillMarkdown(skill: SkillContent | Skill): string {
  const name = skill.name ?? skill.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  const lines = ['---', `name: ${name}`];
  if (skill.description) lines.push(`description: ${JSON.stringify(skill.description)}`);
  lines.push(`type: ${skill.type}`);
  if (skill.scopeType) lines.push(`scope: ${skill.scopeType}`);
  lines.push(`paths: ${yamlList(skill.paths)}`, `languages: ${yamlList(skill.languages)}`, `keywords: ${yamlList(skill.keywords)}`);
  if (skill.symbols?.length) lines.push(`symbols: ${yamlList(skill.symbols)}`);
  if ('state' in skill) lines.push(`state: ${skill.state}`, `revision: ${skill.revision}`);
  lines.push('---', '', `# ${skill.title}`);
  for (const [, field] of SECTIONS) {
    const items = skill[field];
    if (!items) continue;
    lines.push('', `## ${HEADINGS[field]}`);
    items.forEach((v, i) => lines.push(field === 'steps' ? `${i + 1}. ${v}` : `- ${v}`));
  }
  const references = Object.keys(skill.references ?? {});
  if (references.length) lines.push('', '## References', ...references.map(r => `- references/${r}`));
  return lines.join('\n') + '\n';
}
