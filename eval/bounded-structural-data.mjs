import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {publishedGraphPath,readGraphEntities,readGraphRelations} from '../src/graph/sqlite-store.ts';
export const read=async p=>JSON.parse(await readFile(p,'utf8'));
export const hash=x=>createHash('sha256').update(x).digest('hex');
export const save=(p,x)=>writeFile(p,JSON.stringify(x,null,2)+'\n',{flag:'wx'});
export const cmp=(a,b)=>a<b?-1:a>b?1:0;
export async function load(state,snapshotId){
 const database=await publishedGraphPath(state,snapshotId),db=new DatabaseSync(database,{readOnly:true});
 let data;
 try{const meta=db.prepare('SELECT * FROM graph_snapshots WHERE snapshot_id=?').get(snapshotId);
 data={snapshotId,generationId:meta.generation_id,generationState:meta.state,graphScope:meta.graph_scope,symbols:readGraphEntities(db,snapshotId),relations:readGraphRelations(db,snapshotId),coverage:JSON.parse(meta.coverage),warnings:JSON.parse(meta.warnings),sources:{}};}finally{db.close();}
 const manifestPath=join(state,'snapshots',snapshotId+'.json'),manifestBytes=await readFile(manifestPath),manifest=JSON.parse(manifestBytes);
 for(const path of new Set(data.symbols.filter(s=>s.kind==='file').map(s=>s.path))){const f=manifest.head[path];if(f?.status==='text')data.sources[path]=await readFile(join(state,'blobs',f.hash),'utf8');}
 return {data,manifest,database,graphSha256:hash(await readFile(database)),snapshotSha256:hash(manifestBytes)};
}
