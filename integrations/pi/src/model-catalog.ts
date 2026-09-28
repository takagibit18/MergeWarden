import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BIGMODEL } from "./bigmodel.ts";

// Trusted application data in Pi's own registration format. Never load this from
// the repository under review; Pi continues to own all protocol adaptation.
export const CATALOG_REVISION = "pi-0.84.1+mergewarden-20260927";
const additions: Record<string, Parameters<ModelRuntime["registerProvider"]>[1]> = { bigmodel: BIGMODEL };
export function registerModelAdditions(runtime: ModelRuntime): void {
  for (const [id, definition] of Object.entries(additions)) runtime.registerProvider(id, definition);
}
