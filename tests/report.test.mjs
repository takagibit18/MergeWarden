import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown } from '../src/engine/reports.ts';
import { snapshot } from './helpers.mjs';
test('rendered reports escape model-controlled links, images and markup',()=>{
  const report={schemaVersion:1,runId:'fixture',snapshot,status:'completed',summary:'![leak](https://example.invalid/private) <img src=x>',findings:[],coverage:{'![path](https://example.invalid)':'done'},publication:'not_requested'};
  const output=markdown(report);
  assert.match(output,/\\!\\\[leak/); assert.doesNotMatch(output,/(?<!\\)!\[|<img/); assert.match(output,/&lt;img/);
});
const ev={snapshotId:snapshot.id,revision:'head',path:'app.py',startLine:1,endLine:2,contentSha256:'a'.repeat(64)};
const legacy={schemaVersion:1,runId:'fixture',snapshot,status:'completed',summary:'Checked ratio.',findings:[{id:'f1',title:'Division by zero',claim:'count may be 0',trigger:'count=0',impact:'crash',severity:'high',evidence:[ev]}],coverage:{'app.py':'done'},publication:'not_requested'};
test('a report without accepted trade-offs renders byte-identically to the pre-ADR 0020 format',()=>{
  assert.equal(markdown(legacy),"# MergeWarden review: completed\n\nRun: fixture\nSnapshot: snapshot-1\n\nChecked ratio.\n\nAdvisory findings. Source integrity checks do not independently prove semantic correctness.\n\n## high: Division by zero\n\ncount may be 0\n\nTrigger: count=0\nImpact: crash\n\n- head app.py:1-2 (SHA-256 "+'a'.repeat(64)+")\n\n## Coverage\n\n- app.py: done\n");
});
test('known and accepted findings render collapsed with Skill revision while model text stays escaped',()=>{
  const folded={...legacy.findings[0],id:'f2',severity:'low',title:'<b>x</b>',acceptedTradeoff:{skillId:'sk_t',revision:2,note:'no [link](https://x.invalid)'}};
  const output=markdown({...legacy,findings:[],knownAccepted:[folded]});
  assert(output.includes('<details><summary>Known and accepted (1)</summary>\n\n### low: &lt;b&gt;x&lt;/b&gt;\n\nAccepted trade-off: Skill sk_t revision 2. no \\[link\\]\\(https://x.invalid\\)'));
  assert.match(output,/<\/details>\n\n## Coverage/);
});
