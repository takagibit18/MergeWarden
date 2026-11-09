import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Load an official npm grammar artifact without executing its native binding or scripts. The bytes
 * must match grammars/<lock>.lock.json (SHA-256 and ABI); a missing or changed grammar is an error.
 */
export async function loadPinnedGrammar(lockName: string, path?: string): Promise<{ bytes: Uint8Array; abi: number }> {
  if (!/^[a-z]+$/.test(lockName)) throw new Error("Invalid grammar lock name");
  const lock = JSON.parse(await readFile(new URL(`../grammars/${lockName}.lock.json`, import.meta.url), "utf8")) as { package: string; file: string; sha256: string; abi: number };
  const grammarPath = path ?? fileURLToPath(new URL(`../node_modules/${lock.package}/${lock.file}`, import.meta.url));
  const bytes = await readFile(grammarPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== lock.sha256) throw new Error(`${lockName} grammar SHA-256 does not match the checked-in lock`);
  return { bytes, abi: lock.abi };
}

/** Load the official npm artifact without executing its native binding or scripts. */
export async function loadPinnedPythonGrammar(path?: string): Promise<{ bytes: Uint8Array; abi: number }> {
  try { return await loadPinnedGrammar("python", path); }
  catch (error) { if (error instanceof Error && error.message.startsWith("python grammar SHA-256")) throw new Error("Python grammar SHA-256 does not match the checked-in lock"); throw error; }
}
