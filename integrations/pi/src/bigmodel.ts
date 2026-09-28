import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
/** Mainland standard API, not Coding Plan. Native Pi metadata only.
 * Published capabilities: https://docs.z.ai/guides/vlm/glm-5.3-flash
 * Effort levels: https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/README.md
 * Request limits chosen by a review belong in model-policy.ts, not this catalog.
 */
export const BIGMODEL: Parameters<ModelRuntime["registerProvider"]>[1] = {
    name: "智谱 BigModel", api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4/", authHeader: true,
    models: [{
      id: "glm-5.3-flash", name: "GLM-5.3-Flash (BigModel)", reasoning: true, input: ["text"],
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
      contextWindow: 1_000_000, maxTokens: 131_072,
      // Required SDK metadata only. MergeWarden reports tokens, never these unknown prices.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true,
        maxTokensField: "max_tokens", thinkingFormat: "zai", zaiToolStream: true },
    }],
};
