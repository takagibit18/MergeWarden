import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PythonTreeSitterExtractor } from "../src/python-extractor.ts";

async function withExtractor(t) {
  const extractor = await PythonTreeSitterExtractor.create();
  t.after(() => extractor.dispose());
  return extractor;
}

test("syntax errors remain visible instead of claiming a complete parse", async (t) => {
  const extractor = await withExtractor(t);
  const facts = await extractor.extract({ snapshotId: "s1", path: "bad.py", source: "def broken(:\n    return 1\n" });
  assert.equal(facts.parseComplete, false);
  assert.ok(facts.diagnostics.some((item) => item.includes("Syntax errors")));
});

test("Unicode symbols and line references retain their snapshot identity", async (t) => {
  const extractor = await withExtractor(t);
  const input = { snapshotId: "s1", path: "unicode.py", source: "# 中文注释\ndef 保存():\n    return 1\n\n保存()\n" };
  const first = await extractor.extract(input);
  const repeated = await extractor.extract(input);
  const next = await extractor.extract({ ...input, snapshotId: "s2" });
  assert.equal(first.parseComplete, true);
  assert.equal(first.symbols[1].qualifiedName, "unicode.保存");
  assert.equal(first.symbols[1].startLine, 2);
  assert.equal(first.calls[0].startLine, 5);
  assert.equal(first.symbols[0].id, repeated.symbols[0].id);
  assert.notEqual(first.symbols[0].id, next.symbols[0].id);
});

test("dynamic receiver calls never become proven same-name targets", async (t) => {
  const extractor = await withExtractor(t);
  const facts = await extractor.extract({ snapshotId: "s1", path: "dynamic.py", source: "def save():\n    pass\n\nstore.save()\ngetattr(store, name)()\n" });
  assert.ok(facts.calls.length >= 3);
  assert.ok(facts.calls.every((call) => call.resolution === "unresolved" && call.candidateTargetIds.length === 0));
});

test("missing or modified grammars fail without a parser fallback", async (t) => {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, "mergewarden-grammar-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(parent + sep));
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(PythonTreeSitterExtractor.create(join(directory, "missing.wasm")), /ENOENT/);
  const path = join(directory, "modified.wasm");
  await writeFile(path, "untrusted grammar");
  await assert.rejects(PythonTreeSitterExtractor.create(path), /SHA-256/);
});
