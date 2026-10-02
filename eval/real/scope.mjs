import {commitFacts} from './cache.mjs';
import {digest} from './open-label.mjs';

/** Legacy published-path preflight. A match is not semantic admission. */
export function sourceReviewPaths(candidate,reviewedSha) {
 if(candidate.source==='ccrab_retained'){
  let commit=candidate.source_record.commit_to_review;if(typeof commit==='string')commit=JSON.parse(commit);
  if(commit?.head_commit!==reviewedSha||typeof commit.patch_to_review!=='string')return null;
  const matches=commit.patch_to_review.split('\n').filter(s=>s.startsWith('diff --git ')).map(s=>/^diff --git a\/(.+) b\/\1$/.exec(s));
  if(!matches.length||matches.some(m=>!m))return null;return [...new Set(matches.map(m=>m[1]))].sort();
 }
 if(candidate.source==='swrbench'){
  let commits=candidate.source_record.pr_commits;if(typeof commits==='string')commits=JSON.parse(commits);
  if(!Array.isArray(commits)||commits.length!==1||commits[0].sha!==reviewedSha||!Array.isArray(commits[0].diff))return null;
  const paths=commits[0].diff.map(d=>d.file);return paths.length&&paths.every(p=>typeof p==='string')?[...new Set(paths)].sort():null;
 }
 return null;
}
export function compareSourceScope(candidate,reviewedSha,actualChangedPaths){
 const expected=sourceReviewPaths(candidate,reviewedSha);if(!expected)return {status:'unknown',reason:'Published review scope cannot be derived safely; manual audit required'};
 const actual=[...new Set(actualChangedPaths)].sort(),extraPaths=actual.filter(p=>!expected.includes(p)),missingPaths=expected.filter(p=>!actual.includes(p));
 return {status:extraPaths.length||missingPaths.length?'mismatch':'paths_match_requires_hunk_and_semantic_audit',expectedPaths:expected,actualPaths:actual,extraPaths,missingPaths};
}

export function validateHistoryProof(proof,ancestor,descendant) {
 if(!proof||proof.ancestor!==ancestor||proof.descendant!==descendant||!Array.isArray(proof.commits)||!proof.commits.length||proof.sha256!==digest(proof.commits))throw Error('Invalid history proof');
 const cs=proof.commits;
 if(cs[0].sha!==descendant||cs.at(-1).sha!==ancestor||new Set(cs.map(c=>c.sha)).size!==cs.length)throw Error('History endpoints/cycle');
 for(let i=0;i<cs.length;i++){
  const c=cs[i];
  if(!/^[a-f0-9]{40}$/.test(c.sha)||!/^[a-f0-9]{64}$/.test(c.contentSha256)||!Number.isFinite(Date.parse(c.committedAt))||!Array.isArray(c.parents)||c.parents.some(p=>!/^[a-f0-9]{40}$/.test(p))||(i+1<cs.length&&!c.parents.includes(cs[i+1].sha)))throw Error('Broken history parent chain');
 }
 return proof;
}

/** Read raw parent headers, including shallow-boundary commits. Never infer
 * ancestry from timestamps, GitHub ordering, or a smaller diff. */
export async function ancestryProof(repository,ancestor,descendant,{signal,maxCommits=2048}={}) {
 const queue=[[descendant,[]]],seen=new Set();
 while(queue.length){
  signal?.throwIfAborted();const [sha,path]=queue.shift();
  if(seen.has(sha))continue;seen.add(sha);
  if(seen.size>maxCommits)throw Error('History verification limit exceeded');
  let facts;try{facts=await commitFacts(repository,sha,signal);}catch{continue;}
  const next=[...path,facts];if(sha===ancestor)return {ancestor,descendant,commits:next,sha256:digest(next)};
  for(const parent of facts.parents)queue.push([parent,next]);
 }
 throw Error('Ancestry not established from available exact Git objects');
}

export async function verifyScopeHistory(repository,scope,{signal}={}) {
 const baseToHead=await ancestryProof(repository,scope.selectedBaseSha,scope.selectedReviewedSha,{signal});
 if(scope.firstPrCommit&&!baseToHead.commits.some(c=>c.sha===scope.firstPrCommit.sha))throw Error('Selected head is outside the first PR commit history');
 const introduction=scope.issueIntroducingCommit?await ancestryProof(repository,scope.issueIntroducingCommit,scope.selectedReviewedSha,{signal}):null;
 const fix=scope.fixCommit?await ancestryProof(repository,scope.selectedReviewedSha,scope.fixCommit,{signal}):null;
 return {method:'exact Git commit parent chain',baseToHead,introduction,fix};
}
