import test from 'node:test';
import assert from 'node:assert/strict';
import {CANDIDATE_RULES,matchesRule,counterfactual} from '../eval/route-candidate-rules.mjs';
test('offline proposal requires observed zero source and counts only new episodes',()=>{
  const rule=CANDIDATE_RULES.find(r=>r.id==='DOWNSTREAM_ARGUMENT_CHANGE');
  const feature={search:{newUntouchedSourceReached:0},interaction:{argumentForwardingChanged:true}};
  assert.equal(matchesRule(rule,feature),true);assert.equal(matchesRule(rule,{...feature,search:{}}),false);
  assert.equal(matchesRule(rule,{...feature,search:{newUntouchedSourceReached:1}}),false);
  const rows=[{caseId:'one',feature,currentTriggered:true,currentEpisodes:1},{caseId:'two',feature,currentTriggered:false,currentEpisodes:0}];
  assert.deepEqual(counterfactual(rule,rows).map(r=>[r.newlyTriggered,r.routeEpisodes]),[[false,1],[true,1]]);
  assert.deepEqual(counterfactual(rule,rows),counterfactual(rule,rows.map(r=>({...r,privateLabel:'SHOULD_NOT_ESCALATE',repository:'anything'}))));
});
test('language metaclass proposal uses changed AST assignments, not comments or names',()=>{
  const rule=CANDIDATE_RULES.find(r=>r.id==='METACLASS_CONTRACT_CHANGE');
  const node={type:'assignment',fields:{left:'__metaclass__'},value:'__metaclass__ = Factory'};
  const base={search:{newUntouchedSourceReached:0},evidence:[{before:[node],after:[]}]};
  assert.equal(matchesRule(rule,base),true);
  assert.equal(matchesRule(rule,{...base,evidence:[{before:[node],after:[node]}]}),false);
  assert.equal(matchesRule(rule,{...base,evidence:[{before:[{...node,type:'comment'}],after:[]}]}),false);
});
