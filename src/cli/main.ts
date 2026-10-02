import { SkillBank } from '../skills/bank.ts';
import { feedback, learnPending, recoverDelivered } from '../skills/learning.ts';
import type { Learner } from '../skills/contracts.ts';
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
npm run cli -- feedback --run ID --comment TEXT [--finding ID] [--path FILE --start-line N --end-line N]
npm run cli -- skills list|learn|unlock [--state PATH]
npm run cli -- skills show|disable --id SKILL_ID [--state PATH]
npm run cli -- skills rollback --id SKILL_ID --revision N [--state PATH]
npm run cli -- history [--state PATH]
npm run cli -- show --run ID [--state PATH]
npm run cli -- evidence --run ID --finding ID [--state PATH]
npm run cli -- doctor [--repo PATH] [--state PATH]
npm run cli -- unlock --repo PATH [--state PATH]

Options: --skills auto|off|replay, --learn auto|off, --comment-file OUTSIDE_PATH,
         --event ID --version N (edit feedback), --withdrawn true|false, --verdict correction|missed_defect|contract|uncertain,
         --retry true|false --max-jobs 1..3 (skills learn), --state PATH (outside checkout), --timeout-ms 600000, --max-tools 100,
         --thinking LEVEL (must be supported by the selected model), --max-output-tokens 8192,
         --auth oauth (use explicit Pi login instead of --api-key-env),
         --include-untracked PATH (repeat; worktree only, ignored files excluded)
API keys come only from the named environment variable; OAuth uses STATE/auth/auth.json.
No repository model config or existing Pi/Codex login is read. Models lists catalog capabilities, not account entitlements.
Exit codes: 0 completed/read-only/no_changes; 2 input or persistence failure; 3 incomplete/failed/cancelled.
No cost estimate is produced. Model requests occur in review/rerun (including bounded learning), and explicitly authenticated feedback/skills learn.`;
function parse(argv: string[]) {
  const values = new Map<string, string[]>();
  const known = new Set(["repo", "state", "scope", "base", "head", "provider", "model", "auth", "api-key-env", "timeout-ms", "max-tools", "thinking", "max-output-tokens", "include-untracked", "run", "finding", "skills", "learn", "id", "revision", "comment", "comment-file", "event", "version", "path", "start-line", "end-line", "verdict", "withdrawn", "retry", "max-jobs"]);
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
  const skillAction = command === 'skills' ? argv[1] : undefined;
  const options = parse(argv.slice(command === 'skills' ? 2 : 1));
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
  const feedbackRun = command === 'feedback' ? await (await import('../engine/reports.ts')).readRun(state,options.require('run')) : undefined;
  const repository = await realpath(resolve(feedbackRun?.repositoryPath ?? options.get("repo") ?? process.cwd()));
  const admittedState = await isolatedState(state, repository);
  const learningAdapter = async (): Promise<Learner> => {
    const auth = options.get('auth') ?? 'api-key';
    if (!['oauth','api-key'].includes(auth)) throw Error('Invalid --auth');
    if (auth === 'oauth' && options.get('api-key-env')) throw Error('OAuth and API key are mutually exclusive');
    const env = auth === 'api-key' ? options.require('api-key-env') : undefined;
    if (env && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) throw Error('Invalid API key environment variable');
    const authentication = auth === 'oauth' ? {type:'oauth' as const,authPath:join(await isolatedState(join(admittedState,'auth'),repository),'auth.json')} : process.env[env!] ?? '';
    const module = await import(new URL('../../integrations/pi/src/learning.ts',import.meta.url).href);
    return module.createPiLearner(authentication);
  };
  const learningOptions = () => ({model:{provider:options.require('provider'),modelId:options.require('model')},maxJobs:Number(options.get('max-jobs')??1),retryFailed:options.get('retry')==='true'});
  if (command === 'feedback') {
    if (!!options.get('comment') === !!options.get('comment-file')) throw Error('Supply exactly one of --comment or --comment-file');
    const file = options.get('comment-file');
    if (file && (await import('../infrastructure/files.ts')).inside(repository,await realpath(resolve(file)))) throw Error('Feedback files must be outside the reviewed checkout');
    if (options.get('withdrawn') && !['true','false'].includes(options.get('withdrawn')!)) throw Error('Invalid --withdrawn');
    const result = await feedback(admittedState,{runId:options.require('run'),comment:file?await readFile(resolve(file),'utf8'):options.require('comment'),
      ...(options.get('finding')?{findingId:options.get('finding')!}:{}),...(options.get('event')?{eventId:options.get('event')!}:{}),
      ...(options.get('version')?{version:Number(options.get('version'))}:{}),...(options.get('withdrawn')?{withdrawn:options.get('withdrawn')==='true'}:{}),
      ...(options.get('verdict')?{verdict:options.get('verdict') as import('../skills/contracts.ts').SkillSource['verdict']}:{}),
      ...(options.get('path')?{range:{path:options.require('path'),startLine:Number(options.require('start-line')),endLine:Number(options.require('end-line'))}}:{})});
    let learning:unknown={status:'pending'};
    if (options.get('auth') || options.get('api-key-env')) try { learning=await learnPending(admittedState,await learningAdapter(),{...learningOptions(),maxJobs:1,repositoryKey:result.source.repositoryKey,feedbackOnly:true}); } catch {learning={status:'pending',error:'Feedback saved; learning not completed'};}
    console.log(JSON.stringify({...result,learning},null,2));return 0;
  }
  if (command === 'skills') {
    const bank=new SkillBank(admittedState);let result:unknown;
    if(skillAction==='list') result=await bank.skills();
    else if(skillAction==='show') {const skills=await bank.skills();const skill=options.get('revision')?await bank.revision(options.require('id'),Number(options.get('revision'))):skills.find(s=>s.id===options.require('id'));if(!skill)throw Error('Skill not found');result={skill,sources:await Promise.all(skill.sources.map(id=>bank.source(id)))};}
    else if(skillAction==='disable'||skillAction==='rollback') result=await bank.manage(options.require('id'),skillAction==='rollback'?Number(options.require('revision')):undefined);
    else if(skillAction==='learn') {if(options.get('retry')&&!['true','false'].includes(options.get('retry')!))throw Error('Invalid --retry');const learner=await learningAdapter();await recoverDelivered(admittedState);result=await learnPending(admittedState,learner,learningOptions());}
    else if(skillAction==='unlock') {await bank.recoverLock('write');await bank.recoverLock('learning');result={unlocked:true};}
    else throw Error('Invalid skills command');
    console.log(JSON.stringify(result,null,2));return 0;
  }
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
    const learnMode=options.get('learn')??'auto',skillsMode=options.get('skills')??(command==='rerun'?'replay':'auto');
    if(!['auto','off'].includes(learnMode)||!['auto','off','replay'].includes(skillsMode))throw Error('Invalid skills/learn mode');
    const learner=learnMode==='auto'?await learningAdapter():undefined;
    if(learner)try{await learnPending(admittedState,learner,{model,inference,repositoryKey:sha256(repository),feedbackOnly:true,maxJobs:1});}catch{console.error(JSON.stringify({learning:'pending feedback unavailable; continuing review'}));}
    const result = await new ReviewEngine(factory,undefined,learner).run({ skills:skillsMode as 'auto'|'off'|'replay',learn:learnMode as 'auto'|'off', repositoryPath: repository, stateDir: admittedState, model, signal: abort.signal,
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
