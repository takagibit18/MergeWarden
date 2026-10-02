import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewReport } from "../domain/contracts.ts";
import { atomicWrite, sha256, writeJson } from "../infrastructure/files.ts";
import type { RunManifest } from "./contracts.ts";
export function runPath(state: string, id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid run id");
  return join(state, "runs", id);
}
const clean = (text: string) => text.replace(/&/g, "&amp;").replace(/[<>]/g, c => c === "<" ? "&lt;" : "&gt;").replace(/[\\\x60*_[\]{}()#!|]/g, c => "\\" + c).replace(/[\r\n]+/g, " ");
export function markdown(report: ReviewReport): string {
  return [`# MergeWarden review: ${report.status}`, "", `Run: ${report.runId}`, `Snapshot: ${report.snapshot.id}`, "", clean(report.summary), "",
    "Advisory findings. Source integrity checks do not independently prove semantic correctness.", "",
    ...report.findings.flatMap(f => [`## ${f.severity}: ${clean(f.title)}`, "", clean(f.claim), "", `Trigger: ${clean(f.trigger)}`, `Impact: ${clean(f.impact)}`, "",
      ...f.evidence.map(e => `- ${e.revision} ${clean(e.path)}:${e.startLine}-${e.endLine} (SHA-256 ${e.contentSha256})`), ""]),
    "## Coverage", "", ...Object.entries(report.coverage).map(([path, status]) => `- ${clean(path)}: ${status}`), ""].join("\n");
}
export async function deliver(state: string, manifest: RunManifest, report: ReviewReport): Promise<{ reportPath: string; markdownPath: string }> {
  const directory = runPath(state, manifest.runId); const json = JSON.stringify(report, null, 2) + "\n"; const md = markdown(report);
  const reportPath = join(directory, "report.json"); const markdownPath = join(directory, "report.md");
  await atomicWrite(reportPath, json); await atomicWrite(markdownPath, md);
  await writeJson(join(directory, "run.json"), { ...manifest, status: "delivered", outcome: report.status, finishedAt: new Date().toISOString(), reportSha256: sha256(json), markdownSha256: sha256(md) });
  return { reportPath, markdownPath };
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
