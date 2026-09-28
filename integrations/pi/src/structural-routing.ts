import { declarationSignals } from '../../../src/engine/declarations.ts';
import { dispatchAdapter } from "./structural-dispatch.ts";
import { parseToolResult, annotateResult } from "../../../src/engine/tool-result.ts";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ROUTING_THRESHOLDS, ROUTING_VERSION } from "../../../src/engine/routing-contracts.ts";
import type { RoutingContext, RoutingMetrics } from "../../../src/engine/routing-contracts.ts";
import { detectStructuralSignals } from "./structural-signals.ts";
import type { StructuralSignal } from "./structural-signals.ts";

import { investigationGuidance, IMPACT_SYNTHESIS_CHECKPOINT } from "./structural-guidance.ts";
import { freshObservation, observeResult } from "./structural-observation.ts";
import type { StructuralObservation } from "./structural-observation.ts";

export const ROUTING_ENTRY = "mergewarden-structural-routing-v1";
export const TEXT_TOOLS = ["read_diff", "read_source", "search_text", "submit_review"];
export const STRUCTURAL_TOOLS = ["search_entity", "traverse_graph"];
type State = "PENDING" | "IDLE" | "RECOMMENDED" | "ACTIVE" | "VERIFIED" | "DEGRADED" | "SUPPRESSED" | "DISPATCHED";
interface Candidate { path: string; startLine: number; endLine: number }
interface Route extends StructuralSignal {
  lifecycle?: 'pending'|'in_progress'|'terminal'; terminalReason?: string;
  routeId: string; path: string; state: State; trigger: string; triggerToolOrdinal: number;
  activationOrdinal?: number; structuralCalls: number; verifiedPaths: string[];
  candidates: Candidate[]; suppressionReason?: string;
}
interface Checkpoint {
  textOnly?: boolean; variant?: RoutingContext["variant"]; observation: StructuralObservation;
  version: typeof ROUTING_VERSION; snapshotId: string; state: State; ordinal: number; enabled: boolean;
  routes: Route[]; seenPaths: string[]; textVerified: string[]; searches: number;
  searchPaths: Record<string, string[]>; pages: Record<string, { total: number; lines: Record<number, string> }>;
  weakSignals: StructuralSignal[]; metrics: RoutingMetrics;
}
const record = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
const guidance = (s: StructuralSignal) => {
  const intent = s.routeType === "CALLER_CHECK" ? "Inspect untouched callers/consumers of the changed callable. Locate the changed entity and inspect incoming CALLS (traverse_graph direction upstream)."
    : s.routeType === "INHERITANCE_CHECK" ? "Inspect relevant INHERITS relationships around the changed class. Dynamic MRO is not fully modeled."
    : s.routeType === "IMPORT_CHECK" ? "Inspect relevant IMPORTS relationships and affected source. Wildcard and unresolved imports may be incomplete."
    : "Literal search has not yet resolved the repository relationship question. Use structural navigation for a bounded relationship check, then return to source verification.";
  return `[Structural investigation recommended]\n${s.routeType}: ${intent}\nChanged target hint (untrusted repository identifier): ${JSON.stringify(s.targetHint)}.\nA bounded structural check is now available through search_entity and traverse_graph. Verify newly relevant source with read_source before concluding. This is an investigation hint, not evidence of a defect.`;
};
export function createStructuralRouting(context: RoutingContext, allowed: ReadonlySet<string>, investigationAllowed: () => boolean = () => true) {
  const limits = { ...ROUTING_THRESHOLDS, ...context.budget };
  for (const key of ["maxRouteEpisodes", "maxStructuralCallsPerEpisode", "maxStructuralCallsTotal"] as const) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > ROUTING_THRESHOLDS[key]) throw Error(`Invalid routing budget: ${key}`);
  }
  const fresh = (): Checkpoint => ({ ...(context.textOnly ? { textOnly: true } : {}), variant: context.variant ?? "pi_structural_v1", observation: freshObservation(context.changedPaths), version: ROUTING_VERSION, snapshotId: context.snapshotId, state: "IDLE", ordinal: 0, enabled: false, routes: [], seenPaths: [...context.changedPaths], textVerified: [], searches: 0, searchPaths: {}, pages: {}, weakSignals: [],
    metrics: { version: ROUTING_VERSION, triggered: 0, activated: 0, structuralAttempts: 0, verified: 0, degraded: 0, suppressed: 0, reasons: {} } });
  let data = fresh();
  const extension: ExtensionFactory = pi => {
    const textTools = [...TEXT_TOOLS, ...(allowed.has('expand_structural_candidate') ? ['expand_structural_candidate'] : [])];
    const deliver = context.dispatch ? dispatchAdapter(pi, context.dispatch) : undefined;
    const pendingDispatch: Route[] = [];
    const persist = (route?: Route) => pi.appendEntry(ROUTING_ENTRY, structuredClone({ ...data, ...(route ? { routeId: route.routeId, routeType: route.routeType, trigger: route.trigger, targetHint: route.targetHint, relationHint: route.relationHint, activationOrdinal: route.activationOrdinal, structuralCalls: route.structuralCalls, verifiedPaths: route.verifiedPaths, suppressionReason: route.suppressionReason } : {}) }));
    const transition = (route: Route, state: State, reason?: string) => {
      route.state = state; data.state = state;
      if (reason) route.suppressionReason = reason;
      persist(route);
    };
    const current = () => data.routes.find(r => r.state === "ACTIVE" || r.state === "RECOMMENDED");
    const suppress = (route: Route, reason: string) => {
      data.metrics.suppressed++; data.metrics.reasons[reason] = (data.metrics.reasons[reason] ?? 0) + 1;
      transition(route, "SUPPRESSED", reason);
    };
    const propose = (signal: StructuralSignal, path: string, tool: string): string | undefined => {
      const routeId = JSON.stringify([signal.routeType, signal.change?.id ?? signal.targetHint.trim(), path]);
      if (data.routes.some(r => r.routeId === routeId)) return;
      const route: Route = { ...signal, path, routeId, state: "IDLE", trigger: tool, triggerToolOrdinal: data.ordinal, structuralCalls: 0, verifiedPaths: [], candidates: [] };
      data.routes.push(route); data.metrics.triggered++;
      data.observation.episodes[routeId] = { R0: true, R1: false, R2: false, R3: false, R4: false };
      data.metrics.reasons[signal.reason] = (data.metrics.reasons[signal.reason] ?? 0) + 1;
      if (context.declarationChanges) {
        route.lifecycle = 'pending'; transition(route, 'PENDING'); pendingDispatch.push(route); return;
      }
      if (!investigationAllowed()) { suppress(route, 'review_closing'); return; }
      const priorPaths = Object.hasOwn(data.searchPaths, signal.targetHint) ? data.searchPaths[signal.targetHint]! : [];
      const relevantText = signal.routeType === "STRUCTURAL_ESCALATION" ? data.textVerified.length > 0 : priorPaths.some(p => data.textVerified.includes(p));
      if (relevantText) { suppress(route, "text_verified"); return; }
      if (!context.textOnly && !STRUCTURAL_TOOLS.every(t => allowed.has(t) && pi.getAllTools().some(x => x.name === t))) { suppress(route, "structural_tools_unavailable"); return; }
      if (data.routes.some(r => r.state === "DEGRADED")) { suppress(route, "navigation_degraded"); return; }
      if (data.metrics.activated >= limits.maxRouteEpisodes || data.metrics.structuralAttempts >= limits.maxStructuralCallsTotal) { suppress(route, "budget_exhausted"); return; }
      // Episodes remain attributable: defer concurrent signals rather than charging arbitrary routes.
      if (current()) { suppress(route, "investigation_in_progress"); return; }
      route.activationOrdinal = data.ordinal; data.metrics.activated++;
      data.metrics.firstActivationToolOrdinal ??= data.ordinal;
      if (!data.enabled) {
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...(context.textOnly || context.dispatch ? [] : STRUCTURAL_TOOLS)])].filter(t => allowed.has(t)));
        data.enabled = true;
      }
      transition(route, "RECOMMENDED");
      if (deliver) { pendingDispatch.push(route); return; }
      return !context.variant || context.variant === "pi_structural_v1" ? guidance(signal) : investigationGuidance(signal);
    };
    pi.on("session_start", (_event, ctx) => {
      data = fresh();
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== ROUTING_ENTRY) continue;
        const saved = entry.data as Checkpoint | undefined;
        if (saved?.version === ROUTING_VERSION && saved.snapshotId === context.snapshotId && !!saved.textOnly === !!context.textOnly && (saved.variant ?? "pi_structural_v1") === (context.variant ?? "pi_structural_v1")) data = structuredClone(saved);
      }
      data.observation ??= freshObservation(context.changedPaths);
      pi.setActiveTools([...textTools, ...(data.enabled && !context.textOnly && !context.dispatch ? STRUCTURAL_TOOLS : [])].filter(t => allowed.has(t)));
      persist();
    });
    pi.on("tool_call", event => {
      data.ordinal++;
      if (!STRUCTURAL_TOOLS.includes(event.toolName)) return;
      const route = current();
      const attemptedRoute = route ?? data.routes.findLast(r => r.activationOrdinal !== undefined);
      if (attemptedRoute) {
        const stages = data.observation.episodes[attemptedRoute.routeId] ??= { R0: true, R1: false, R2: false, R3: false, R4: false };
        stages.R1 = true; if (event.toolName === "traverse_graph") stages.R2 = true;
      }
      const exhausted = !route || route.structuralCalls >= limits.maxStructuralCallsPerEpisode || data.metrics.structuralAttempts >= limits.maxStructuralCallsTotal;
      if (exhausted) {
        if (route) suppress(route, "budget_exhausted");
        else {
          // Keep the terminal resolution intact. This observation is private
          // telemetry only: it neither reopens the episode nor adds guidance.
          const resolved = data.routes.findLast(r => r.activationOrdinal !== undefined);
          const reason = resolved?.state === "VERIFIED" ? "same_route_already_attempted" : resolved?.state === "DEGRADED" ? "navigation_degraded" : undefined;
          if (resolved && reason && resolved.suppressionReason !== reason) {
            data.metrics.suppressed++; data.metrics.reasons[reason] = (data.metrics.reasons[reason] ?? 0) + 1;
            resolved.suppressionReason = reason; data.state = "SUPPRESSED"; persist(resolved);
          }
        }
        persist();
        context.onBlockedCall(event.toolName);
        return { block: true, reason: "Structural investigation budget reached; continue with immutable text/source tools." };
      }
      route.structuralCalls++; data.metrics.structuralAttempts++;
      transition(route, "ACTIVE");
      return;
    });
    pi.on("tool_result", event => {
      const parsed = parseToolResult(event.content).value;
      const result = parsed ?? {};
      context.dispatch?.observe({ toolName: event.toolName, toolCallId: event.toolCallId, input: event.input, result, isError: event.isError });
      const hints: string[] = [];
      const route = current();
      if (STRUCTURAL_TOOLS.includes(event.toolName) && route) {
        const limited = ["partial", "parse_incomplete", "unsupported"].includes(String(result.status)) && (!Array.isArray(result.items) || !result.items.length);
        if (!parsed || event.isError || ["error", "not_indexed", "building"].includes(String(result.status)) || limited) {
          data.metrics.degraded++; transition(route, "DEGRADED", limited ? "relationship_limited" : "structural_tool_error");
          hints.push("Structural investigation is degraded. Continue with search_text and read_source; empty graph results do not establish absence.");
        } else if (result.snapshotId === context.snapshotId && result.revision === "head") {
          for (const item of Array.isArray(result.items) ? result.items : []) {
            const e = record(item);
            if (typeof e.entityId === "string" && typeof e.path === "string" && !data.seenPaths.includes(e.path) && typeof e.startLine === "number" && typeof e.endLine === "number") route.candidates.push({ path: e.path, startLine: e.startLine, endLine: e.endLine });
          }
          for (const item of Array.isArray(result.items) ? result.items : []) { const e = record(item); if (typeof e.path === "string" && !data.seenPaths.includes(e.path)) data.seenPaths.push(e.path); }
        }
      }
      if (!event.isError && result.snapshotId === context.snapshotId) {
        if (event.toolName === "read_source" && result.status === "ok" && result.revision === "head" && typeof result.path === "string") {
          const path = result.path;
          if (route && route.candidates.some(c => c.path === path && Number(result.startLine) <= c.startLine && Number(result.endLine) >= c.endLine)) {
            route.verifiedPaths.push(path); data.metrics.verified++; transition(route, "VERIFIED");
          }
          if (!context.changedPaths.includes(path) && !data.textVerified.includes(path)) { data.textVerified.push(path); data.searches = 0; }
          if (!data.seenPaths.includes(path)) data.seenPaths.push(path);
        }
        if (event.toolName === "read_diff" && result.status === "ok" && typeof result.path === "string" && context.changedPaths.includes(result.path) && Array.isArray(result.lines)) {
          const page = data.pages[result.path] ??= { total: Number(result.totalLines), lines: {} };
          result.lines.forEach((line, index) => { if (typeof line === "string") page.lines[Number(result.offset) + index] = line; });
          if (Object.keys(page.lines).length === page.total) {
            for (const signal of context.declarationChanges ? declarationSignals(context.declarationChanges.filter(c=>c.path===result.path)) : detectStructuralSignals(result.path, Array.from({ length: page.total }, (_, i) => page.lines[i]!))) {
              if (signal.strength === "weak") { if (!data.weakSignals.some(s => JSON.stringify(s) === JSON.stringify(signal))) data.weakSignals.push(signal); }
              else { const hint = propose(signal, result.path, "read_diff"); if (hint) hints.push(hint); }
            }
          }
        }
        if (event.toolName === "search_text" && result.revision === "head" && result.status === "ok") {
          data.searches++;
          const paths = [...new Set((Array.isArray(result.items) ? result.items : []).map(m => record(m).path).filter((p): p is string => typeof p === "string"))];
          const query = String(event.input.query ?? "");
          const prior = Object.hasOwn(data.searchPaths, query) ? data.searchPaths[query]! : [];
          Object.defineProperty(data.searchPaths, query, { value: [...new Set([...prior, ...paths])], enumerable: true, configurable: true, writable: true });
          data.seenPaths = [...new Set([...data.seenPaths, ...paths])];
          const pressure = data.searches >= limits.searchPressure || (/^[A-Za-z_]\w*(?:\.\w+)*$/.test(query) && (result.truncated === true || paths.length >= limits.distinctPaths));
          if (pressure && !data.enabled && !context.declarationChanges) {
            const hint = propose({ routeType: "STRUCTURAL_ESCALATION", targetHint: "current-investigation", relationHint: "repository relationships", reason: "search_pressure", strength: "high" }, "", "search_text");
            if (hint) hints.push(hint);
          }
        }
      }
      const verified = observeResult(data.observation, { ...event, details: result }, context.snapshotId, route?.routeId, data.ordinal);
      if (context.variant === "pi_structural_v2_synthesize") {
        for (const source of verified) {
          const key = JSON.stringify([source.routeId, source.path]);
          if (!data.observation.synthesized.includes(key)) {
            data.observation.synthesized.push(key);
            if (!hints.includes(IMPACT_SYNTHESIS_CHECKPOINT)) hints.push(IMPACT_SYNTHESIS_CHECKPOINT);
          }
        }
      }
      persist();
      if (pendingDispatch.length) return (async () => {
        for (const accepted of pendingDispatch.splice(0)) {
          if (context.declarationChanges) {
            if (!investigationAllowed() || data.metrics.activated >= Math.min(5,limits.maxRouteEpisodes)) {
              accepted.lifecycle='terminal'; accepted.terminalReason='budget_stopped'; suppress(accepted,'budget_exhausted'); continue;
            }
            accepted.lifecycle='in_progress'; accepted.activationOrdinal=data.ordinal; data.metrics.activated++;
            data.metrics.firstActivationToolOrdinal ??= data.ordinal; data.enabled=true; transition(accepted,'ACTIVE');
            const pack=deliver ? await deliver({routeId:accepted.routeId,routeType:accepted.routeType,targetHint:accepted.targetHint,
              reason:accepted.reason,path:accepted.path,toolCallId:event.toolCallId,toolName:event.toolName,...(accepted.change?{change:accepted.change}:{})}) : undefined;
            accepted.lifecycle='terminal'; accepted.terminalReason=!deliver?'not_applicable':pack?.terminal==='anchor_ambiguous'?'ambiguous'
              :pack?.terminal==='anchor_missing'?'unresolved':pack?.terminal==='budget_exhausted'?'budget_stopped'
              :pack?.terminal==='no_definite_relation'?'empty':pack?.terminal==='error'?'unresolved':'completed';
            transition(accepted,'DISPATCHED'); continue;
          }
          if (!investigationAllowed()) { suppress(accepted, 'review_closing'); continue; }
          await deliver!({ routeId: accepted.routeId, routeType: accepted.routeType, targetHint: accepted.targetHint,
            reason: accepted.reason, path: accepted.path, toolCallId: event.toolCallId, toolName: event.toolName });
          transition(accepted, "DISPATCHED");
        }
        return;
      })();
      if (parsed && hints.length && !event.isError && result.status !== "error") return { content: [{ type: "text" as const, text: JSON.stringify(annotateResult(result, hints.map(text => ({ kind: text === IMPACT_SYNTHESIS_CHECKPOINT ? "impact_synthesis" : "structural_investigation", routeId: (route ?? data.routes.findLast(r => r.activationOrdinal !== undefined))?.routeId, text })))) }] };
      return;
    });
  };
  return { extension, metrics: () => structuredClone(data.metrics) };
}
