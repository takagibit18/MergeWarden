import { TypeScriptResolver, TYPESCRIPT_RESOLVER_VERSION } from "../typescript-resolver.ts";
import type { SpecifierResolver } from "../typescript-resolver.ts";
import type { FileClass, LanguageDescriptor, ResolverContext } from "./contracts.ts";

/**
 * TypeScript pack (ADR 0022): .ts/.tsx/.mts/.cts sources. Declaration files (.d.ts) describe types
 * only and are not owned. JavaScript is a later dialect of this pack, not a separate language.
 */
export const TYPESCRIPT_PARSER_VERSION = "web-tree-sitter-0.27.0/typescript-0.23.2-abi14+tsx";
export const TYPESCRIPT_POLICY_VERSION = "typescript-entity-core-1";
const SOURCE = /\.(ts|tsx|mts|cts)$/;
const DECLARATION = /\.d\.(ts|mts|cts)$/;
export const typescriptModuleName = (path: string) => path.replace(SOURCE, "");

const segment = (segments: string[], names: string[]) => segments.some(item => names.includes(item));
/** Auditable path-component rules, mirroring the Python policy; substrings never classify. */
export function classifyTypeScriptPath(path: string): FileClass {
  const normalized = path.replaceAll("\\", "/").toLowerCase(); const segments = normalized.split("/"); const file = segments.at(-1)!; const directories = segments.slice(0, -1);
  if (segment(segments, ["node_modules", "vendor", "vendored", "third_party", "third-party"])) return "vendor";
  if (segment(directories, ["generated", "__generated__", "gen"]) || /\.(generated|gen|pb)\.(ts|tsx|mts|cts)$/.test(file)) return "generated";
  if (segment(directories, ["test", "tests", "__tests__", "__mocks__", "spec", "e2e"]) || /\.(test|spec)\.(ts|tsx|mts|cts)$/.test(file)) return "test";
  if (segment(directories, ["example", "examples", "demo", "demos"]) || /\.stories\.(ts|tsx)$/.test(file)) return "example";
  if (segment(directories, ["bench", "benchmark", "benchmarks"]) || /\.bench\.(ts|tsx|mts|cts)$/.test(file)) return "benchmark";
  return "production";
}

/** Snapshot-only relative resolution, used when TypeScript's module resolution is unavailable. */
export function relativeCandidates(specifier: string, fromPath: string): string[] {
  if (!specifier.startsWith("./") && !specifier.startsWith("../") && specifier !== "." && specifier !== "..") return [];
  const parts = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) { if (part === "..") { if (!parts.length) return []; parts.pop(); } else if (part && part !== ".") parts.push(part); }
  const base = parts.join("/"); const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  return [...new Set([...(SOURCE.test(base) ? [base] : []), `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${stem}/index.ts`, `${stem}/index.tsx`])].filter(path => !DECLARATION.test(path));
}

export const typescript: LanguageDescriptor = {
  id: "typescript", displayName: "TypeScript",
  versions: { parser: TYPESCRIPT_PARSER_VERSION, resolver: TYPESCRIPT_RESOLVER_VERSION, policy: TYPESCRIPT_POLICY_VERSION },
  capabilities: { relations: ["CONTAINS", "IMPORTS", "CALLS", "INHERITS"], declarations: true, receiverNavigation: true },
  owns: path => SOURCE.test(path) && !DECLARATION.test(path),
  classify: classifyTypeScriptPath,
  moduleName: typescriptModuleName,
  importTarget(importerPath, item) { return { module: item.module, files: relativeCandidates(item.module, importerPath), ...(item.importedName ? { importedName: item.importedName } : {}) }; },
  async createResolver(context: ResolverContext) {
    let resolve: SpecifierResolver;
    try {
      const adapter = await import(new URL("../../../integrations/tree-sitter/src/typescript-modules.ts", import.meta.url).href) as { createSpecifierResolver(context: ResolverContext): Promise<SpecifierResolver> };
      resolve = await adapter.createSpecifierResolver(context);
    } catch {
      const paths = new Set(context.paths); resolve = (specifier, fromPath) => relativeCandidates(specifier, fromPath).find(path => paths.has(path));
    }
    return new TypeScriptResolver(context.snapshotId, resolve, typescriptModuleName);
  },
  extractor: { module: "../../../integrations/tree-sitter/src/typescript-extractor.ts", export: "TypeScriptTreeSitterExtractor" },
};
