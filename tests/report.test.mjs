import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown } from '../src/engine/reports.ts';
import { snapshot } from './helpers.mjs';
test('rendered reports escape model-controlled links, images and markup',()=>{
  const report={schemaVersion:1,runId:'fixture',snapshot,status:'completed',summary:'![leak](https://example.invalid/private) <img src=x>',findings:[],coverage:{'![path](https://example.invalid)':'done'},publication:'not_requested'};
  const output=markdown(report);
  assert.match(output,/\\!\\\[leak/); assert.doesNotMatch(output,/(?<!\\)!\[|<img/); assert.match(output,/&lt;img/);
});
