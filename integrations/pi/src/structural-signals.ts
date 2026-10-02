export type RouteType = "CALLER_CHECK" | "INHERITANCE_CHECK" | "IMPORT_CHECK" | "STRUCTURAL_ESCALATION";
export interface StructuralSignal { change?: import('../../../src/engine/declarations.ts').DeclarationChange; routeType: RouteType; targetHint: string; relationHint: string; reason: string; strength: "high" | "weak" }
const compact = (s: string) => s.replace(/\s+/g, "").replace(/,$/, "");
/** Conservative, Python-only diff cues, not a parser or graph resolver. Call on a complete cached diff. */
export function detectStructuralSignals(path: string, lines: string[]): StructuralSignal[] {
  if (!path.endsWith(".py")) return [];
  const removed: string[] = [], added: string[] = [];
  let oldExportDepth = 0, newExportDepth = 0;
  const oldExports: string[] = [], newExports: string[] = [];
  const exportDepth = (s: string, depth: number, exports: string[]) => {
    if (depth === 0 && !/^__all__\s*(?:=|\+=)/.test(s)) return 0;
    exports.push(s);
    const brackets = s.replace(/(['"])(?:\\.|(?!\1).)*\1/g, "").replace(/#.*$/, "");
    return Math.max(0, depth + (brackets.match(/[\[({]/g)?.length ?? 0) - (brackets.match(/[\])}]/g)?.length ?? 0));
  };
  let oldQuote = "", newQuote = "";
  function code(s: string, quote: string): [string, string] {
    let out = "";
    for (let i = 0; i < s.length;) {
      if (quote) { const end = s.indexOf(quote, i); if (end < 0) return [out, quote]; i = end + 3; quote = ""; }
      else if (s.slice(i, i + 3) === '"""' || s.slice(i, i + 3) === "'''") { quote = s.slice(i, i + 3); i += 3; }
      else if (s[i] === "#") break;
      else if (s[i] === '"' || s[i] === "'") { const q = s[i]!; out += q; i++; while (i < s.length) { const c = s[i++]!; out += c; if (c === "\\" && i < s.length) out += s[i++]; else if (c === q) break; } }
      else out += s[i++];
    }
    return [out, quote];
  }
  for (const line of lines) {
    if (/^(---|\+\+\+|diff |index |@@|\\)/.test(line)) continue;
    const prefix = line[0], body = line.slice(1);
    if (prefix === "-" || prefix === " ") { const [s, q] = code(body, oldQuote); oldQuote = q; oldExportDepth = exportDepth(s, oldExportDepth, oldExports); if (prefix === "-" && s.trim()) removed.push(s); }
    if (prefix === "+" || prefix === " ") { const [s, q] = code(body, newQuote); newQuote = q; newExportDepth = exportDepth(s, newExportDepth, newExports); if (prefix === "+" && s.trim()) added.push(s); }
  }
  const signals: StructuralSignal[] = [];
  const push = (routeType: RouteType, targetHint: string, relationHint: string, reason: string, strength: "high" | "weak" = "high") => signals.push({ routeType, targetHint, relationHint, reason, strength });
  const declaration = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\((.*)\)\s*(?:->\s*(.*?))?\s*:/;
  const oldDefs = removed.map(s => s.match(declaration)).filter(x => x !== null);
  const newDefs = added.map(s => s.match(declaration)).filter(x => x !== null);
  for (const old of oldDefs) {
    const next = newDefs.find(n => n[1] === old[1] && n[2] === old[2]);
    if (!next) push("CALLER_CHECK", old[2]!, "incoming CALLS", "callable_removal");
    else if (compact(old[3]!) !== compact(next[3]!) || /^\s*async\b/.test(old[0]) !== /^\s*async\b/.test(next[0])) push("CALLER_CHECK", old[2]!, "incoming CALLS", "signature_change");
    else if (compact(old[4] ?? "") !== compact(next[4] ?? "")) push("CALLER_CHECK", old[2]!, "incoming CALLS", "return_annotation_change", "weak");
  }
  const cls = /^\s*class\s+(\w+)\s*(?:\((.*?)\))?\s*:/;
  for (const old of removed.map(s => s.match(cls)).filter(x => x !== null)) {
    const next = added.map(s => s.match(cls)).find(n => n?.[1] === old[1]);
    if (next && compact(old[2] ?? "") !== compact(next[2] ?? "")) push("INHERITANCE_CHECK", old[1]!, "INHERITS", "base_list_change");
  }
  const changed = [...removed.filter(s => !added.some(a => compact(a) === compact(s))), ...added.filter(s => !removed.some(a => compact(a) === compact(s)))];
  if (compact(oldExports.join("")) !== compact(newExports.join("")) || changed.some(s => /^__all__\s*(?:=|\+=)/.test(s) || (path.endsWith("__init__.py") && /^(?:from\s+\S+\s+import\s+|import\s+)/.test(s)))) push("IMPORT_CHECK", path, "IMPORTS", "explicit_export_change");
  const shape = (s: string) => { const v = s.trim(); return v === "None" || !v ? "none" : /^[\[{]/.test(v) ? "container" : /,/.test(v) ? "tuple" : "scalar"; };
  const before = removed.map(s => s.match(/^\s*return\s*(.*)$/)).find(Boolean);
  const after = added.map(s => s.match(/^\s*return\s*(.*)$/)).find(Boolean);
  if (before && after && shape(before[1]!) !== shape(after[1]!)) push("CALLER_CHECK", path, "incoming CALLS", "return_shape_change", "weak");
  return signals;
}
