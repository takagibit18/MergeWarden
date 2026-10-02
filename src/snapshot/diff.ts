/** A valid unified replacement hunk after trimming equal prefix/suffix lines.
 * Deliberately avoids quadratic LCS on untrusted input. */
export function frozenDiff(path: string, before: string | null, after: string | null): string[] {
  const lines = (text: string | null) => text === null || text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const a = lines(before); const b = lines(after);
  let first = 0;
  while (first < a.length && first < b.length && a[first] === b[first]) first++;
  let tail = 0;
  while (tail < a.length - first && tail < b.length - first && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const start = Math.max(0, first - 3); const aEnd = Math.min(a.length, a.length - tail + 3); const bEnd = Math.min(b.length, b.length - tail + 3);
  return [`--- ${before === null ? "/dev/null" : "a/" + path}`, `+++ ${after === null ? "/dev/null" : "b/" + path}`,
    `@@ -${a.length ? start + 1 : 0},${aEnd - start} +${b.length ? start + 1 : 0},${bEnd - start} @@`,
    ...a.slice(start, first).map(line => " " + line),
    ...a.slice(first, a.length - tail).map(line => "-" + line),
    ...b.slice(first, b.length - tail).map(line => "+" + line),
    ...a.slice(a.length - tail, aEnd).map(line => " " + line),
    ...(before !== null && after !== null && before.endsWith("\n") !== after.endsWith("\n") ? ["\\ Final newline changed"] : [])];
}
