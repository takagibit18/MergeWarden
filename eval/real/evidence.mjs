import {objectGit} from './adapter.mjs';
import {safePath,sha256} from '../../src/infrastructure/files.ts';
import {digest} from './open-label.mjs';
export async function sourceAnchor(repository,revision,path,startLine,endLine) {
 safePath(path);if(!/^[a-f0-9]{40}$/.test(revision)||!Number.isInteger(startLine)||!Number.isInteger(endLine)||startLine<1||endLine<startLine)throw Error('Invalid source anchor');
 const bytes=await objectGit(repository,['show',`${revision}:${path}`]);
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),lines=text.split('\n');if(lines.at(-1)==='')lines.pop();
 if(endLine>lines.length)throw Error('Anchor exceeds source');
 return {path,startLine,endLine,contentSha256:sha256(lines.slice(startLine-1,endLine).join('\n'))};
}
export async function verifyEvidence(candidate,repository) {
 const c=candidate;
 for(const a of [...c.pythonAnchors,...c.goldenFindings.map(g=>g.sourceAnchor),...(c.contextEvidence??[])]){
  if((await sourceAnchor(repository,c.task.reviewed_sha,a.path,a.startLine,a.endLine)).contentSha256!==a.contentSha256)throw Error('Reviewed source anchor drift');
 }
 for(const g of c.goldenFindings){
  if(g.fixEvidence?.sourceAnchor){const a=g.fixEvidence.sourceAnchor;if((await sourceAnchor(repository,g.fixSha,a.path,a.startLine,a.endLine)).contentSha256!==a.contentSha256)throw Error('Fix source anchor drift');if(g.fixEvidence.verifiedSourceHash!==a.contentSha256)throw Error('Fix receipt drift');}
 }
 return {verified:true,taskSha256:digest(c.task),anchorsSha256:digest([c.pythonAnchors,c.goldenFindings,c.contextEvidence]),verification:'Read exact Git blobs; SHA-256 of source lines; no target code execution'};
}
