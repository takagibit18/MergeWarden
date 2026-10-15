import { createHash } from 'node:crypto';
import type { DiffQuery, DiffRowDto, DiffSideDto, FrozenDiffDto } from '../../packages/contracts/src/types.ts';
import { WorkbenchError } from '../ports/workbench-errors.ts';

export interface EvidenceDiffInput {
  snapshotId: string;
  path: string;
  /** Complete text whose frozen blob hash was checked by the caller; null means absent. */
  before: string | null;
  after: string | null;
  baseMode: string | null;
  headMode: string | null;
}

/** Internal fault-injection limits. HTTP callers cannot supply or raise these limits. */
export interface EvidenceDiffLimits {
  maxInputBytes?: number;
  maxInputLines?: number;
  maxWork?: number;
  maxTraceCells?: number;
  maxOutputBytes?: number;
}

const DEFAULT_LIMITS = {
  maxInputBytes: 1024 * 1024,
  maxInputLines: 50_000,
  maxWork: 2_000_000,
  maxTraceCells: 1_000_000,
  maxOutputBytes: 64 * 1024,
};
type Limits = typeof DEFAULT_LIMITS;
type Line = { text: string; id: number; noFinalNewline: boolean };
type Operation = { kind: 'context' | 'addition' | 'deletion'; line: Line };
class DiffBudgetExceeded extends Error {}

function limitsFor(input: EvidenceDiffLimits): Limits {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const value = input[key] ?? limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) throw new RangeError('Invalid internal diff limit');
    limits[key] = value;
  }
  return limits;
}

function side(text: string | null, mode: string | null): DiffSideDto {
  if (text === null) return { exists: false, contentSha256: null, totalLines: 0, endsWithNewline: null, mode: null };
  let totalLines = 0;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) totalLines++;
  if (text && !text.endsWith('\n')) totalLines++;
  return { exists: true, contentSha256: createHash('sha256').update(text).digest('hex'), totalLines, endsWithNewline: text.endsWith('\n'), mode };
}

function changeType(input: EvidenceDiffInput): FrozenDiffDto['changeType'] {
  if (input.before === null && input.after !== null) return 'added';
  if (input.before !== null && input.after === null) return 'deleted';
  return input.before === input.after && input.baseMode === input.headMode ? 'unchanged' : 'modified';
}

function tokenize(text: string | null, identities: Map<string, number>, charge: (count?: number) => void): Line[] {
  if (text === null || text === '') return [];
  const rows = text.split('\n');
  const finalNewline = rows.at(-1) === '';
  if (finalNewline) rows.pop();
  return rows.map((value, index) => {
    charge();
    const noFinalNewline = !finalNewline && index === rows.length - 1;
    // Intern complete line tokens once. Myers then compares integer identities,
    // including the LF terminator, rather than repeatedly comparing long text.
    const token = noFinalNewline ? value : value + '\n';
    let id = identities.get(token);
    if (id === undefined) { id = identities.size; identities.set(token, id); }
    return { text: value, id, noFinalNewline };
  });
}

function backtrack(trace: Int32Array[], a: Line[], b: Line[], charge: (count?: number) => void): Operation[] {
  let x = a.length, y = b.length;
  const reversed: Operation[] = [];
  for (let distance = trace.length - 1; distance > 0; distance--) {
    const previous = trace[distance - 1]!;
    const diagonal = x - y;
    const left = diagonal === -distance ? -1 : previous[diagonal - 1 + distance - 1]!;
    const right = diagonal === distance ? -1 : previous[diagonal + 1 + distance - 1]!;
    const priorDiagonal = diagonal === -distance || (diagonal !== distance && left < right) ? diagonal + 1 : diagonal - 1;
    const priorX = previous[priorDiagonal + distance - 1]!;
    const priorY = priorX - priorDiagonal;
    while (x > priorX && y > priorY) {
      charge(); reversed.push({ kind: 'context', line: a[--x]! }); y--;
    }
    charge();
    if (x === priorX) reversed.push({ kind: 'addition', line: b[--y]! });
    else reversed.push({ kind: 'deletion', line: a[--x]! });
  }
  while (x > 0 && y > 0) { charge(); reversed.push({ kind: 'context', line: a[--x]! }); y--; }
  if (x !== 0 || y !== 0) throw new Error('Invalid display diff trace');
  return reversed.reverse();
}

/** A bounded shortest edit script. No approximate script escapes a budget failure. */
function edits(a: Line[], b: Line[], limits: Limits, charge: (count?: number) => void): Operation[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length) { charge(); if (a[prefix]!.id !== b[prefix]!.id) break; prefix++; }
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix) {
    charge(); if (a[a.length - suffix - 1]!.id !== b[b.length - suffix - 1]!.id) break; suffix++;
  }
  const before = a.slice(prefix, a.length - suffix), after = b.slice(prefix, b.length - suffix);
  let middle: Operation[];
  if (!before.length) { charge(after.length); middle = after.map(line => ({ kind: 'addition', line })); }
  else if (!after.length) { charge(before.length); middle = before.map(line => ({ kind: 'deletion', line })); }
  else {
    const trace: Int32Array[] = [];
    let previous = new Int32Array(0), traceCells = 0;
    let complete = false;
    for (let distance = 0; distance <= before.length + after.length && !complete; distance++) {
      const cells = 2 * distance + 1;
      if (traceCells + cells > limits.maxTraceCells) throw new DiffBudgetExceeded();
      traceCells += cells;
      const current = new Int32Array(cells);
      for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
        charge();
        let x = 0;
        if (distance > 0) {
          const left = diagonal === -distance ? -1 : previous[diagonal - 1 + distance - 1]!;
          const right = diagonal === distance ? -1 : previous[diagonal + 1 + distance - 1]!;
          x = diagonal === -distance || (diagonal !== distance && left < right) ? right : left + 1;
        }
        let y = x - diagonal;
        while (x < before.length && y < after.length) {
          charge(); if (before[x]!.id !== after[y]!.id) break; x++; y++;
        }
        current[diagonal + distance] = x;
        if (x >= before.length && y >= after.length) { complete = true; break; }
      }
      trace.push(current); previous = current;
    }
    if (!complete) throw new Error('Invalid display diff search');
    middle = backtrack(trace, before, after, charge);
  }
  charge(prefix + suffix);
  return [
    ...a.slice(0, prefix).map(line => ({ kind: 'context' as const, line })), ...middle,
    ...a.slice(a.length - suffix).map(line => ({ kind: 'context' as const, line })),
  ];
}

function hunks(operations: Operation[], charge: (count?: number) => void): DiffRowDto[] {
  const lines: DiffRowDto[] = [];
  const basePositions = [0], headPositions = [0];
  let baseLine = 0, headLine = 0;
  const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < operations.length; index++) {
    charge();
    const operation = operations[index]!;
    lines.push({ kind: operation.kind, text: operation.line.text,
      baseLine: operation.kind === 'addition' ? null : ++baseLine,
      headLine: operation.kind === 'deletion' ? null : ++headLine,
      ...(operation.line.noFinalNewline ? { noFinalNewline: true } : {}) });
    basePositions.push(baseLine); headPositions.push(headLine);
    if (operation.kind === 'context') continue;
    const start = Math.max(0, index - 3), end = Math.min(operations.length, index + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  const rows: DiffRowDto[] = [];
  for (const range of ranges) {
    charge(range.end - range.start + 1);
    const baseCount = basePositions[range.end]! - basePositions[range.start]!;
    const headCount = headPositions[range.end]! - headPositions[range.start]!;
    const baseStart = basePositions[range.start]! + (baseCount ? 1 : 0);
    const headStart = headPositions[range.start]! + (headCount ? 1 : 0);
    rows.push({ kind: 'hunk', text: `@@ -${baseStart},${baseCount} +${headStart},${headCount} @@`, baseLine: null, headLine: null,
      hunk: { baseStart, baseCount, headStart, headCount } });
    rows.push(...lines.slice(range.start, range.end));
  }
  return rows;
}

/** Presentation only: callers provide verified, complete text from one frozen snapshot. */
export function buildEvidenceDiff(input: EvidenceDiffInput, query: DiffQuery = {}, overrides: EvidenceDiffLimits = {}): FrozenDiffDto {
  const offset = query.offset ?? 0, limit = query.limit ?? 200;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2_000_000 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new WorkbenchError('INVALID_QUERY', 'Diff offset or limit is invalid.', 400);
  }
  const limits = limitsFor(overrides);
  const base = side(input.before, input.baseMode), head = side(input.after, input.headMode);
  const metadata = { snapshotId: input.snapshotId, path: input.path, changeType: changeType(input), base, head };
  const unavailable = (warning: string): FrozenDiffDto => ({ ...metadata, status: 'unavailable', rows: [], offset: 0,
    totalRows: 0, nextOffset: null, truncated: false, warnings: [warning] });
  if ([input.before, input.after].some(text => text !== null && Buffer.byteLength(text) > limits.maxInputBytes) ||
    base.totalLines > limits.maxInputLines || head.totalLines > limits.maxInputLines) {
    return unavailable('Frozen diff exceeds the display input budget. Read the verified source evidence instead.');
  }
  let work = 0;
  const charge = (count = 1) => { work += count; if (work > limits.maxWork) throw new DiffBudgetExceeded(); };
  let all: DiffRowDto[];
  try {
    const identities = new Map<string, number>();
    all = hunks(edits(tokenize(input.before, identities, charge), tokenize(input.after, identities, charge), limits, charge), charge);
  } catch (error) {
    return unavailable(error instanceof DiffBudgetExceeded
      ? 'Accurate frozen diff exceeded its computation budget. Read the verified source evidence instead.'
      : 'Accurate frozen diff could not be generated. Read the verified source evidence instead.');
  }
  if (offset > all.length) throw new WorkbenchError('INVALID_QUERY', 'Diff offset is outside this frozen diff.', 400);
  if (all.some(row => row.text.length > 16_384)) return unavailable('A frozen diff line exceeds the display limit. Read the verified source evidence instead.');
  const rows: DiffRowDto[] = [];
  let bytes = 0;
  for (const row of all.slice(offset, offset + limit)) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row));
    if (bytes + rowBytes > limits.maxOutputBytes) break;
    rows.push(row); bytes += rowBytes;
  }
  if (offset < all.length && rows.length === 0) return unavailable('A frozen diff row exceeds the display byte budget. Read the verified source evidence instead.');
  const next = offset + rows.length;
  const truncated = next < all.length;
  return { ...metadata, status: 'ok', rows, offset, totalRows: all.length, nextOffset: truncated ? next : null, truncated,
    warnings: truncated ? ['Frozen diff display is paginated; additional rows remain.'] : [] };
}
