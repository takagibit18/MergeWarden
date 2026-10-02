import { execFile } from "node:child_process";
// Git for Windows uses its POSIX null path, not Node's Windows device path.
const devNull = "/dev/null";
export function git(repository: string, args: string[], signal?: AbortSignal, input?: string): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(key)) delete env[key];
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["--no-pager", "-c", "safe.directory=", "-c", "safe.directory=" + repository, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + devNull, "-c", "core.attributesFile=" + devNull, "-c", "diff.external=", "-C", repository, ...args],
      { ...(signal ? { signal } : {}), env, encoding: "buffer", maxBuffer: 128 * 1024 * 1024, timeout: 30_000, windowsHide: true },
      (error, stdout, stderr) => error ? reject(new Error(`Git ${args[0]} failed: ${stderr.toString("utf8").slice(0, 500)}`)) : resolve(stdout));
    child.stdin?.on("error", () => {}); child.stdin?.end(input);
  });
}
