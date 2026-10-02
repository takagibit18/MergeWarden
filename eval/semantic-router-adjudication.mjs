import {scorePrimary} from './semantic-router/scoring.mjs';
import {parseDecision} from './semantic-router/parse.mjs';
/** Post-freeze measurement audit. Never modifies or repairs a prediction.
 * An incomplete transport does not erase an already decisive observed failure.
 * Conversely an unavailable response is never assumed correct or incorrect.
 */
export function adjudicatePrimary(rawResponses,labels){
  const automated=scorePrimary(rawResponses,labels);
  const formats=rawResponses.map(r=>({caseId:r.caseId,status:r.parsed.status==='PROVIDER_FAILURE'&&!r.rawText?'UNAVAILABLE':parseDecision(r.rawText).status}));
  const formatFailures=formats.filter(f=>f.status==='FORMAT_FAILURE').length;
  const unavailable=label=>rawResponses.filter(r=>r.parsed.status==='PROVIDER_FAILURE'&&labels.find(l=>l.alias===r.caseId)?.label===label).length;
  const maxPositiveCorrect=automated.confusion.TP+unavailable('SHOULD_ESCALATE'),maxNegativeCorrect=automated.confusion.TN+unavailable('SHOULD_NOT_ESCALATE');
  const hasObservedOutput=rawResponses.some(r=>r.parsed.status==='VALID'||!!r.rawText);
  const decisiveFailure=hasObservedOutput&&(maxPositiveCorrect<2||maxNegativeCorrect<4||automated.confusion.FP>1||formatFailures>0);
  const gate=decisiveFailure?'FAIL':automated.gate;
  return {gate,capability:gate==='FAIL'?'SEMANTIC ROUTER CAPABILITY NOT PROVEN':automated.capability,automatedCompletenessGate:automated.gate,confusion:{...automated.confusion,FORMAT_FAILURE:formatFailures},formats,maxPositiveCorrect,maxNegativeCorrect,decisiveFailure,predictionsChanged:false};
}
