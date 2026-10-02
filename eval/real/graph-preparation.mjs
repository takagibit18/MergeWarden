import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {SqliteCodeGraph,DEFAULT_GRAPH_BUDGET,GRAPH_SCHEMA_VERSION,GRAPH_POLICY_VERSION,PARSER_VERSION} from '../../src/graph/sqlite-store.ts';
import {RESOLVER_VERSION} from '../../src/graph/python-resolver.ts';
import {digest} from './open-label.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
export const currentRuntimeCommit=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
const stableEntries=entries=>[...entries].sort((a,b)=>a.caseId.localeCompare(b.caseId,'en'));

export async function prepareGraphCases(cases,{kind,output,runtimeCommit=currentRuntimeCommit()}={}){
 if(!['reserve','formal','benchmark'].includes(kind)||!output||!cases.length)throw Error('Invalid graph preparation request');
 const entries=[];
 for(const item of cases){
  const built=await SqliteCodeGraph.open(item.store,{scope:'core'});built.graph.close();
  const hot=await SqliteCodeGraph.openPublishedOnly(item.store,{scope:'core'});hot.graph.close();
  const m=hot.manifest;
  entries.push({caseId:item.caseId,repository:item.repository,snapshotId:item.store.manifest.identity.id,graphSchemaVersion:GRAPH_SCHEMA_VERSION,resolverVersion:RESOLVER_VERSION,parserVersion:PARSER_VERSION,policyVersion:GRAPH_POLICY_VERSION,scope:m.scope,budget:m.budget,generationId:m.generationId,generationState:m.generationState,coverage:m.coverage,warnings:m.warnings,generationBytes:m.databaseBytes,checkpointBytes:hot.metrics.storage.checkpointBytes,preparedAt:new Date().toISOString(),runtimeCommit});
 }
 const body={schemaVersion:1,kind:'graph-preparation',selectionKind:kind,graphMode:'prepared_only',runtimeCommit,entries:stableEntries(entries)};
 const graphPreparationSha256=digest(body),receipt={...body,graphPreparationSha256};
 await writeFile(resolve(output),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
 return receipt;
}

export async function readGraphPreparation(path){
 const receipt=JSON.parse(await readFile(resolve(path),'utf8')),copy={...receipt};delete copy.graphPreparationSha256;
 if(receipt.kind!=='graph-preparation'||receipt.graphMode!=='prepared_only'||digest(copy)!==receipt.graphPreparationSha256)throw Error('Graph preparation receipt drift');
 return receipt;
}

export async function verifyPreparedCases(receipt,cases,{kind,runtimeCommit=currentRuntimeCommit()}={}){
 if(receipt.selectionKind!==kind||receipt.runtimeCommit!==runtimeCommit)throw Error('Graph preparation runtime/selection drift');
 const expected=new Map(receipt.entries.map(row=>[row.caseId,row]));
 if(expected.size!==receipt.entries.length||expected.size!==cases.length)throw Error('Graph preparation case set drift');
 for(const item of cases){
  const row=expected.get(item.caseId);if(!row||row.repository!==item.repository||row.snapshotId!==item.store.manifest.identity.id)throw Error('Graph preparation task identity drift');
  const opened=await SqliteCodeGraph.openPublishedOnly(item.store,{scope:'core'});opened.graph.close();
  const m=opened.manifest;
  if(row.graphSchemaVersion!==GRAPH_SCHEMA_VERSION||row.resolverVersion!==RESOLVER_VERSION||row.parserVersion!==PARSER_VERSION||row.policyVersion!==GRAPH_POLICY_VERSION||row.scope!=='core'||JSON.stringify(row.budget)!==JSON.stringify(DEFAULT_GRAPH_BUDGET)||row.generationId!==m.generationId||row.generationState!==m.generationState||JSON.stringify(row.coverage)!==JSON.stringify(m.coverage)||row.generationBytes!==m.databaseBytes)throw Error('Prepared graph generation drift');
 }
 return true;
}
