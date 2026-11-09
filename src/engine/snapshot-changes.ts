import type { SnapshotStore } from '../snapshot/store.ts';
import { matchDeclarations, type DeclarationChange } from './declarations.ts';
import { enabledLanguages, LEGACY_LANGUAGE_IDS, loadExtractor } from '../graph/languages/index.ts';
import type { LoadedExtractor } from '../graph/languages/contracts.ts';
/**
 * Both arms parse exactly the same immutable source, independently of Graph. Each changed path is
 * parsed by the enabled language that owns it, if that language extracts declarations (ADR 0022).
 */
export async function snapshotChanges(store: SnapshotStore, languages: readonly string[] = LEGACY_LANGUAGE_IDS): Promise<DeclarationChange[]> {
  const capable = enabledLanguages(languages).filter(item => item.capabilities.declarations);
  const parsers = new Map<string, LoadedExtractor>();
  try {
    const result:DeclarationChange[]=[];
    for(const path of store.manifest.changedPaths) {
      const language = capable.find(item => item.owns(path)); if (!language) continue;
      let parser = parsers.get(language.id); if (!parser) parsers.set(language.id, parser = await loadExtractor(language));
      if (!parser.declarations) continue;
      const parse=async(revision:'base'|'head')=>store.manifest[revision][path]?.status==='text'
        ?parser!.declarations!(path,await store.text(revision,path)):{declarations:[],parseComplete:!store.manifest[revision][path]};
      const base=await parse('base'),head=await parse('head');
      result.push(...matchDeclarations(base.declarations,head.declarations,store.manifest.identity.id,base.parseComplete&&head.parseComplete));
    }
    return result;
  } finally { for (const parser of parsers.values()) parser.dispose(); }
}
