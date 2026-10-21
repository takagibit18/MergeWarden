const lines = (text: string | null) => text === null || text === "" ? [] : text.replace(/\n$/, "").split("\n");
/** Equal prefix and suffix line counts; everything between them is the single replacement hunk. */
function trim(a: string[], b: string[]) {
  let first = 0;
  while (first < a.length && first < b.length && a[first] === b[first]) first++;
  let tail = 0;
  while (tail < a.length - first && tail < b.length - first && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { first, tail };
}

/** A valid unified replacement hunk after trimming equal prefix/suffix lines.
 * Deliberately avoids quadratic LCS on untrusted input. */
export function frozenDiff(path: string, before: string | null, after: string | null): string[] {
  const a = lines(before); const b = lines(after);
  const { first, tail } = trim(a, b);
  const start = Math.max(0, first - 3); const aEnd = Math.min(a.length, a.length - tail + 3); const bEnd = Math.min(b.length, b.length - tail + 3);
  return [`--- ${before === null ? "/dev/null" : "a/" + path}`, `+++ ${after === null ? "/dev/null" : "b/" + path}`,
    `@@ -${a.length ? start + 1 : 0},${aEnd - start} +${b.length ? start + 1 : 0},${bEnd - start} @@`,
    ...a.slice(start, first).map(line => " " + line),
    ...a.slice(first, a.length - tail).map(line => "-" + line),
    ...b.slice(first, b.length - tail).map(line => "+" + line),
    ...a.slice(a.length - tail, aEnd).map(line => " " + line),
    ...(before !== null && after !== null && before.endsWith("\n") !== after.endsWith("\n") ? ["\ Final newline changed"] : [])];
}

/** Head lines (1-based, inclusive) inside the frozen replacement hunk; undefined when the change only deletes. */
export function changedHeadLines(before: string | null, after: string | null): { startLine: number; endLine: number } | undefined {
  const a = lines(before); const b = lines(after);
  const { first, tail } = trim(a, b);
  return first < b.length - tail ? { startLine: first + 1, endLine: b.length - tail } : undefined;
}
