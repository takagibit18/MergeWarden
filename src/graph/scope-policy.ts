import type { FrozenFile } from "../snapshot/contracts.ts";
export type PythonFileClass = "production" | "test" | "example" | "benchmark" | "generated" | "vendor";
export type GraphScope = "core" | "all";
export interface PythonCatalogEntry {
  path: string; classification: PythonFileClass; changed: boolean; included: boolean;
  layer: "changed" | "production" | "supplemental"; status: FrozenFile["status"];
}
export const FILE_SCOPE_POLICY_VERSION = "python-core-scope-2";
export function pythonModuleName(path: string): string { return path.replace(/\.py$/, "").replace(/\/__init__$/, "").replaceAll("/", "."); }
const exactSegment = (segments: string[], names: string[]) => segments.some(segment => names.includes(segment));
/** Auditable path-component rules; a substring such as contest.py is not a test classification. */
export function classifyPythonPath(path: string): PythonFileClass {
  const normalized = path.replaceAll("\\", "/").toLowerCase(); const segments = normalized.split("/"); const file = segments.at(-1)!;
  if (exactSegment(segments, ["vendor", "vendored", "third_party", "third-party", "site-packages"])) return "vendor";
  // SymPy declares this exact tree as automatically generated in every file
  // header. Keep the exception narrow rather than treating every `rules/`
  // directory as generated.
  if (normalized.includes("/integrals/rubi/rules/") || exactSegment(segments, ["generated", "gen"]) || /(?:_pb2|_pb2_grpc|\.generated)\.py$/.test(file)) return "generated";
  if (exactSegment(segments.slice(0, -1), ["test", "tests", "testing"]) || /^test_.+\.py$/.test(file) || /_test\.py$/.test(file)) return "test";
  if (exactSegment(segments.slice(0, -1), ["example", "examples", "demo", "demos"])) return "example";
  if (exactSegment(segments.slice(0, -1), ["benchmark", "benchmarks", "bench"]) || /^bench_.+\.py$/.test(file)) return "benchmark";
  return "production";
}
export function pythonCatalog(head: Record<string, FrozenFile>, changedPaths: string[], scope: GraphScope = "core"): PythonCatalogEntry[] {
  const changed = new Set(changedPaths); const entries: PythonCatalogEntry[] = [];
  for (const path of Object.keys(head).filter(path => path.endsWith(".py"))) {
    const classification = classifyPythonPath(path); const isChanged = changed.has(path);
    const layer = isChanged ? "changed" : classification === "production" ? "production" : "supplemental";
    entries.push({ path, classification, changed: isChanged, included: scope === "all" || layer !== "supplemental", layer, status: head[path]!.status });
  }
  const priority = { changed: 0, production: 1, supplemental: 2 } as const;
  return entries.sort((a, b) => priority[a.layer] - priority[b.layer] || a.path.localeCompare(b.path));
}
