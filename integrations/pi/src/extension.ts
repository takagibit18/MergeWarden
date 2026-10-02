import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
/** Hook bridge only. Business state changes belong to ReviewController.
 * The executor MUST check policy again; this hook is not a sandbox. */
export function createReviewExtension(allowedTools: ReadonlySet<string>): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (!allowedTools.has(event.toolName)) return { block: true, reason: "Tool is outside the review allowlist" };
      return undefined;
    });
    // Intentionally no agent_end => COMPLETED transition and no graph injection.
  };
}
