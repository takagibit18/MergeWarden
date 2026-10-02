// Offline proposals only. Inputs are the frozen public feature row and existing
// weak-signal count; this module cannot read labels, repository names or targets.
export const CANDIDATE_RULES=Object.freeze([
  {id:'WEAK_SIGNAL_PROMOTION',predicates:['existingWeakSignal','noUntouchedSource'],complexity:2},
  {id:'DOWNSTREAM_ARGUMENT_CHANGE',predicates:['argumentForwardingChanged','noUntouchedSource'],complexity:2},
  {id:'RETURN_BEHAVIOR_CHANGE',predicates:['returnExpressionChanged','noUntouchedSource'],complexity:2},
  {id:'ITERATION_SHAPE_CHANGE',predicates:['iterationShapeChange','noUntouchedSource'],complexity:2},
  {id:'DECORATOR_CONTRACT_CHANGE',predicates:['decoratorChanged','noUntouchedSource'],complexity:2},
  {id:'CALL_CHANGE_CONTEXT_GAP',predicates:['callAddedOrRemoved','noUntouchedSource'],complexity:2},
  {id:'METACLASS_CONTRACT_CHANGE',predicates:['languageMetaclassAssignmentChanged','noUntouchedSource'],complexity:2}
]);
const positive=v=>v===true||(typeof v==='number'&&v>0);
function metaclassChanged(evidence){
  return (evidence??[]).some(h=>{
    const values=side=>(h[side]??[]).filter(n=>n.type==='assignment'&&n.fields?.left==='__metaclass__').map(n=>n.value).sort();
    return JSON.stringify(values('before'))!==JSON.stringify(values('after'));
  });
}
export function predicates(feature,weakSignalCount=0){
  return {existingWeakSignal:positive(weakSignalCount),noUntouchedSource:feature.search?.newUntouchedSourceReached===0,
    argumentForwardingChanged:positive(feature.interaction?.argumentForwardingChanged),returnExpressionChanged:positive(feature.behavioral?.returnExpressionChanged),
    iterationShapeChange:positive(feature.behavioral?.iterationShapeChange),decoratorChanged:positive(feature.structural?.decoratorChanged),
    callAddedOrRemoved:positive(feature.structural?.callAdded)||positive(feature.structural?.callRemoved),languageMetaclassAssignmentChanged:metaclassChanged(feature.evidence)};
}
export function matchesRule(rule,feature,weakSignalCount=0){const values=predicates(feature,weakSignalCount);return rule.predicates.every(key=>values[key]===true);}
export function counterfactual(rule,rows){
  return rows.map(({caseId,feature,weakSignalCount,currentTriggered,currentEpisodes})=>({caseId,matched:matchesRule(rule,feature,weakSignalCount),currentTriggered,newlyTriggered:!currentTriggered&&matchesRule(rule,feature,weakSignalCount),routeEpisodes:currentEpisodes+Number(!currentTriggered&&matchesRule(rule,feature,weakSignalCount))}));
}
