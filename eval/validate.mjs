import { safePath, sha256 } from '../src/infrastructure/files.ts';
export function validateCorpus(corpus,lock,bytes){
 if(sha256(bytes)!==lock.sha256)throw Error('Frozen corpus hash mismatch; do not tune gold to model outputs');
 if(corpus.schemaVersion!==1 || typeof corpus.corpusId!=='string' || !corpus.corpusId.trim() || corpus.cases.length!==20)throw Error('Expected named corpus of 20 frozen cases');
 const counts={};const ids=new Set();
 for(const c of corpus.cases){
  if(!/^[a-z0-9-]+$/.test(c.id)||ids.has(c.id))throw Error('Invalid case identity');ids.add(c.id);
  if(!/^[a-f0-9]{40}$/.test(c.baseSha)||!/^[a-f0-9]{40}$/.test(c.headSha)||c.baseSha===c.headSha)throw Error('Expected fixed distinct Git SHAs');
  for(const key of ['repositoryIdentity','behavior','humanRationale','annotationProvenance'])if(typeof c[key]!=='string'||!c[key].trim())throw Error(`Missing ${key}`);
  if(!['clean','defect'].includes(c.expected)||typeof c.crossFile!=='boolean')throw Error('Invalid expected result');
  if((c.expected==='clean')!==(c.expectedFindings.length===0))throw Error('Findings disagree with case label');
  if(c.expected==='clean'?c.severity!=='none':!['critical','high','medium','low'].includes(c.severity))throw Error('Severity disagrees with case label');
  if(c.expectedFindings.some(f=>f.severity!==c.severity))throw Error('Finding severity disagrees with case severity');
  for(const files of [c.baseFiles,c.headFiles])for(const [path,source] of Object.entries(files)){safePath(path);if(typeof source!=='string')throw Error('Source must be frozen text');}
  for(const location of [c.relevantLocation,...c.expectedFindings]){safePath(location.path);if(!Number.isInteger(location.startLine)||!Number.isInteger(location.endLine)||location.startLine<1||location.endLine<location.startLine||!c.headFiles[location.path]||location.endLine>c.headFiles[location.path].trimEnd().split('\n').length)throw Error('Invalid golden location');}
  counts[c.expected]=(counts[c.expected]??0)+1; if(c.expected==='defect')counts[c.category]=(counts[c.category]??0)+1;
 }
 if(JSON.stringify([counts.defect,counts.clean,counts['single-file'],counts['cross-file'],counts['multi-hop'],counts['import-scope']])!=='[12,8,4,4,2,2]')throw Error('Frozen category mix changed');
 return corpus;
}
