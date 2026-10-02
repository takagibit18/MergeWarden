/** Recoverable submission failures carry bounded, mechanical repair information. */
export class SubmissionValidationError extends Error {
  readonly diagnostics: Record<string, unknown>;
  constructor(message: string, diagnostics: Record<string, unknown>) {
    super(message); this.name = "SubmissionValidationError"; this.diagnostics = diagnostics;
  }
}

export function missingDiffCoverage(paths: readonly string[], reads: ReadonlyMap<string, { total: number; seen: ReadonlySet<number> }>) {
  return paths.flatMap(path => {
    const coverage = reads.get(path);
    if (coverage && coverage.seen.size === coverage.total) return [];
    let cursor = 0;
    if (coverage) while (cursor < coverage.total && coverage.seen.has(cursor)) cursor++;
    return [{ path, cursor, readLines: coverage?.seen.size ?? 0, totalLines: coverage?.total ?? null }];
  });
}
