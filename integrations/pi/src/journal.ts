import { closeSync, fsyncSync, openSync, readFileSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ReviewEvent } from "../../../src/domain/contracts.ts";
import type { SessionJournal } from "../../../src/ports/journal.ts";
const NAMESPACE = "mergewarden.review-event.v1";
/** Native CustomEntry projection. Production uses an exclusively opened file and durable=true. */
export class PiSessionJournal implements SessionJournal {
  private manager: SessionManager;
  private durable: boolean;
  private failure: Error | undefined;
  private onFailure: () => void;
  constructor(manager: SessionManager, options: { durable?: boolean; onFailure?: () => void } = {}) {
    this.manager = manager; this.durable = options.durable ?? false; this.onFailure = options.onFailure ?? (() => {});
  }
  /** Also called after native message persistence, using the public agent event subscription. */
  checkpoint(): void {
    if (this.failure) throw this.failure;
    if (!this.durable) return;
    try {
      const file = this.manager.getSessionFile(); if (!file) throw new Error("Persistent session required");
      const fd = openSync(file, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
      const disk = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const expected = [this.manager.getHeader(), ...this.manager.getEntries()];
      if (JSON.stringify(disk) !== JSON.stringify(expected)) throw new Error("Native session integrity mismatch");
    } catch {
      this.failure = new Error("Session persistence failed; this run cannot continue");
      this.onFailure(); throw this.failure;
    }
  }
  async append(event: ReviewEvent): Promise<void> {
    this.checkpoint();
    try { this.manager.appendCustomEntry(NAMESPACE, structuredClone(event)); }
    catch { this.failure = new Error("Session persistence failed; this run cannot continue"); this.onFailure(); throw this.failure; }
    this.checkpoint();
  }
  async readActiveBranch(): Promise<ReviewEvent[]> {
    this.checkpoint();
    return this.manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === NAMESPACE)
      .map(entry => { if (entry.type !== "custom") throw new Error("Unexpected native entry"); return structuredClone(entry.data) as ReviewEvent; });
  }
}
