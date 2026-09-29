import type { SessionJournal } from "../ports/journal.ts";
import type { FindingCandidate, ReviewReport } from "../domain/contracts.ts";
import type { ReviewInput } from "../snapshot/contracts.ts";
export interface ModelSelection { provider: string; modelId: string }
/** Run policy, not provider wire fields. Interpretation belongs to the Pi adapter. */
export interface InferenceOptions {
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  maxOutputTokens?: number;
  contextWindow?: number;
  temperature?: number;
  topP?: number;
}
export interface ReviewOptions {
  skills?: 'auto' | 'off' | 'replay'; learn?: 'auto' | 'off';
  /** Host-controlled mapping only: never inferred from origin or reviewed configuration. */
  skillRepositoryKey?: string;
  repositoryPath: string; stateDir: string; input?: ReviewInput; rerunId?: string;
  model: ModelSelection; inference?: InferenceOptions; timeoutMs?: number; maxToolCalls?: number; signal?: AbortSignal;
  /** Internal ablation only; never exposed as a product mode. */
  evaluation?: { contextCwd?: string; declarationAware?: boolean; executionStrategy?: import("./dispatch-contracts.ts").ExecutionStrategy; tools: "text-only" | "text+graph" | "text+locagent"; graphMode?: "lazy" | "prepared_only"; retrieval?: import("../experiments/locagent/contracts.ts").RetrievalConfig; routing?: import("./routing-contracts.ts").RoutingMode; routingBudget?: Partial<import("./routing-contracts.ts").RoutingBudget>; routingTextOnly?: boolean };
}
export interface RuntimeTool { name: string; description: string; schema: Record<string, unknown>; execute(input: unknown): Promise<unknown> }
export interface ReviewRuntime {
  journal: SessionJournal;
  prompt(text: string, signal: AbortSignal): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  usage(): { input: number; output: number; total: number };
  routingMetrics?(): import("./routing-contracts.ts").RoutingMetrics;
  configuration?(): { systemPrompt: string; thinkingLevel: string; modelApi: string; modelBaseUrl: string; modelMaxTokens: number;
    authentication?: { type: "api_key" | "oauth" };
    inference?: { catalogRevision: string; modelSha256: string; requested: InferenceOptions; resolved: InferenceOptions; capabilities: { contextWindow: number; maxOutputTokens: number }; requestCount: number; lastRequestSha256?: string } };
}
export type RuntimeFactory = (options: { repositoryPath: string; runDir: string; stateDir: string; model: ModelSelection; inference?: InferenceOptions; tools: RuntimeTool[]; skillsEnabled?: boolean; contextCwd?: string; evaluation?: boolean; budgetState?(): import('./budget.ts').BudgetState; routing?: import("./routing-contracts.ts").RoutingContext }) => Promise<ReviewRuntime>;
export interface FinalSubmission { summary: string; reviewedPaths: string[]; findings: FindingCandidate[] }
/** Model transport; normalization produces the unchanged self-contained domain contract. */
export interface FinalSubmissionInput { summary: string; reviewedPaths: string[]; findings: import("../application/evidence-registry.ts").FindingInput[] }
export interface RunManifest {
  skills?: import('../skills/contracts.ts').SkillBinding;
  learningPolicy?: 'auto' | 'off';
  schemaVersion: 1; runId: string; snapshotId: string; repositoryPath: string; model: ModelSelection;
  configurationFingerprint: string; limits: { timeoutMs: number; maxToolCalls: number };
  /** Run-level policy identity; historical snapshots and reports remain immutable. */
  reviewPolicy?: { version: string; sha256: string };
  status: "running" | "delivered" | "delivery_failed"; createdAt: string; finishedAt?: string;
  parentRunId?: string; outcome?: ReviewReport["status"]; error?: string;
  termination?: { reason: 'completed' | 'tool_budget' | 'time_budget' | 'cancelled' | 'runtime_error' | 'incomplete'; finalSubmission: boolean };
  reportSha256?: string; markdownSha256?: string; usage?: { input: number; output: number; total: number };
  metrics?: {
    /** Executed is kept as toolCalls for backwards-compatible experiment summaries. */
    toolCalls: number; toolRequests: number; toolAccepted: number; toolExecuted: number; toolRejected: number;
    graphToolCalls: number; reviewLatencyMs: number; graph: import("../graph/lazy-graph.ts").LazyCodeGraph["metrics"];
    budget?: import('./budget.ts').BudgetState;
    dispatch?: import("./dispatch-service.ts").StructuralDispatch["metrics"] & { operations: { requested: number; accepted: number; executed: number; rejected: number }; graphBackendRequests: number; sourceReadOperations: number };
    navigation: { attempted: boolean; degraded: boolean; errors: number };
    routing?: import("./routing-contracts.ts").RoutingMetrics;
  };
  toolExposure?: "text-only" | "text+graph" | "text+locagent";
  runtimeConfiguration?: ReturnType<NonNullable<ReviewRuntime["configuration"]>>;
}
export type ReviewResult = { kind: "no_changes"; snapshotId: string } | { kind: "report"; runId: string; report: ReviewReport; reportPath: string; markdownPath: string; learning?: {status:string; jobs?:import('../skills/contracts.ts').LearningJob[]} };
export type ReviewProgress = { phase: "preparing" | "reviewing" | "tool" | "delivering"; runId?: string; tool?: string; toolCalls?: number };
