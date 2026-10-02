import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSessionJournal } from "../src/journal.ts";
import { createReviewSession } from "../src/create-session.ts";
import { createReviewExtension } from "../src/extension.ts";
import { ReviewController } from "../../../src/application/review-controller.ts";
import { snapshot } from "../../../tests/helpers.mjs";

async function fixture(t) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, "mergewarden-pi-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(parent + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const repository = join(directory, "checkout");
  const state = join(directory, "state");
  await mkdir(repository);
  await mkdir(state);
  return { directory, repository, state };
}

// This is a synthetic message fixture. No model is contacted or evaluated.
function appendAssistantFixture(manager) {
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Synthetic persistence fixture." }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
}

async function complete(controller) {
  await controller.start("final_only", ["fixture.py"]);
  await controller.dispatch({ type: "candidates.submitted", channel: "final_only", candidates: [] });
  await controller.dispatch({ type: "unit.finished", unitId: "fixture.py", outcome: "done" });
  await controller.dispatch({ type: "run.finished", outcome: "completed", summary: "Synthetic fixture only." });
}

test("native Pi JSONL reopens and restores controller state", async (t) => {
  const { repository, state } = await fixture(t);
  const manager = SessionManager.create(repository, state);
  appendAssistantFixture(manager);
  const controller = new ReviewController(new PiSessionJournal(manager), "fixture-run", snapshot);
  await complete(controller);
  const file = manager.getSessionFile();
  assert.ok(existsSync(file));
  const reopened = SessionManager.open(file);
  const recovered = new ReviewController(new PiSessionJournal(reopened), "fixture-run", snapshot);
  await recovered.restore();
  assert.deepEqual(recovered.report(), controller.report());
  assert.equal(reopened.buildSessionContext().messages.length, 1, "business entries must not enter model context");
  const rows = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.filter((row) => row.customType === "mergewarden.review-event.v1").length, 4);
});

test("Pi 0.84.1 defers the new JSONL until the first assistant message", async (t) => {
  const { repository, state } = await fixture(t);
  const manager = SessionManager.create(repository, state);
  const journal = new PiSessionJournal(manager);
  const controller = new ReviewController(journal, "fixture-run", snapshot);
  await controller.start("final_only", ["fixture.py"]);
  assert.equal((await journal.readActiveBranch()).length, 1);
  assert.equal(existsSync(manager.getSessionFile()), false, "append is not a durability guarantee");
  appendAssistantFixture(manager);
  assert.equal(existsSync(manager.getSessionFile()), true);
});

test("native recovery follows the current branch, excluding abandoned events", async (t) => {
  const { repository, state } = await fixture(t);
  const manager = SessionManager.create(repository, state);
  appendAssistantFixture(manager);
  const first = new ReviewController(new PiSessionJournal(manager), "fixture-run", snapshot);
  await first.start("final_only", ["fixture.py"]);
  const forkPoint = manager.getLeafId();
  await first.dispatch({ type: "unit.finished", unitId: "fixture.py", outcome: "done" });
  manager.branch(forkPoint);
  const alternate = new ReviewController(new PiSessionJournal(manager), "fixture-run", snapshot);
  await alternate.restore();
  assert.equal(alternate.state.units["fixture.py"], "pending");
  await alternate.dispatch({ type: "unit.finished", unitId: "fixture.py", outcome: "failed" });
  const recovered = new ReviewController(new PiSessionJournal(SessionManager.open(manager.getSessionFile())), "fixture-run", snapshot);
  await recovered.restore();
  assert.equal(recovered.state.units["fixture.py"], "failed");
  assert.equal(recovered.state.sequence, 2);
});

test("native recovery rejects snapshot drift and missing event sequences", async (t) => {
  const { repository, state } = await fixture(t);
  const manager = SessionManager.create(repository, state);
  appendAssistantFixture(manager);
  await complete(new ReviewController(new PiSessionJournal(manager), "fixture-run", snapshot));
  const drifted = new ReviewController(new PiSessionJournal(SessionManager.open(manager.getSessionFile())), "fixture-run",
    { ...snapshot, configurationFingerprint: "changed" });
  await assert.rejects(drifted.restore(), /identity mismatch/);
  const file = manager.getSessionFile();
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  // Corrupt an intermediate business sequence without breaking native tree links.
  const rows = lines.map(JSON.parse);
  const entry = rows.find((row) => row.data?.sequence === 2);
  entry.data.sequence = 99;
  await writeFile(file, rows.map(JSON.stringify).join("\n") + "\n");
  const damaged = new ReviewController(new PiSessionJournal(SessionManager.open(file)), "fixture-run", snapshot);
  await assert.rejects(damaged.restore(), /non-contiguous/);
  assert.equal(damaged.state, undefined);
});

test("journal isolates caller-owned event data", async () => {
  const manager = SessionManager.inMemory();
  const journal = new PiSessionJournal(manager);
  const event = { schemaVersion: 1, id: "e1", runId: "fixture-run", snapshotId: snapshot.id, sequence: 1,
    at: "2026-09-20T00:00:00Z", payload: { type: "run.started", snapshot: structuredClone(snapshot), deliveryPolicy: "final_only", units: ["fixture.py"] } };
  await journal.append(event);
  event.payload.units.push("mutated");
  const firstRead = await journal.readActiveBranch();
  assert.deepEqual(firstRead[0].payload.units, ["fixture.py"]);
  firstRead[0].payload.units.push("also-mutated");
  assert.deepEqual((await journal.readActiveBranch())[0].payload.units, ["fixture.py"]);
});

test("tool hook blocks tools outside the explicit allowlist", async () => {
  let handler;
  createReviewExtension(new Set(["read_source"]))({ on(name, callback) { assert.equal(name, "tool_call"); handler = callback; } });
  assert.equal(await handler({ toolName: "read_source" }), undefined);
  assert.equal((await handler({ toolName: "bash" })).block, true);
});

test("real SDK creates an isolated session with no active tools or repository instructions", async (t) => {
  const { repository, state } = await fixture(t);
  const marker = "UNTRUSTED_REPOSITORY_INSTRUCTIONS_MUST_NOT_LOAD";
  await writeFile(join(repository, "AGENTS.md"), marker);
  await mkdir(join(repository, ".pi", "extensions"), { recursive: true });
  await writeFile(join(repository, ".pi", "extensions", "untrusted.ts"), 'throw new Error("untrusted extension executed");');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network is forbidden in the SDK smoke test"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const runtime = await ModelRuntime.create({ credentials: { async read() { return undefined; }, async list() { return []; }, async modify() { throw new Error("read-only test credentials"); }, async delete() {} }, modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModels().find((entry) => entry.provider !== "radius");
  assert.ok(model, "locked SDK must expose a static model catalog");
  const result = await createReviewSession({ repositoryPath: repository, trustedStateDir: state,
    modelRuntime: runtime, provider: model.provider, modelId: model.id });
  t.after(() => result.session.dispose());
  assert.deepEqual(result.session.getActiveToolNames(), []);
  assert.equal(result.extensionsResult.errors.length, 0);
  assert.equal(result.session.systemPrompt.includes(marker), false);
  await assert.rejects(createReviewSession({ repositoryPath: repository, trustedStateDir: join(repository, "state"),
    modelRuntime: runtime, provider: model.provider, modelId: model.id }), /outside/);
  await assert.rejects(createReviewSession({ repositoryPath: repository, trustedStateDir: state,
    modelRuntime: runtime, provider: "missing-provider", modelId: "missing-model" }), /not registered/);
});
