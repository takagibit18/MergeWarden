import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PythonTreeSitterExtractor } from "../src/python-extractor.ts";
test("real Python grammar extracts distinct scoped names and unresolved calls", async () => {
  const grammar = process.env.MERGEWARDEN_PYTHON_GRAMMAR_WASM;
  const extractor = await PythonTreeSitterExtractor.create(grammar);
  try {
    const source = await readFile(new URL("../../../tests/fixtures/python/scopes.py", import.meta.url), "utf8");
    const result = await extractor.extract({ snapshotId: "fixture", path: "scopes.py", source });
    assert.equal(result.parseComplete, true);
    assert.deepEqual(result.symbols.map((s) => s.qualifiedName), ["scopes", "scopes.LocalStore", "scopes.LocalStore.save", "scopes.RemoteStore", "scopes.RemoteStore.save", "scopes.entry"]);
    assert.equal(new Set(result.symbols.map((s) => s.id)).size, result.symbols.length);
    assert.ok(result.calls.length > 0);
    assert.ok(result.calls.every((call) => call.resolution === "unresolved"));
  } finally { extractor.dispose(); }
});
