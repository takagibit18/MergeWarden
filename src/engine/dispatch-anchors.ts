import type { AnchorHint, DispatchObservation, DispatchTrigger } from "./dispatch-contracts.ts";
import { DISPATCH_LIMITS } from "./dispatch-contracts.ts";

/** Supplement observations only; this never decides whether a route fires. */
export class ObservedAnchors {
  limited = false;
  private changed: Set<string>;
  private recent: AnchorHint[] = [];
  private ranges = new Map<string, AnchorHint[]>();
  private pages = new Map<string, Map<number, string>>();
  constructor(changedPaths: string[]) { this.changed = new Set(changedPaths); }
  observe({ toolName, result: r }: DispatchObservation) {
    if (r.status !== "ok" || typeof r.path !== "string" && toolName !== "search_text") return;
    const path = String(r.path);
    if (toolName === "read_diff" && this.changed.has(path) && Array.isArray(r.lines)) {
      const page = this.pages.get(path) ?? new Map<number, string>(); this.pages.set(path, page);
      r.lines.forEach((line, i) => { if (typeof line === "string") page.set(Number(r.offset) + i, line); });
      if (page.size !== r.totalLines) return;
      const anchors: AnchorHint[] = []; let line = 0;
      for (let i = 0; i < page.size; i++) {
        const value = page.get(i)!; const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(value);
        if (hunk) { line = Number(hunk[1]); continue; }
        if (!line || /^(diff |index |---|\+\+\+|\\)/.test(value)) continue;
        if (value.startsWith("+")) anchors.push({ path, startLine: line, endLine: line });
        if (value.startsWith("+") || value.startsWith(" ")) line++;
      }
      this.ranges.set(path, anchors); this.recent = anchors;
    }
    if (toolName === "read_source" && r.revision === "head" && this.changed.has(path)) {
      const changedInside = (this.ranges.get(path) ?? []).filter(h => h.startLine! >= Number(r.startLine) && h.endLine! <= Number(r.endLine));
      this.recent = changedInside.length ? changedInside : [{ path, startLine: Number(r.startLine), endLine: Number(r.endLine) }];
    }
    if (toolName === "search_text" && r.revision === "head" && Array.isArray(r.items)) {
      const matches = r.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
      const observed = matches.filter(x => this.changed.has(String(x.path)) && Number.isInteger(x.line)).map(x => ({ path: String(x.path), startLine: Number(x.line), endLine: Number(x.line) }));
      if (observed.length) this.recent = observed;
    }
  }
  complete(trigger: DispatchTrigger): AnchorHint[] {
    this.limited = false;
    const bounded = (hints: AnchorHint[]) => {
      if (hints.length > DISPATCH_LIMITS.maxAnchorHints) { this.limited = true; return []; }
      return hints;
    };
    if (trigger.reason === "callable_removal") return [];
    if (trigger.routeType === "IMPORT_CHECK") return [{ path: trigger.path, kind: "file" }];
    if (trigger.routeType === "STRUCTURAL_ESCALATION") return bounded(structuredClone(this.recent));
    const kind = trigger.routeType === "CALLER_CHECK" ? "function" as const : "class" as const;
    const ranges = this.ranges.get(trigger.path) ?? [];
    return bounded((ranges.length ? ranges : [{ path: trigger.path }]).map(r => ({ ...r, kind, name: trigger.targetHint })));
  }
}
