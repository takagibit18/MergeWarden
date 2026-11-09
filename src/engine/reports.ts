import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FindingCandidate, ReviewReport } from "../domain/contracts.ts";
import { atomicWrite, sha256, writeJson } from "../infrastructure/files.ts";
import type { RunManifest } from "./contracts.ts";
import { NAVIGATION_FILE, NAVIGATION_LIMITS } from "./navigation-contracts.ts";
import type { NavigationRecord, NavigationState } from "./navigation-contracts.ts";
export function runPath(state: string, id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid run id");
  return join(state, "runs", id);
}
const clean = (text: string) => text.replace(/&/g, "&amp;").replace(/[<>]/g, c => c === "<" ? "&lt;" : "&gt;").replace(/[\\\x60*_[\]{}()#!|]/g, c => "\\" + c).replace(/[\r\n]+/g, " ");
const evidenceLines = (f: FindingCandidate) => f.evidence.map(e => `- ${e.revision} ${clean(e.path)}:${e.startLine}-${e.endLine} (SHA-256 ${e.contentSha256})`);
export function markdown(report: ReviewReport): string {
  return [`# MergeWarden review: ${report.status}`, "", `Run: ${report.runId}`, `Snapshot: ${report.snapshot.id}`, "", clean(report.summary), "",
    "Advisory findings. Source integrity checks do not independently prove semantic correctness.", "",
    ...report.findings.flatMap(f => [`## ${f.severity}: ${clean(f.title)}`, "", clean(f.claim), "", `Trigger: ${clean(f.trigger)}`, `Impact: ${clean(f.impact)}`,
      ...(f.acceptedTradeoffRejected ? [`Accepted trade-off not applied: ${clean(f.acceptedTradeoffRejected)}`] : []), "",
      ...evidenceLines(f), ""]),
    ...(report.knownAccepted?.length ? [`<details><summary>Known and accepted (${report.knownAccepted.length})</summary>`, "",
      ...report.knownAccepted.flatMap(f => [`### ${f.severity}: ${clean(f.title)}`, "", `Accepted trade-off: Skill ${f.acceptedTradeoff!.skillId} revision ${f.acceptedTradeoff!.revision}. ${clean(f.acceptedTradeoff!.note)}`, "",
        clean(f.claim), "", ...evidenceLines(f), ""]), "</details>", ""] : []),
    "## Coverage", "", ...Object.entries(report.coverage).map(([path, status]) => `- ${clean(path)}: ${status}`), ""].join("\n");
}
export interface DeliveryExtras { navigation?: NavigationRecord | { unavailable: string } }
/**
 * Report artifacts first, then the optional navigation projection, then run.json last.
 * Navigation is never required for delivery (ADR 0021): a failure is recorded as unavailable.
 */
export async function deliver(state: string, manifest: RunManifest, report: ReviewReport, extras: DeliveryExtras = {}): Promise<{ reportPath: string; markdownPath: string }> {
  const directory = runPath(state, manifest.runId); const json = JSON.stringify(report, null, 2) + "\n"; const md = markdown(report);
  const reportPath = join(directory, "report.json"); const markdownPath = join(directory, "report.md");
  await atomicWrite(reportPath, json); await atomicWrite(markdownPath, md);
  const navigation = extras.navigation === undefined ? undefined : await writeNavigation(directory, extras.navigation);
  await writeJson(join(directory, "run.json"), { ...manifest, status: "delivered", outcome: report.status, finishedAt: new Date().toISOString(), reportSha256: sha256(json), markdownSha256: sha256(md), ...(navigation ? { navigation } : {}) });
  return { reportPath, markdownPath };
}
async function writeNavigation(directory: string, record: NavigationRecord | { unavailable: string }): Promise<NavigationState> {
  if ("unavailable" in record) return { state: "unavailable", reason: record.unavailable.slice(0, 512) };
  try {
    const text = JSON.stringify(record) + "\n";
    if (Buffer.byteLength(text) > NAVIGATION_LIMITS.maxBytes) return { state: "unavailable", reason: "Navigation record exceeds its size limit" };
    await atomicWrite(join(directory, NAVIGATION_FILE), text);
    return { state: "recorded", sha256: sha256(text), steps: record.steps.length, entities: record.entities.length, relations: record.relations.length, truncated: record.truncated };
  } catch { return { state: "unavailable", reason: "Navigation record could not be written" }; }
}
export async function readNavigation(state: string, id: string): Promise<{ text: string; record: NavigationRecord }> {
  const text = await readFile(join(runPath(state, id), NAVIGATION_FILE), "utf8");
  return { text, record: JSON.parse(text) as NavigationRecord };
}
export async function readRun(state: string, id: string): Promise<RunManifest> {
  const manifest = JSON.parse(await readFile(join(runPath(state, id), "run.json"), "utf8")) as RunManifest;
  if (manifest.schemaVersion !== 1 || manifest.runId !== id) throw new Error("Invalid run manifest");
  return manifest;
}
export async function readReport(state: string, id: string): Promise<ReviewReport> {
  const manifest = await readRun(state, id);
  if (manifest.status !== "delivered") throw new Error("Run has no confirmed delivery");
  const path = runPath(state, id); const json = await readFile(join(path, "report.json"), "utf8"); const md = await readFile(join(path, "report.md"), "utf8");
  if (sha256(json) !== manifest.reportSha256 || sha256(md) !== manifest.markdownSha256) throw new Error("Report integrity mismatch");
  const report = JSON.parse(json) as ReviewReport;
  if (report.runId !== id || report.snapshot.id !== manifest.snapshotId || report.status !== manifest.outcome) throw new Error("Report identity mismatch");
  return report;
}
export async function history(state: string): Promise<RunManifest[]> {
  let entries: string[]; try { entries = await readdir(join(state, "runs")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const manifests: RunManifest[] = [];
  for (const id of entries) { try { const m = await readRun(state, id); if (m.status === "delivered") await readReport(state, id); manifests.push(m); } catch { /* Corrupt records never become successful reports. */ } }
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
