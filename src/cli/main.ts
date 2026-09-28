import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile, realpath, rm } from "node:fs/promises";
import { ReviewEngine } from "../engine/review.ts";
import { history, readReport } from "../engine/reports.ts";
import { SnapshotStore } from "../snapshot/store.ts";
import { git } from "../infrastructure/git.ts";
import { isolatedState, sha256 } from "../infrastructure/files.ts";
import type { InferenceOptions, RuntimeFactory } from "../engine/contracts.ts";
import type { ReviewInput } from "../snapshot/contracts.ts";
const HELP = `MergeWarden — advisory review of immutable Git changes

npm run cli -- models [--provider NAME]
npm run cli -- login --provider NAME [--state PATH]
npm run cli -- auth-status --provider NAME [--state PATH]
npm run cli -- logout --provider NAME [--state PATH]
npm run cli -- review --repo PATH --base REF --head REF --provider NAME --model ID --api-key-env NAME
npm run cli -- review --repo PATH --scope staged|worktree --provider NAME --model ID --api-key-env NAME
npm run cli -- rerun --run ID --repo PATH --provider NAME --model ID --api-key-env NAME
npm run cli -- history [--state PATH]
npm run cli -- show --run ID [--state PATH]
npm run cli -- evidence --run ID --finding ID [--state PATH]
npm run cli -- doctor [--repo PATH] [--state PATH]
npm run cli -- unlock --repo PATH [--state PATH]

Options: --state PATH (outside checkout), --timeout-ms 600000, --max-tools 100,
         --thinking LEVEL (must be supported by the selected model), --max-output-tokens 8192,
         --auth oauth (use explicit Pi login instead of --api-key-env),
         --include-untracked PATH (repeat; worktree only, ignored files excluded)
API keys come only from the named environment variable; OAuth uses STATE/auth/auth.json.
No repository model config or existing Pi/Codex login is read. Models lists catalog capabilities, not account entitlements.
Exit codes: 0 completed/read-only/no_changes; 2 input or persistence failure; 3 incomplete/failed/cancelled.
No cost estimate is produced. Real model requests occur only in review/rerun.`;
function parse(argv: string[]) {
  const values = new Map<string, string[]>();
  const known = new Set(["repo", "state", "scope", "base", "head", "provider", "model", "auth", "api-key-env", "timeout-ms", "max-tools", "thinking", "max-output-tokens", "include-untracked", "run", "finding"]);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!; const value = argv[i + 1]; const key = flag.slice(2);
    if (!flag.startsWith("--") || !known.has(key) || !value || value.startsWith("--")) throw new Error(`Invalid option: ${flag}`);
    if (values.has(key) && key !== "include-untracked") throw new Error(`Duplicate option: ${flag}`);
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return { get: (key: string) => values.get(key)?.[0], all: (key: string) => values.get(key) ?? [], require(key: string) { const value = values.get(key)?.[0]; if (!value) throw new Error(`Missing --${key}`); return value; } };
}
async function adapter(): Promise<{ listModels(provider?: string): Promise<unknown>; createPiRuntimeFactory(auth: string | { type: "oauth"; authPath: string }): RuntimeFactory }> {
  const url = new URL("../../integrations/pi/src/runtime.ts", import.meta.url).href;
  try { return await import(url); } catch { throw new Error("Pi adapter unavailable; run npm run setup with Node.js 22.19+"); }
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "status";
  if (command === "help" || command === "--help") { console.log(HELP); return 0; }
  if (command === "demo") { await (await import("./demo.ts")).demo(); return 0; }
  if (command === "status") {
    console.log(JSON.stringify({ milestone: "v0.2 Python graph + reproducible evaluation; quality benefit unproven", review: "Pi + frozen source, CLI, final-only advisory reports", graph: "Lazy HEAD Python entity graph + core/all resumable SQLite generations + graph tools", evaluation: "20 frozen controlled cases; text-only ablation internal", ide: "pending", liveModelValidated: false, liveModelValidation: { historical: true, appliesToCurrentProviderPolicy: false, provider: "bigmodel", model: "glm-5.3-flash", date: "2026-09-20", scope: "Controlled Python CLI smoke and full 20-case paired A/B; 35/40 complete deliveries; 5 timeouts retained. Independent human Golden review pending; no Graph discovery benefit established." }, advisor: "off" }, null, 2)); return 0;
  }
  const options = parse(argv.slice(1));
  const state = resolve(options.get("state") ?? join(process.env.LOCALAPPDATA ?? homedir(), "MergeWarden2"));
  if (command === "models") { console.log(JSON.stringify(await (await adapter()).listModels(options.get("provider")), null, 2)); return 0; }
  if (command === "history") { console.log(JSON.stringify(await history(state), null, 2)); return 0; }
  if (command === "show" || command === "evidence") {
    const report = await readReport(state, options.require("run"));
    if (command === "show") console.log(JSON.stringify(report, null, 2));
    else {
      const finding = report.findings.find(f => f.id === options.require("finding")); if (!finding) throw new Error("Finding is not in the saved report");
      const snapshot = await SnapshotStore.load(state, report.snapshot.id);
      console.log(JSON.stringify(await Promise.all(finding.evidence.map(e => snapshot.source(e.revision, e.path, e.startLine, e.endLine))), null, 2));
    }
    return 0;
  }
  const repository = await realpath(resolve(options.get("repo") ?? process.cwd()));
  const admittedState = await isolatedState(state, repository);
  if (command === "login" || command === "auth-status" || command === "logout") {
    if (options.get("api-key-env") || options.get("auth")) throw Error("Login commands select OAuth directly; omit --auth and --api-key-env");
    const provider = options.require("provider");
    const authPath = join(await isolatedState(join(admittedState, "auth"), repository), "auth.json");
    const auth = await import(new URL("../../integrations/pi/src/auth.ts", import.meta.url).href);
    const result = command === "login" ? await auth.loginOAuthInTerminal(provider, authPath)
      : command === "logout" ? await auth.logoutOAuth(provider, authPath) : await auth.oauthStatus(provider, authPath);
    console.log(JSON.stringify(result, null, 2)); return 0;
  }
  if (command === "doctor" || command === "unlock") {
    const version = (await git(repository, ["--version"])).toString().trim();
    const lockPath = join(admittedState, "locks", sha256(repository) + ".lock");
    let lock: { pid: number; createdAt: string } | undefined;
    try { lock = JSON.parse(await readFile(lockPath, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Lock is unreadable; inspect the state directory"); }
    let alive = false;
    if (lock) {
      if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error("Lock has invalid process identity");
      try { process.kill(lock.pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    }
    if (command === "unlock") { if (alive) throw new Error("The lock owner may still be running; cancel that process first"); if (lock) await rm(lockPath); }
    console.log(JSON.stringify({ node: process.version, git: version, repository, state: admittedState, lock: lock ? { ...lock, ownerAlive: alive } : null, ...(command === "unlock" ? { unlocked: true } : {}) }, null, 2)); return 0;
  }
  if (command !== "review" && command !== "rerun") throw new Error("Unknown command; use help");
  let input: ReviewInput | undefined;
  if (command === "review") {
    const scope = options.get("scope") ?? "commits";
    if (scope === "commits") input = { kind: "commits", base: options.require("base"), head: options.require("head") };
    else if (scope === "staged" || scope === "worktree") {
      if (options.get("base") || options.get("head")) throw new Error("Commit refs cannot be combined with staged/worktree scope");
      input = scope === "worktree" ? { kind: scope, includeUntracked: options.all("include-untracked") } : { kind: scope };
    } else throw new Error("Invalid scope");
    if (scope !== "worktree" && options.all("include-untracked").length) throw new Error("Explicit untracked files require worktree scope");
  }
  const authMode = options.get("auth") ?? "api-key";
  if (authMode !== "api-key" && authMode !== "oauth") throw Error("Invalid --auth; use api-key or oauth");
  let authentication: string | { type: "oauth"; authPath: string };
  if (authMode === "oauth") {
    if (options.get("api-key-env")) throw Error("--auth oauth cannot be combined with --api-key-env");
    authentication = { type: "oauth", authPath: join(await isolatedState(join(admittedState, "auth"), repository), "auth.json") };
  } else {
    const keyVariable = options.require("api-key-env");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyVariable)) throw new Error("Invalid API key environment variable name");
    const key = process.env[keyVariable]; if (!key?.trim()) throw new Error(`Set ${keyVariable} in this shell before review; do not pass a key as a command argument`);
    authentication = key;
  }
  const model = { provider: options.require("provider"), modelId: options.require("model") };
  const level = options.get("thinking");
  if (level && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) throw Error("Invalid --thinking level");
  const inference: InferenceOptions = { ...(level ? { thinkingLevel: level as NonNullable<InferenceOptions["thinkingLevel"]> } : {}),
    ...(options.get("max-output-tokens") ? { maxOutputTokens: Number(options.get("max-output-tokens")) } : {}) };
  const factory = (await adapter()).createPiRuntimeFactory(authentication);
  const abort = new AbortController(); const cancel = () => abort.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const result = await new ReviewEngine(factory).run({ repositoryPath: repository, stateDir: admittedState, model, signal: abort.signal,
      ...(Object.keys(inference).length ? { inference } : {}),
      ...(input ? { input } : { rerunId: options.require("run") }),
      ...(options.get("timeout-ms") ? { timeoutMs: Number(options.get("timeout-ms")) } : {}),
      ...(options.get("max-tools") ? { maxToolCalls: Number(options.get("max-tools")) } : {}),
    }, progress => console.error(JSON.stringify(progress)));
    console.log(JSON.stringify(result, null, 2)); return result.kind === "no_changes" || result.report.status === "completed" ? 0 : 3;
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
try { process.exitCode = await main(); } catch (error) {
  const message = error instanceof Error ? error.message : "Review failed";
  // Never print provider response bodies, stack traces, or credential values.
  const keyIndex = process.argv.indexOf("--api-key-env"); const keyName = keyIndex >= 0 ? process.argv[keyIndex + 1] : undefined;
  const secret = keyName ? process.env[keyName] : undefined;
  console.error(JSON.stringify({ error: secret ? message.split(secret).join("[redacted]") : message })); process.exitCode = 2;
}
