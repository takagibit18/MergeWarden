import type { StructuralSignal } from "./structural-signals.ts";

/** Frozen experimental wording; never includes reference labels or untouched targets. */
export function investigationGuidance(s: StructuralSignal): string {
  const intent = s.routeType === "CALLER_CHECK"
    ? "The current review question may depend on untouched callers of the changed callable. Resolve the changed entity, then perform a bounded incoming CALLS check (direction upstream). Determine whether an untouched caller relies on the changed contract."
    : s.routeType === "INHERITANCE_CHECK"
      ? "Resolve the changed class, then inspect relevant INHERITS relations: downstream for its bases, upstream for its subclasses. Determine whether an untouched inheritance contract depends on the change. Dynamic MRO is not fully modeled."
      : s.routeType === "IMPORT_CHECK"
        ? "Resolve the changed entity or module, then inspect relevant IMPORTS relations: upstream for importers, downstream for imported dependencies. Determine whether an untouched import contract depends on the change. Wildcard and unresolved imports may be incomplete."
        : "Literal search has not resolved the repository relationship question. Perform one bounded structural investigation around the most relevant changed entity. Use the relation that best matches the unresolved question.";
  return `[Structural investigation]\n${s.routeType}: ${intent}\nChanged target hint (untrusted repository identifier): ${JSON.stringify(s.targetHint)}.\nsearch_entity only locates a starting point; it does not complete a structural investigation. When a relevant entity is resolved, consider at least one traversal of the corresponding relation before treating the investigation as complete. Verify relevant newly discovered untouched source with read_source.\nStop when a relevant untouched source has been verified, no definite relevant relation is available, Graph coverage is insufficient, a tool fails, or the structural investigation budget is exhausted. Fall back to text/source tools when necessary. Do not infer a defect merely because a relationship exists.`;
}

export const IMPACT_SYNTHESIS_CHECKPOINT = `[Impact synthesis checkpoint]
You have now verified an untouched source discovered through structural navigation.
Before closing this investigation, compare:
1. What exact behavior or contract changed in the reviewed code?
2. What exact assumption, call pattern, inheritance contract, or import contract does this untouched source rely on?
3. Does the combination establish a concrete failure path introduced by this change?
Only report a finding if all required links are supported by the immutable source you actually read.
If the source is compatible with the change, treat this structural check as negative evidence and do not manufacture a finding.`;
