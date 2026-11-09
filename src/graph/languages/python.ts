import { PythonResolver, RESOLVER_VERSION } from "../python-resolver.ts";
import { FILE_SCOPE_POLICY_VERSION, classifyPythonPath, pythonModuleName } from "../scope-policy.ts";
import type { LanguageDescriptor } from "./contracts.ts";

/** Graph v4 Python pack. Its version strings are the historical ones, so Python-only identities are unchanged. */
export const PYTHON_PARSER_VERSION = "web-tree-sitter-0.27.0/python-0.25.0-abi15";
export const PYTHON_POLICY_VERSION = `python-entity-core-2/${FILE_SCOPE_POLICY_VERSION}`;

export const python: LanguageDescriptor = {
  id: "python", displayName: "Python",
  versions: { parser: PYTHON_PARSER_VERSION, resolver: RESOLVER_VERSION, policy: PYTHON_POLICY_VERSION },
  capabilities: { relations: ["CONTAINS", "IMPORTS", "CALLS", "INHERITS"], declarations: true, receiverNavigation: true },
  owns: path => path.endsWith(".py"),
  classify: classifyPythonPath,
  moduleName: pythonModuleName,
  importTarget(importerPath, item) {
    const packageParts = importerPath.replace(/\/[^/]+$/, "").split("/");
    const module = item.relativeLevel ? [...packageParts.slice(0, packageParts.length - item.relativeLevel + 1), ...item.module.split(".").filter(Boolean)].join(".") : item.module;
    const stem = module.replaceAll(".", "/");
    return { module, files: [`${stem}.py`, `${stem}/__init__.py`], ...(item.importedName ? { importedName: item.importedName } : {}) };
  },
  async createResolver(context) { return new PythonResolver(context.snapshotId, { structure: false }); },
  extractor: { module: "../../../integrations/tree-sitter/src/python-extractor.ts", export: "PythonTreeSitterExtractor" },
};
