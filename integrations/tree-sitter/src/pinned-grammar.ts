import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Load the official npm artifact without executing its native binding or scripts. */
export async function loadPinnedPythonGrammar(path?: string): Promise<{ bytes: Uint8Array; abi: number }> {
  const lock = JSON.parse(await readFile(new URL("../grammars/python.lock.json", import.meta.url), "utf8")) as {
    sha256: string; abi: number;
  };
  const grammarPath = path ?? fileURLToPath(new URL("../node_modules/tree-sitter-python/tree-sitter-python.wasm", import.meta.url));
  const bytes = await readFile(grammarPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== lock.sha256) throw new Error("Python grammar SHA-256 does not match the checked-in lock");
  return { bytes, abi: lock.abi };
}
