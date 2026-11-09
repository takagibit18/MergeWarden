import ts from "typescript";
import type { ResolverContext } from "../../../src/graph/languages/contracts.ts";

/** Virtual root: TypeScript sees only the frozen head, never the working tree or node_modules on disk. */
const ROOT = "/__mergewarden_snapshot__";
const toVirtual = (path: string) => `${ROOT}/${path}`;
const fromVirtual = (path: string) => path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : undefined;

/**
 * TypeScript's own module resolution (tsconfig `paths`/`baseUrl`, extensions, index files, `.js`→`.ts`)
 * over a host backed by the snapshot (ADR 0022 D14). Nothing is executed and no dependency is
 * installed: a module outside the snapshot, a declaration file or a package import is external.
 */
export async function createSpecifierResolver(context: ResolverContext): Promise<(specifier: string, fromPath: string) => string | undefined> {
  const files = new Set(context.paths); const directories = new Set<string>([""]);
  for (const path of context.paths) { const parts = path.split("/"); for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/")); }
  // Only small JSON configuration is preloaded; module resolution reads nothing else.
  const config = new Map<string, string>();
  for (const path of context.paths) if (/(^|\/)(package\.json|tsconfig[^/]*\.json)$/.test(path) && !path.split("/").includes("node_modules")) {
    try { const text = await context.readText(path); if (text.length <= 256 * 1024) config.set(path, text); } catch { /* unreadable config is ignored */ }
  }
  let options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowImportingTsExtensions: true, noEmit: true };
  const rootConfig = config.get("tsconfig.json");
  if (rootConfig) {
    const parsed = ts.parseConfigFileTextToJson("tsconfig.json", rootConfig);
    const compilerOptions = (parsed.config as { compilerOptions?: unknown } | undefined)?.compilerOptions;
    if (compilerOptions) {
      const converted = ts.convertCompilerOptionsFromJson(compilerOptions, ROOT, "tsconfig.json").options;
      // `extends` and project references are not followed in v1; coverage reports unresolved imports instead.
      options = { ...options, ...converted, noEmit: true };
      if (options.moduleResolution === undefined) options.moduleResolution = ts.ModuleResolutionKind.Bundler;
    }
  }
  const host: ts.ModuleResolutionHost = {
    fileExists: path => { const relative = fromVirtual(path); return relative !== undefined && files.has(relative); },
    readFile: path => { const relative = fromVirtual(path); return relative === undefined ? undefined : config.get(relative); },
    directoryExists: path => { if (path === ROOT) return true; const relative = fromVirtual(path); return relative !== undefined && directories.has(relative); },
    realpath: path => path, getCurrentDirectory: () => ROOT, useCaseSensitiveFileNames: true,
  };
  const cache = ts.createModuleResolutionCache(ROOT, name => name, options);
  return (specifier, fromPath) => {
    if (!specifier || specifier.length > 1024) return undefined;
    const resolved = ts.resolveModuleName(specifier, toVirtual(fromPath), options, host, cache).resolvedModule;
    if (!resolved || resolved.isExternalLibraryImport) return undefined;
    const path = fromVirtual(resolved.resolvedFileName);
    return path && files.has(path) && !/\.d\.(ts|mts|cts)$/.test(path) ? path : undefined;
  };
}
