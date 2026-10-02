import { createHash } from "node:crypto";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { InferenceOptions } from "../../../src/engine/contracts.ts";
import { CATALOG_REVISION } from "./model-catalog.ts";

export const requestHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Select policy through Pi's public capability API; no provider-specific branches. */
export function resolveModelPolicy(catalogModel: Model<Api>, requested: InferenceOptions = {}) {
  const supported = getSupportedThinkingLevels(catalogModel);
  const thinkingLevel = requested.thinkingLevel ?? (catalogModel.reasoning ? (supported.includes("low") ? "low" : supported.find(level => level !== "off")) : "off");
  if (!thinkingLevel || !supported.includes(thinkingLevel)) throw Error(`Unsupported thinking level: ${requested.thinkingLevel}; supported: ${supported.join(", ")}`);
  const limit = (value: number | undefined, fallback: number, ceiling: number, name: string) => {
    const selected = value ?? Math.min(fallback, ceiling);
    if (!Number.isSafeInteger(selected) || selected <= 0 || selected > ceiling) throw Error(`Invalid ${name}; model limit is ${ceiling}`);
    return selected;
  };
  const contextWindow = limit(requested.contextWindow, 65_536, catalogModel.contextWindow, "context window");
  const maxOutputTokens = limit(requested.maxOutputTokens, 8_192, Math.min(catalogModel.maxTokens, contextWindow), "output budget");
  for (const [name, value, maximum] of [["temperature", requested.temperature, 2], ["topP", requested.topP, 1]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > maximum || (name === "topP" && value === 0))) throw Error(`Invalid ${name}`);
  }
  const hasSampling = requested.temperature !== undefined || requested.topP !== undefined;
  // Pi documents samplingParams for these protocols only. Reject instead of
  // claiming a sampling override took effect on a protocol that ignores it.
  if (hasSampling && !["openai-completions", "openai-responses", "azure-openai-responses"].includes(catalogModel.api)) throw Error("Sampling overrides are not supported by this Pi API");
  const resolved = { thinkingLevel, contextWindow, maxOutputTokens,
    ...(requested.temperature !== undefined ? { temperature: requested.temperature } : {}),
    ...(requested.topP !== undefined ? { topP: requested.topP } : {}) };
  const model = { ...catalogModel, contextWindow, maxTokens: maxOutputTokens,
    ...(hasSampling ? { samplingParams: { ...catalogModel.samplingParams,
      ...(requested.temperature !== undefined ? { temperature: requested.temperature } : {}),
      ...(requested.topP !== undefined ? { top_p: requested.topP } : {}) } } : {}) };
  return { model, thinkingLevel, configuration: { catalogRevision: CATALOG_REVISION, modelSha256: requestHash(catalogModel),
    requested: structuredClone(requested), resolved,
    capabilities: { contextWindow: catalogModel.contextWindow, maxOutputTokens: catalogModel.maxTokens } } };
}
