export type RoutingMode = "none" | "pi_structural_v1" | "pi_structural_v2_investigate" | "pi_structural_v2_synthesize";
export interface RoutingBudget { maxRouteEpisodes: number; maxStructuralCallsPerEpisode: number; maxStructuralCallsTotal: number }
export const ROUTING_VERSION = "pi-structural-routing-1" as const;
export const ROUTING_THRESHOLDS = Object.freeze({ searchPressure: 3, distinctPaths: 8,
  maxRouteEpisodes: 2, maxStructuralCallsPerEpisode: 4, maxStructuralCallsTotal: 6 });
export interface RoutingMetrics {
  version: typeof ROUTING_VERSION; triggered: number; activated: number; structuralAttempts: number;
  verified: number; degraded: number; suppressed: number; reasons: Record<string, number>;
  firstActivationToolOrdinal?: number;
}
export interface RoutingContext {
  declarationChanges?: import('./declarations.ts').DeclarationChange[];
  dispatch?: import("./dispatch-contracts.ts").DispatchBridge | import("./investigation-service.ts").ProgressiveInvestigation;
  variant?: Exclude<RoutingMode, "none">;
  /** Internal capability ablation: identical guidance, no structural tool exposure. */
  textOnly?: boolean;
  snapshotId: string; changedPaths: string[]; budget?: Partial<RoutingBudget>;
  /** Hook rejections still pass through the engine's admission/accounting boundary. */
  onBlockedCall(name: string): void;
}
