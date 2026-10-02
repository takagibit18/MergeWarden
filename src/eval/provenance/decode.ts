import { createHash } from "node:crypto";
import { parseToolResult, isObject as object } from "../../engine/tool-result.ts";
type ObjectValue = Record<string, unknown>;
const records = (v: unknown): ObjectValue[] => Array.isArray(v) ? v.filter(object) : [];
export interface TraceIssue {
  kind: string; severity: "fatal" | "warning"; scope: "trace" | "call" | "finding";
  message: string; callId?: string; findingId?: string;
}
export const issue = (kind: string, message: string, callId?: string): TraceIssue => ({ kind, message, severity: callId ? "warning" : "fatal", scope: callId ? "call" : "trace", ...(callId ? { callId } : {}) });
export interface ToolCall {
  id: string; name: string; args: ObjectValue; ordinal: number; callEvent: number; callEntryId: string;
  resultEvent?: number; resultEntryId?: string; response?: ObjectValue; resultText: string; isError: boolean;
  argumentsValid?: boolean;
}
export interface TraceUsage {
  assistantResponses: number; reportedInputTokens: number; reportedOutputTokens: number; reportedTotalTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; interruptedResponses: number; missingUsageResponses: number; incompleteUsage: boolean;
}
export interface DecodedTrace { sha256: string; calls: ToolCall[]; issues: TraceIssue[]; ignoredBranchEntries: number; usage: TraceUsage }

/** Read only model-visible tool calls/results from the last native branch. Never read model self-attribution or thinking. */
export function decodePiTrace(jsonl: string): DecodedTrace {
  const trace: DecodedTrace = { sha256: createHash("sha256").update(jsonl).digest("hex"), calls: [], issues: [], ignoredBranchEntries: 0,
    usage: { assistantResponses: 0, reportedInputTokens: 0, reportedOutputTokens: 0, reportedTotalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, interruptedResponses: 0, missingUsageResponses: 0, incompleteUsage: false } };
  const entries: ObjectValue[] = [];
  for (const [index, line] of jsonl.trim().split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { const entry: unknown = JSON.parse(line); if (!object(entry)) throw Error(); if (entry.type !== "session" && (typeof entry.type !== "string" || typeof entry.id !== "string" || !(entry.parentId === null || typeof entry.parentId === "string"))) throw Error(); entries.push(entry); }
    catch { trace.issues.push(issue("invalid_jsonl", `Invalid native JSONL at line ${index + 1}`)); }
  }
  const indexed = new Map<string, ObjectValue>();
  for (const entry of entries) if (typeof entry.id === "string") {
    if (indexed.has(entry.id)) trace.issues.push(issue("duplicate_entry", "Duplicate native entry ID"));
    indexed.set(entry.id, entry);
  }
  const branch: ObjectValue[] = []; const visited = new Set<string>();
  let entry = entries.findLast(e => typeof e.id === "string");
  while (entry) {
    const id = String(entry.id); if (visited.has(id)) { trace.issues.push(issue("branch_cycle", "Native branch cycle")); break; }
    visited.add(id); branch.push(entry);
    if (entry.parentId === null || entry.parentId === undefined) break;
    entry = indexed.get(String(entry.parentId)); if (!entry) trace.issues.push(issue("missing_parent", "Missing native branch parent"));
  }
  if (!branch.length) trace.issues.push(issue("missing_branch", "No active native branch"));
  trace.ignoredBranchEntries = indexed.size - branch.length; branch.reverse();
  const calls = new Map<string, ToolCall>();
  for (const [event, e] of branch.entries()) {
    if (e.type !== "message") continue;
    if (!object(e.message) || typeof e.message.role !== "string") { trace.issues.push(issue("invalid_message", "Invalid native message structure")); continue; }
    const message = e.message;
    if (message.role === "assistant" && !Array.isArray(message.content)) { trace.issues.push(issue("invalid_message", "Invalid native assistant content")); continue; }
    if (message.role === "assistant") {
      const usage = message.usage; trace.usage.assistantResponses++;
      if (["aborted", "error"].includes(String(message.stopReason))) trace.usage.interruptedResponses++;
      if (!object(usage) || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) trace.usage.missingUsageResponses++;
      else {
        trace.usage.reportedInputTokens += Number(usage.input) + Number(usage.cacheRead) + Number(usage.cacheWrite);
        trace.usage.reportedOutputTokens += Number(usage.output); trace.usage.reportedTotalTokens += Number(usage.totalTokens);
        trace.usage.cacheReadTokens += Number(usage.cacheRead); trace.usage.cacheWriteTokens += Number(usage.cacheWrite);
      }
    }
    if (message.role === "assistant") for (const block of records(message.content)) {
      if (block.type !== "toolCall") continue;
      if (typeof block.id !== "string" || typeof block.name !== "string" || calls.has(block.id)) { trace.issues.push(issue("call_identity", "Invalid/duplicate tool call")); continue; }
      const validArguments = object(block.arguments);
      if (!validArguments) trace.issues.push(issue("invalid_arguments", "Non-object tool arguments; call identity remains intact", block.id));
      const call: ToolCall = { id: block.id, name: block.name, args: validArguments ? block.arguments as ObjectValue : {}, argumentsValid: validArguments, ordinal: trace.calls.length + 1, callEvent: event, callEntryId: String(e.id), resultText: "", isError: false };
      calls.set(call.id, call); trace.calls.push(call);
    }
    if (message.role === "toolResult") {
      const call = calls.get(String(message.toolCallId));
      if (!call || call.resultEvent !== undefined || call.name !== message.toolName) { trace.issues.push(issue("result_identity", "Orphan/duplicate/mismatched tool result")); continue; }
      call.resultEvent = event; call.resultEntryId = String(e.id); call.isError = message.isError === true;
      const decoded = parseToolResult(message.content, true);
      call.resultText = decoded.text; if (decoded.value) call.response = decoded.value;
      if (!decoded.value) trace.issues.push(issue("non_json_result", "Non-JSON tool response", call.id));
    }
  }
  for (const call of trace.calls) if (call.resultEvent === undefined) trace.issues.push(issue("missing_result", "Tool call has no observed result", call.id));
  trace.usage.incompleteUsage = trace.usage.interruptedResponses > 0 || trace.usage.missingUsageResponses > 0;
  return trace;
}
