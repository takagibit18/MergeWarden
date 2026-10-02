import type { SnapshotStore } from '../snapshot/store.ts';
import { matchDeclarations, type DeclarationChange } from './declarations.ts';
/** Both arms parse exactly the same immutable source, independently of Graph. */
export async function snapshotChanges(store: SnapshotStore): Promise<DeclarationChange[]> {
  const modulePath='../../integrations/tree-sitter/src/python-extractor.ts';
  const {PythonTreeSitterExtractor}=await import(modulePath);
  const parser=await PythonTreeSitterExtractor.create();
  try {
    const result:DeclarationChange[]=[];
    for(const path of store.manifest.changedPaths.filter(p=>p.endsWith('.py'))) {
      const parse=async(revision:'base'|'head')=>store.manifest[revision][path]?.status==='text'
        ?parser.declarations(path,await store.text(revision,path)):{declarations:[],parseComplete:!store.manifest[revision][path]};
      const base=await parse('base'),head=await parse('head');
      result.push(...matchDeclarations(base.declarations,head.declarations,store.manifest.identity.id,base.parseComplete&&head.parseComplete));
    }
    return result;
  } finally {parser.dispose();}
}
