import {readFile,rm,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {RealCorpusAdapter} from './real/cache.mjs';
import {writeJson} from '../src/infrastructure/files.ts';

const get=name=>{const i=process.argv.indexOf(name),value=i>=0?process.argv[i+1]:undefined;if(!value)throw Error(`Missing ${name}`);return value;};
const byteLength=value=>Buffer.byteLength(JSON.stringify(value));

async function emptyReferenceDatabase(path){
 await rm(path,{force:true});const db=new DatabaseSync(path);db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE sites(snapshot_id TEXT NOT NULL,site_id TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,resolution TEXT,payload TEXT NOT NULL,PRIMARY KEY(snapshot_id,site_id)); VACUUM");db.close();return (await stat(path)).size;
}

async function main(){
 const cache=resolve(get('--cache')),stateRoot=resolve(get('--state')),profile=JSON.parse(await readFile(resolve(get('--profile')),'utf8')),output=resolve(get('--output')),legacyRoot=resolve(get('--legacy-root'));
 const moduleUrl=pathToFileURL(join(legacyRoot,'integrations/tree-sitter/src/python-extractor.ts')).href;
 const {PythonTreeSitterExtractor}=await import(moduleUrl);let report={schemaVersion:1,method:{legacyCommit:'598c9bc',scope:'exact v4 core indexed files',ordinaryReferenceDefinition:'legacy extractor references array, excluding call sites',factsBytes:'UTF-8 difference between the same per-file facts JSON with references populated versus []',physicalSiteBytes:'incremental SQLite bytes for exact v3 sites columns and primary key; excludes REFERENCES relation rows and page interaction with other tables'},profile:resolve(get('--profile')),startedAt:new Date().toISOString(),results:[]};
 try{report=JSON.parse(await readFile(output,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 for(const item of profile.results){
  if(item.status!=='measured'||report.results.some(row=>row.caseId===item.caseId&&row.status==='measured'))continue;
  const record={caseId:item.caseId,repository:item.repository,reviewedSha:item.reviewedSha,status:'running',startedAt:new Date().toISOString()};report.results=report.results.filter(row=>row.caseId!==item.caseId);report.results.push(record);await writeJson(output,report);
  const database=join(stateRoot,item.caseId,'legacy-reference-sites.sqlite');let extractor;
  try{
   const task={case_id:item.caseId,repository:item.repository,repository_url:`https://github.com/${item.repository}.git`,base_sha:item.baseSha,reviewed_sha:item.reviewedSha,language:'Python',review_context_policy:'repository'};
   const adapter=new RealCorpusAdapter({cache,stateDir:join(stateRoot,item.caseId),configuration:{graphProfileVersion:1}}),{store}=await adapter.materialize(task,{offline:true});
   if(store.manifest.identity.id!==item.snapshotId)throw Error('Snapshot identity differs from graph profile');
   const current=new DatabaseSync(item.core.path,{readOnly:true});let paths;try{paths=current.prepare("SELECT path FROM files WHERE snapshot_id=? AND included=1 AND parse_status IN ('complete','incomplete') ORDER BY path").all(item.snapshotId).map(row=>String(row.path));}finally{current.close();}
   const baselineBytes=await emptyReferenceDatabase(database),siteDb=new DatabaseSync(database),insert=siteDb.prepare('INSERT INTO sites VALUES(?,?,?,?,?,?)');siteDb.exec('BEGIN IMMEDIATE');
   extractor=await PythonTreeSitterExtractor.create();let referenceSites=0,embeddedReferenceBytes=0,payloadBytes=0,maxReferencesInFile=0,maxReferencePath='',parseIncompleteFiles=0;const started=performance.now();
   for(const path of paths){
    const facts=await extractor.extract({snapshotId:item.snapshotId,path,source:await store.text('head',path)});if(!facts.parseComplete)parseIncompleteFiles++;
    const count=facts.references.length;if(count>maxReferencesInFile){maxReferencesInFile=count;maxReferencePath=path;}referenceSites+=count;
    embeddedReferenceBytes+=byteLength(facts)-byteLength({...facts,references:[]});
    for(const site of facts.references){const payload=JSON.stringify(site);payloadBytes+=Buffer.byteLength(payload);insert.run(item.snapshotId,site.id,site.path,site.kind,site.resolution,payload);}
   }
   siteDb.exec('COMMIT; VACUUM');siteDb.close();const populatedBytes=(await stat(database)).size;
   Object.assign(record,{status:'measured',indexedFiles:paths.length,parseIncompleteFiles,referenceSites,embeddedReferenceBytes,payloadBytes,physicalSiteBytes:populatedBytes-baselineBytes,serializedStorageLowerBoundBytes:embeddedReferenceBytes+populatedBytes-baselineBytes,maxReferencesInFile,maxReferencePath,extractionMs:performance.now()-started,finishedAt:new Date().toISOString()});
  }catch(error){record.status='failed';record.error=error instanceof Error?error.message:String(error);record.finishedAt=new Date().toISOString();}
  finally{extractor?.dispose();await rm(database,{force:true});}
  await writeJson(output,report);
 }
 report.finishedAt=new Date().toISOString();await writeJson(output,report);
}

await main();
