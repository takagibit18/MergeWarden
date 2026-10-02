import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {dirname, resolve} from 'node:path';
import {SnapshotStore} from '../src/snapshot/store.ts';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const read = async path => JSON.parse(await readFile(path, 'utf8'));
export async function save(path, value) {
  await mkdir(dirname(path), {recursive:true});
  await writeFile(path, JSON.stringify(value, null, 2)+'\n', {flag:'wx'});
}
export async function identity(path) { return {path:resolve(path), sha256:hash(await readFile(path))}; }
export async function checkIdentities(items) {
  for (const item of items) if (hash(await readFile(item.path)) !== item.sha256) throw Error('Frozen artifact changed: '+item.path);
}

// Project only completed public text-tool calls before the first structural call,
// host dispatch, or submission. Never expose assistant reasoning/final findings.
// Branch changes are rejected rather than silently stitching unrelated histories.
export async function projectPrefix(path) {
  const stream=createReadStream(path), lines=createInterface({input:stream, crlfDelay:Infinity});
  const calls=new Map(), actions=[]; let previous=null, stoppedAt='end_of_history';
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row=JSON.parse(line);
      if (row.id && row.type!=='session') {
        if (row.parentId!==previous) return {actions:[], stoppedAt:'nonlinear_history'};
        previous=row.id;
      }
      if (row.customType==='mergewarden-host-dispatch-v1' || row.customType==='mergewarden-structural-context-v1') {stoppedAt='host_dispatch';break;}
      if (row.type!=='message') continue;
      const message=row.message;
      if (message.role==='assistant') {
        let stop=false;
        for (const block of message.content??[]) if (block.type==='toolCall') {
          if (!['read_diff','read_source','search_text'].includes(block.name)) {stop=true;stoppedAt=block.name;break;}
          calls.set(block.id, {name:block.name,args:block.arguments,toolCallId:block.id,entryId:row.id});
        }
        if (stop) break;
      }
      if (message.role==='toolResult' && calls.has(message.toolCallId) && !message.isError) {
        const call=calls.get(message.toolCallId);
        if (call.name!==message.toolName) throw Error('Historical tool identity mismatch');
        actions.push({...call,resultEntryId:row.id});calls.delete(message.toolCallId);
      }
    }
  } finally {lines.close();stream.destroy();}
  return {actions,stoppedAt};
}

// No synthesized search queries or semantic summaries. Missing history gets
// complete immutable diff pages, in manifest order, and no model-generated steps.
export async function* prefixObservations(plan) {
  const store=await SnapshotStore.load(plan.state,plan.snapshotId);
  if (plan.actions.length) {
    for (const action of plan.actions) {
      const a=action.args; let result;
      if (action.name==='read_diff') result=await store.diff(a.path,a.offset,a.limit);
      else if (action.name==='read_source') result=await store.source(a.revision,a.path,a.startLine,a.endLine);
      else if (action.name==='search_text') result=await store.search(a.revision,a.query,a.limit);
      else throw Error('Non-public prefix action');
      yield {toolName:action.name,toolCallId:action.toolCallId,input:a,result,isError:false,provenance:{kind:'historical_tool_sequence_replayed',session:plan.prefixSource,entryId:action.resultEntryId}};
    }
  } else {
    let ordinal=0;
    for (const path of store.manifest.changedPaths) {
      let offset=0;
      do {
        const result=await store.diff(path,offset,100);
        yield {toolName:'read_diff',toolCallId:'derived_diff_'+(++ordinal),input:{path,offset,limit:100},result,isError:false,provenance:{kind:'derived_immutable_diff',snapshotId:plan.snapshotId}};
        if (result.nextCursor===undefined) break;
        if (result.nextCursor<=offset) throw Error('Diff did not advance');
        offset=result.nextCursor;
      } while (true);
    }
  }
}
