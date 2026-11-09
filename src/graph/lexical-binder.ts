import type { BindingFact, Resolution, ScopeFact, SourceFact, SyntaxFacts } from "./contracts.ts";

/** A resolution outcome: zero or more targets, a rule class and the rule that produced it. */
export interface Target { ids: string[]; resolution: Resolution; ruleSource: string }
export const unresolved = (ruleSource = "unresolved_static_binding"): Target => ({ ids: [], resolution: "unresolved", ruleSource });

/**
 * Language-neutral lexical lookup over ScopeFact/BindingFact (ADR 0022 seam 2). Languages differ only
 * in the facts their extractor emits (which scopes exist, which bindings are conditional or hoisted)
 * and in how a found binding is followed (`follow`). Unknown or shadowing bindings stop the lookup:
 * the binder never guesses a target.
 */
export class LexicalBinder {
  private readonly scopes = new Map<string, ScopeFact>();
  private readonly bindings = new Map<string, BindingFact[]>();
  private readonly incomplete = new Set<string>();

  index(fact: SyntaxFacts): void {
    for (const scope of fact.scopes) { this.scopes.set(scope.id, scope); if (!fact.parseComplete) this.incomplete.add(scope.id); }
    for (const binding of fact.bindings) { const key = `${binding.scopeId}:${binding.name}`; this.bindings.set(key, [...this.bindings.get(key) ?? [], binding]); }
  }

  scope(id: string): ScopeFact | undefined { return this.scopes.get(id); }
  /** Bindings of a name declared directly in a scope (no lookup). */
  bindingsIn(scopeId: string, name: string): BindingFact[] | undefined { return this.bindings.get(`${scopeId}:${name}`); }

  /** Several or conditional bindings make a candidate; any unknown binding makes the name unresolved. */
  combine(candidates: BindingFact[], follow: (binding: BindingFact) => Target): Target {
    if (!candidates.length || candidates.some(binding => binding.kind === "unknown")) return unresolved("shadowed_or_reassigned");
    const targets = candidates.map(follow); const ids = [...new Set(targets.flatMap(target => target.ids))];
    if (!ids.length) return unresolved(targets[0]?.ruleSource ?? "binding_target_missing");
    const ambiguousBinding = candidates.length !== 1 || candidates.some(binding => binding.conditional);
    const candidate = ambiguousBinding || targets.some(target => target.resolution === "candidate" || !target.ids.length);
    // One unconditional binding to an ambiguous target keeps the target's own rule (e.g. ambiguous_star_reexport).
    return { ids, resolution: candidate ? "candidate" : targets[0]!.resolution, ruleSource: ambiguousBinding ? "ambiguous_or_conditional_binding" : targets[0]!.ruleSource };
  }

  /**
   * Walk lookup parents from `scopeStart`. In the starting scope a binding that appears after the use
   * is invisible unless the language hoists it (function declarations, imports).
   */
  lookup(name: string, scopeStart: string, at: Pick<SourceFact, "startLine" | "startColumn">, follow: (binding: BindingFact) => Target): Target {
    if (this.incomplete.has(scopeStart)) return unresolved("parse_incomplete");
    let scopeId: string | undefined = scopeStart;
    while (scopeId) {
      const scope = this.scopes.get(scopeId); if (!scope || scope.opaque) return unresolved("opaque_scope");
      const candidates = this.bindings.get(`${scopeId}:${name}`);
      if (candidates) {
        if (scopeId === scopeStart && candidates.some(binding => !binding.hoisted && (binding.startLine > at.startLine || (binding.startLine === at.startLine && binding.startColumn > at.startColumn)))) return unresolved("binding_used_before_definition");
        return this.combine(candidates, follow);
      }
      scopeId = scope.lookupParentId;
    }
    return unresolved();
  }
}
