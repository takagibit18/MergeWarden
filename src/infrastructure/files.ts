import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function safePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes(":") || /[\x00-\x1f]/.test(path) || path.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Unsafe relative path");
  return path;
}
export function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export async function isolatedState(directory: string, repository: string): Promise<string> {
  const repo = await realpath(repository);
  const desired = resolve(directory);
  let ancestor = desired;
  while (true) {
    try { await lstat(ancestor); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next = dirname(ancestor); if (next === ancestor) throw new Error("No existing state ancestor"); ancestor = next;
  }
  const canonical = resolve(await realpath(ancestor), relative(ancestor, desired));
  if (inside(repo, canonical) || inside(canonical, repo)) throw new Error("State directory must be outside and separate from the reviewed checkout");
  await mkdir(canonical, { recursive: true, mode: 0o700 });
  const result = await realpath(canonical);
  if (result !== canonical) throw new Error("State directory changed during admission");
  return result;
}
export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(text, "utf8"); await file.sync(); } finally { await file.close(); }
    // Windows readers can briefly deny replacing the destination. Keep the old
    // file intact and retry the same atomic rename for at most 40 x 25 ms.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt >= 40 ||
          !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await delay(25);
      }
    }
  } finally { await rm(temporary, { force: true }); }
  // Windows does not support opening directories for fsync. File data is synced on all hosts.
  if (process.platform !== "win32") { const dir = await open(dirname(path), "r"); try { await dir.sync(); } finally { await dir.close(); } }
}
export const writeJson = (path: string, value: unknown): Promise<void> => atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
