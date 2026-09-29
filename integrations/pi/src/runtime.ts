import { SKILL_RULES } from '../../../src/skills/context.ts';
import { INVESTIGATION_EVENT } from '../../../src/engine/investigation-contracts.ts';
import { DISPATCH_EVENT } from "../../../src/engine/dispatch-service.ts";
import { annotateResult, isObject } from "../../../src/engine/tool-result.ts";
import { closeSync, openSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { lstat } from "node:fs/promises";
import type { TSchema } from "typebox";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isolatedState } from "../../../src/infrastructure/files.ts";
import { initializeProviderNetwork } from "./network.ts";
import { reviewResources } from './review-resources.ts';
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { RuntimeFactory } from "../../../src/engine/contracts.ts";
import { createReviewExtension } from "./extension.ts";
import { createBudgetExtension } from './budget-extension.ts';
import { createStructuralRouting, TEXT_TOOLS, STRUCTURAL_TOOLS } from "./structural-routing.ts";
import { modelCatalogOptions } from "./model-catalog.ts";
import { resolveModelPolicy, requestHash } from "./model-policy.ts";
import { PiSessionJournal } from "./journal.ts";
import { BASE_SYSTEM_PROMPT, GRAPH_CAPABILITY_PROMPT, NAVIGATION_POLICY_PROMPT } from "../../../src/engine/prompt.ts";
import { LOCAGENT_CAPABILITY_PROMPT } from "../../../src/experiments/locagent/contracts.ts";
export async function createModelRuntime(provider?: string, key?: string): Promise<ModelRuntime> {
  initializeProviderNetwork();
  const runtime = await ModelRuntime.create({ ...modelCatalogOptions(),
    credentials: {
      async read(id) { return id === provider && key ? { type: "api_key", key } : undefined; },
      async list() { return provider && key ? [{ providerId: provider, type: "api_key" }] : []; },
      async modify() { throw new Error("Credential writes and OAuth are disabled"); }, async delete() { throw new Error("Credential writes are disabled"); },
    } });
  if (runtime.getError()) throw Error('Invalid application model catalog');
  return runtime;
}
export async function listModels(provider?: string): Promise<{ provider: string; id: string; name: string }[]> {
  const runtime = await createModelRuntime();
  return runtime.getModels(provider).map(m => ({ provider: m.provider, id: m.id, name: m.name }));
}
export type PiAuthentication = string | { type: "oauth"; authPath: string };
/** Pi owns the credential store, file lock, OAuth flow and token refresh. */
export async function createOAuthModelRuntime(provider: string, authPath: string, requireLogin = true): Promise<ModelRuntime> {
  initializeProviderNetwork();
  if (!isAbsolute(authPath)) throw Error("OAuth credential path must be absolute");
  try {
    const stat = await lstat(authPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Invalid credential file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Error("Cannot read the OAuth credential file");
  }
  const runtime = await ModelRuntime.create({ authPath, ...modelCatalogOptions() });
  if (runtime.getError()) throw Error('Invalid application model catalog');
  if (!runtime.getProvider(provider)?.auth.oauth) throw Error("Selected provider does not support Pi OAuth login");
  let credential;
  // A signal makes Pi propagate storage errors instead of serving a stale cache.
  try { credential = (await runtime.listCredentials({ signal: AbortSignal.timeout(30_000) })).find(c => c.providerId === provider); }
  catch { throw Error("Cannot read the OAuth credential file"); }
  if (credential && credential.type !== "oauth") throw Error("OAuth mode requires an OAuth credential; API-key fallback is disabled");
  if (requireLogin && !credential) throw Error("OAuth login missing; run login with the same --provider and --state first");
  return runtime;
}
export function createPiRuntimeFactory(authentication: PiAuthentication): RuntimeFactory {
  if (typeof authentication === "string" && !authentication.trim()) throw new Error("The explicitly selected API key environment variable is empty");
  return async options => {
    const oauth = typeof authentication !== "string";
    if (oauth) await isolatedState(dirname(authentication.authPath), options.repositoryPath);
    const runtime = oauth ? await createOAuthModelRuntime(options.model.provider, authentication.authPath)
      : await createModelRuntime(options.model.provider, authentication);
    if (oauth) {
      try { if (!await runtime.getAuth(options.model.provider, { signal: AbortSignal.timeout(30_000) })) throw Error("Missing auth"); }
      catch { throw Error("OAuth authentication or refresh failed; check connectivity or run login again"); }
    } else {
      const auth = await runtime.getAuth(options.model.provider, { apiKey: authentication });
      if (auth?.auth.apiKey !== authentication) throw new Error("This provider requires configuration beyond the MVP API-key interface");
    }
    const review = await createPiRuntime(options, runtime), configuration = review.configuration!;
    return { ...review, configuration: () => ({ ...configuration(), authentication: { type: oauth ? "oauth" as const : "api_key" as const } }) };
  };
}
/** Injecting a runtime allows offline SDK integration tests without changing the production loop. */
export async function createPiRuntime(options: Parameters<RuntimeFactory>[0], modelRuntime: ModelRuntime,
  evaluation?: { extensions: ExtensionFactory[]; firstAttemptOnly: boolean; preserveRouting?: boolean; onExtensionError?(error: unknown): void }): ReturnType<RuntimeFactory> {
  if (evaluation && !options.evaluation) throw Error('Runtime overrides require explicit internal evaluation');
  const catalogModel = modelRuntime.getModel(options.model.provider, options.model.modelId);
  if (!catalogModel) throw new Error("Configured provider/model is not in the configured review catalog; no fallback is allowed");
  const policy = resolveModelPolicy(catalogModel, options.inference);
  const { model, thinkingLevel } = policy;
  let requestCount = 0, lastRequestSha256: string | undefined;
  let recordRequest: (payload: unknown) => void = () => { throw Error("Request journal is not ready"); };
  const audit: ExtensionFactory = pi => { pi.on("before_provider_request", event => { recordRequest(event.payload); }); };
  const settingsManager = SettingsManager.inMemory(evaluation?.firstAttemptOnly ? {
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 180_000 } },
    compaction: { enabled: false },
  } : undefined);
  // Review never authorizes project resource discovery.
  settingsManager.setProjectTrusted(false);
  const allowlist = new Set(options.tools.map(t => t.name));
  const routing = options.routing && (!evaluation || evaluation.preserveRouting) ? createStructuralRouting(options.routing, allowlist,
    () => !['closing','submitted'].includes(options.budgetState?.().phase ?? 'investigating')) : undefined;
  const structuralCapability = routing ? undefined : allowlist.has("graph_lookup") ? GRAPH_CAPABILITY_PROMPT : allowlist.has("search_entity") || allowlist.has("traverse_graph") ? LOCAGENT_CAPABILITY_PROMPT : undefined;
  const resourceLoader = await reviewResources({ cwd: options.runDir,
    systemPrompt: BASE_SYSTEM_PROMPT + (options.skillsEnabled ? "\n" + SKILL_RULES : "") + (options.routing?.declarationChanges || options.routing?.dispatch && "version" in options.routing.dispatch ? "\nRepository navigation context: Host packages are investigation context, not findings. Catalogs and declaration previews are exploration only. Inspect prefetched source first; use expand_structural_candidate if the question remains unanswered. Depend only on actual source evidence and explicitly select its EvidenceRef. Stop when sufficient evidence exists; do not read every candidate by default." : options.routing?.dispatch ? "\nRepository navigation context: the host executes bounded structural retrieval after existing rules trigger. Native host_dispatch context packages contain immutable source; explicitly select their evidenceRefId when a finding depends on it. Execution completion and candidate ordering are not semantic conclusions." : "") + (structuralCapability ? "\n" + NAVIGATION_POLICY_PROMPT + "\n" + structuralCapability : ""),
    extensionFactories: [createReviewExtension(allowlist), ...(routing ? [routing.extension] : []), ...(options.budgetState ? [createBudgetExtension(options.budgetState)] : []), ...(evaluation?.extensions ?? []), audit] });
  await resourceLoader.reload();
  // Opening an exclusively created empty file sets Pi's flushed state via its public API.
  // No synthetic assistant message, SDK patch, or second conversation log is needed.
  const file = join(options.runDir, "session.jsonl"); closeSync(openSync(file, "wx", 0o600));
  const manager = SessionManager.open(file, options.runDir, options.repositoryPath);
  // Pi appends cwd to custom prompts. A/B runs use the same isolated state cwd so
  // random run IDs cannot silently change the system prompt between arms.
  const result = await createAgentSession({ cwd: options.evaluation ? options.contextCwd ?? options.stateDir : options.runDir, agentDir: options.runDir, modelRuntime, model, thinkingLevel,
    sessionManager: manager, settingsManager, resourceLoader, noTools: "builtin", tools: [...allowlist],
    customTools: options.tools.map(t => ({ name: t.name, label: t.name, description: t.description, parameters: t.schema as TSchema, executionMode: "sequential" as const,
      async execute(_id, params) { if (!allowlist.has(t.name)) throw Error("Tool is outside the immutable review allowlist"); const value = await t.execute(params); return { content: [{ type: "text" as const, text: JSON.stringify(isObject(value) ? annotateResult(value) : value) }], details: value }; } })) });
  const session = result.session;
  const journal = new PiSessionJournal(manager, { durable: true, onFailure: () => { void session.abort().catch(() => undefined); } });
  recordRequest = payload => {
    journal.checkpoint();
    const sha256 = requestHash(payload);
    // Observe Pi's final request without translating it or duplicating source,
    // tool histories, credentials or headers in a second conversation log.
    const fields = ["model", "max_tokens", "max_completion_tokens", "temperature", "top_p", "reasoning_effort", "thinking", "reasoning", "tool_stream", "stream"];
    const parameters = isObject(payload) ? Object.fromEntries(fields.filter(key => Object.hasOwn(payload, key)).map(key => [key, payload[key]])) : {};
    manager.appendCustomEntry("mergewarden.provider-request.v1", { ordinal: requestCount + 1, sha256, parameters,
      catalogRevision: policy.configuration.catalogRevision, modelSha256: policy.configuration.modelSha256 });
    journal.checkpoint();
    requestCount++; lastRequestSha256 = sha256;
  };
  options.routing?.dispatch?.setRecorder(event => { journal.checkpoint(); manager.appendCustomEntry(event.version === 'structural-dispatch-2' ? INVESTIGATION_EVENT : DISPATCH_EVENT, structuredClone(event)); journal.checkpoint(); });
  try {
    if (result.extensionsResult.errors.length) throw new Error("Review extension failed to initialize");
    await session.bindExtensions({ onError: error => { evaluation?.onExtensionError?.(error); void session.abort().catch(() => undefined); } });
    const active = session.getActiveToolNames();
    if (routing) {
      if (active.some(t => !allowlist.has(t)) || TEXT_TOOLS.some(t => !active.includes(t)) || STRUCTURAL_TOOLS.some(t => active.includes(t)) || session.getAllTools().some(t => !allowlist.has(t.name))) throw Error("Unexpected routing tool set");
    } else if (JSON.stringify(active.sort()) !== JSON.stringify([...allowlist].sort())) throw new Error("Unexpected active tool set");
    journal.checkpoint();
  } catch (error) { session.dispose(); throw error; }
  // Registered after AgentSession's awaited listener: native append has completed here.
  const unsubscribe = session.agent.subscribe(event => { if (event.type === "message_end" || event.type === "agent_end") journal.checkpoint(); });
  return { journal,
    ...(routing ? { routingMetrics: routing.metrics } : {}),
    configuration() { return { systemPrompt: session.systemPrompt, thinkingLevel: session.thinkingLevel, modelApi: model.api, modelBaseUrl: model.baseUrl, modelMaxTokens: model.maxTokens,
      inference: { ...structuredClone(policy.configuration), requestCount, ...(lastRequestSha256 ? { lastRequestSha256 } : {}) } }; },
    async prompt(text, signal) {
      signal.throwIfAborted();
      let rejectAbort: (() => void) | undefined;
      const stop = () => { void session.abort().catch(() => undefined); rejectAbort?.(); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        const prompting = session.prompt(text, { expandPromptTemplates: false });
        void prompting.catch(() => undefined);
        const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(signal.reason ?? new Error("Review cancelled")); });
        await Promise.race([prompting, cancelled]);
        signal.throwIfAborted();
        const last = [...session.messages].reverse().find(m => m.role === "assistant");
        if (!last || last.stopReason === "error" || last.stopReason === "aborted" || last.stopReason === "length") throw new Error("Model did not finish normally");
      } finally { signal.removeEventListener("abort", stop); journal.checkpoint(); }
    },
    abort: () => session.abort(), dispose() { unsubscribe(); session.dispose(); },
    usage() { const t = session.getSessionStats().tokens; return { input: t.input + t.cacheRead + t.cacheWrite, output: t.output, total: t.total }; },
  };
}
