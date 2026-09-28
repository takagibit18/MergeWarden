/** Associate native assistant records with audited requests in journal order.
 * A local abort can add an assistant error WITHOUT another provider request.
 * Missing usage on an interrupted real request remains missing, never zero cost.
 */
export function classifyRequests(entries, {termination, report} = {}) {
  const reason = termination?.reason ?? (report?.summary === 'Review tool budget exhausted' ? 'tool_budget'
    : report?.summary === 'Review time budget exhausted' ? 'time_budget' : report?.status === 'cancelled' ? 'cancelled' : undefined);
  const localStop = ['tool_budget','time_budget','cancelled'].includes(reason);
  const requests = [], pending = []; let localCancellationMessages = 0, unmatchedAssistantMessages = 0;
  for (const e of entries) {
    if (e.customType === 'mergewarden.provider-request.v1') {
      const r = {ordinal:e.data.ordinal,status:'missing_response',usageKnown:false};requests.push(r);pending.push(r);continue;
    }
    const m = e.type === 'message' ? e.message : undefined;if (m?.role !== 'assistant') continue;
    const error = ['error','aborted'].includes(m.stopReason);
    const localAbort = localStop && error && (m.stopReason === 'aborted' || m.errorMessage === 'This operation was aborted');
    const usageKnown = Number.isFinite(m.usage?.totalTokens) && m.usage.totalTokens > 0;
    const r = pending.shift();
    if (!r) {
      if (localAbort && !usageKnown) localCancellationMessages++;
      else unmatchedAssistantMessages++;
      continue;
    }
    r.status = localAbort ? 'locally_cancelled' : error ? 'provider_error' : m.stopReason === 'length' ? 'output_limit' : 'responded';
    r.usageKnown = usageKnown;
  }
  const requestOrderValid = requests.every((r,i)=>r.ordinal===i+1);
  return {terminationReason:reason??'unknown',requests:requests.length,requestOutcomes:requests,
    providerErrors:requests.filter(r=>r.status==='provider_error').length,
    interruptedRequests:requests.filter(r=>r.status==='locally_cancelled').length,
    localCancellationMessages,unmatchedAssistantMessages,requestOrderValid,
    requestsMissingUsage:requests.filter(r=>!r.usageKnown).map(r=>r.ordinal),
    usageComplete:requestOrderValid && unmatchedAssistantMessages===0 && requests.length>0 && requests.every(r=>r.usageKnown)};
}
export const shouldPause = r => !r.delivered || r.status !== 'completed' || !!r.observation?.mechanicalBlocker;
