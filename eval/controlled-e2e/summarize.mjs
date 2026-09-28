/** Post-run analysis only; this file is identified separately from the execution freeze. */
import assert from 'node:assert/strict';
import {join,resolve,dirname} from 'node:path';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {read,save,hash,identity} from '../microeval/common.mjs';
import {reconcileRequests} from './observe.mjs';
import {readReport} from '../../src/engine/reports.ts';
const out=resolve(process.argv[2]),offline=process.argv.includes('--offline'),dest=offline?join(out,'preflight'):out;
const completed=await read(join(dest,'runs-completed.json')),config=await read(join(out,'run-config.json')),freeze=await read(join(out,'input-freeze.json'));
for(const f of freeze.files)assert.equal(hash(await readFile(f.path)),f.sha256);
const rows=[],requestRows=[],evidenceRows=[];
const strings=x=>typeof x==='string'?[x]:Array.isArray(x)?x.flatMap(strings):x&&typeof x==='object'?Object.values(x).flatMap(strings):[];
for(const job of completed.completed){
 const m=await read(job.path),raw=dirname(job.path),r=await read(join(raw,'result.json')),o=await read(join(raw,'instrumentation.json')),input=await read(config.cases.find(c=>c.id===job.id).path);
 const report=await readReport(input.case.state,m.runId);assert.equal(report.status,m.status);
 const trace=await read(join(raw,'../../traces',job.id+'.json'));
 const requests=[];for(let i=1;i<=m.requests;i++)requests.push(await read(join(raw,`request-${String(i).padStart(3,'0')}.json`)));
 let matchedExecutions=0,executionCursor=0;
 for(const call of trace.calls){const e=o.toolExecutions[executionCursor];if(e&&call.name===e.toolName&&hash(call.args)===hash(e.args)){matchedExecutions++;executionCursor++;}}
 const reconciliation=reconcileRequests(o.audits,o.wireHashes);
 const integrity={reportVerified:true,requestAuditMatches:reconciliation.matches,allRequestsCaptured:requests.length===m.requests,allExecutionsMatched:matchedExecutions===o.toolExecutions.length,allNativeCallsHaveResults:trace.calls.every(c=>c.resultEvent!==undefined),providerAndNativeUsageAgree:m.usage.complete?trace.usage.reportedInputTokens===m.usage.inputTokens&&trace.usage.reportedOutputTokens===m.usage.outputTokens:null};
 const usedInFindings=ref=>trace.calls.filter(c=>c.name==='submit_review'&&c.response?.accepted===true).flatMap(c=>c.args.findings??[]).filter(f=>report.findings.some(r=>r.id===f.id)&&f.evidence.some(e=>e.evidenceRefId===ref)).map(f=>f.id);
 for(const call of trace.calls.filter(c=>c.response?._mergewarden?.evidenceRefId)){
  const delivered=requests.map((req,i)=>strings(req.messages).some(s=>s.includes(call.resultText))?i+1:null).filter(x=>x!==null);
  evidenceRows.push({id:m.id,arm:m.arm,callId:call.id,tool:call.name,args:call.args,evidenceRefId:call.response._mergewarden.evidenceRefId,deliveredInRequests:delivered,usedInFindings:usedInFindings(call.response._mergewarden.evidenceRefId)});
 }
 if(m.arm==='B'){const pack=await read(join(raw,'../../context-packages',job.id+'.json'));for(const source of pack.sources)evidenceRows.push({id:m.id,arm:m.arm,tool:'host_prefetch',path:source.path,startLine:source.startLine,endLine:source.endLine,evidenceRefId:source.evidenceRefId,deliveredInRequests:requests.map((req,i)=>strings(req.messages).some(s=>s.includes(JSON.stringify(pack)))?i+1:null).filter(x=>x!==null),usedInFindings:usedInFindings(source.evidenceRefId)});}
 const row={id:m.id,arm:m.arm,status:m.status,total_seconds:m.latencyMs/1000,first_tool_seconds:m.firstToolExecutionMs===null?null:m.firstToolExecutionMs/1000,requests:m.requests,prepared_requests:reconciliation.prepared,prepared_not_sent:reconciliation.preparedNotSent.length,min_request_output_limit:requests.length?Math.min(...requests.map(r=>r.max_tokens)):null,max_request_output_limit:requests.length?Math.max(...requests.map(r=>r.max_tokens)):null,tool_calls:m.toolCalls,tool_errors:m.toolErrors,source_reads:m.tools.read_source??0,candidate_expansions:m.tools.expand_structural_candidate??0,submit_attempts:m.submitAttempts,submit_accepted:m.submissionOutcomes.filter(s=>s.response?.accepted===true).length,findings:m.findings,packages_delivered:m.packagesDelivered,report_verified:true,input_tokens:m.usage.inputTokens,output_tokens:m.usage.outputTokens,reasoning_tokens:m.usage.reasoningTokens,known_output_tokens:m.usage.knownOutputTokens,usage_complete:m.usage.complete,mechanical_blocker:m.mechanicalBlocker,blockers:m.blockers.join(';'),integrity,summary:m.summary};rows.push(row);
 for(const t of o.transport){let response=null;try{response=await read(join(raw,`response-${String(t.ordinal).padStart(3,'0')}.json`));}catch{}
  const usage=m.usage.rows.find(u=>u.ordinal===t.ordinal),relative=x=>x===null||x===undefined?null:x-t.requestStartedMs;
  requestRows.push({id:m.id,arm:m.arm,ordinal:t.ordinal,status:t.status??null,max_output_tokens:requests[t.ordinal-1]?.max_tokens??null,reasoning_effort:requests[t.ordinal-1]?.reasoning_effort??null,headers_ms:relative(t.headersReceivedMs),first_delta_ms:relative(response?.firstDeltaMs),first_reasoning_ms:relative(response?.firstReasoningMs),first_tool_delta_ms:relative(response?.firstToolDeltaMs),response_ms:relative(response?.endedMs),request_bytes:t.requestBytes??null,response_bytes:response?Buffer.byteLength(response.body):null,history_messages:t.historyMessages??null,input_tokens:usage?.input??null,output_tokens:usage?.output??null,reasoning_tokens:usage?.reasoning??null,reasoning_chars:response?.reasoningChars??null,text_chars:response?.textChars??null,finish_reason:response?.finishEvents.at(-1)?.reason??null,stream_complete:response?.streamComplete??false,saw_done:response?.sawDone??false,parse_errors:response?.parseErrors??null,error:t.error??response?.streamError??null});
 }
}
const csv=records=>{if(!records.length)return '';const cols=Object.keys(records[0]).filter(k=>typeof records[0][k]!=='object'||records[0][k]===null),cell=v=>v===null||v===undefined?'':`"${String(v).replaceAll('"','""')}"`;return '\uFEFF'+cols.join(',')+'\r\n'+records.map(r=>cols.map(c=>cell(r[c])).join(',')).join('\r\n')+'\r\n';};
const summary={offline,scope:'Three historical diagnostic cases; not blinded quality comparison',inputFreezeVerified:true,executionFreezeHash:hash(freeze),analysisProgram:await identity(import.meta.filename),planned:config.runOrder.length,attempted:rows.length,completed:rows.filter(r=>r.status==='completed').length,notRun:completed.notRun,requests:requestRows.length,allUsageComplete:rows.every(r=>r.usage_complete),allObservationChecksPass:rows.every(r=>Object.values(r.integrity).every(v=>v!==false)),rows,requestRows,evidenceRows};
await save(join(dest,'summary.json'),summary);await writeFile(join(dest,'runs.csv'),csv(rows),{flag:'wx'});await writeFile(join(dest,'requests.csv'),csv(requestRows),{flag:'wx'});
const fmt=n=>n===null?'缺失':Number(n).toFixed(1),label=id=>({Q01:'能力契约变更',Q02:'跨文件调用契约',Q03:'连接关闭对照'})[id];
const text=[`# 小规模端到端采样${offline?'（模拟预检）':''}`,'',`固定 3 个历史案例、两种工具方式；本批计划 ${config.runOrder.length} 次，实际 ${rows.length} 次，完整结束 ${summary.completed} 次。真实服务请求 ${offline?0:requestRows.length} 次。没有重跑或中途调参；如有前批失败，见 prior-attempts.json，均保留且不计入本批成功。`,'',
 '| 案例 | 方式 | 状态 | 总耗时（秒） | 首次工具（秒） | 工具 / 错误 | 最终提交接受 | 输入 / 输出 token |',
 '|---|---|---|---:|---:|---:|---:|---:|',...rows.map(r=>`| ${label(r.id)} | ${r.arm==='A'?'文本':'结构导航'} | ${r.status} | ${fmt(r.total_seconds)} | ${fmt(r.first_tool_seconds)} | ${r.tool_calls} / ${r.tool_errors} | ${r.submit_accepted} | ${r.input_tokens??'缺失'} / ${r.output_tokens??'缺失'} |`),'',
 `观测一致性：${summary.allObservationChecksPass?'全部通过':'存在缺口，请检查 summary.json'}。用量完整性：${summary.allUsageComplete?'全部请求均取得完整用量':'存在缺失；缺失值保留为空，已知总量仅为下限'}。`,'',
 '已记录：配置与源码冻结摘要、逐次请求参数和消息、原始流式响应、首段输出与首个工具时间、工具参数与执行耗时、拒绝与错误、结构包交付、源码证据进入后续请求、最终提交接受、原生会话与报告校验。runs.csv 为按次汇总，requests.csv 为逐请求数据，summary.json 含观测一致性与证据交付记录。',
 '', '界限：完成表示审查流程完整且报告已落盘，不表示缺陷判断正确。结构导航由既定调查单元触发，本轮不检验自动选路。历史案例不构成独立盲测，不能估计准确率或图检索增益。低档推理的实际计算量由供应商决定。',
 '',...rows.filter(r=>r.mechanical_blocker||r.status!=='completed').map(r=>`- ${r.id}/${r.arm}：${r.summary}；阻塞分类：${r.blockers||'无机械故障，审查未完成'}。`),...completed.notRun.map(j=>`- ${j.id}/${j.arm}：按停止规则未运行，不计为模型失败。`),''].join('\n');
await writeFile(join(dest,'report.md'),text,{flag:'wx'});
const files=[];async function walk(p){for(const e of await readdir(p,{withFileTypes:true})){if(e.name==='artifact-index.json')continue;const f=join(p,e.name);if(e.isDirectory())await walk(f);else files.push(await identity(f));}}
await walk(dest);await save(join(dest,'artifact-index.json'),{createdAt:new Date().toISOString(),files});
console.log(JSON.stringify({report:join(dest,'report.md'),attempted:summary.attempted,completed:summary.completed,requests:summary.requests,allObservationChecksPass:summary.allObservationChecksPass,allUsageComplete:summary.allUsageComplete}));
