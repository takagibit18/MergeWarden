import {tokenize} from './sparse.ts';
const unique=(xs:readonly string[])=>[...new Set(xs)].sort();
// Identifier/path normalization shared by query and metadata documents. No field boosts.
export function lexicalTokens(text:string):string[]{
  const words=text.match(/[A-Za-z_][A-Za-z_0-9]*/g)??[];
  return unique(words.flatMap(w=>{
    const composite=w.replace(/^_+|_+$/g,'').toLowerCase();
    const parts=w.replace(/([A-Z]+)([A-Z][a-z])/g,'$1 $2').replace(/([a-z0-9])([A-Z])/g,'$1 $2').split(/[_\s]+/).map(s=>s.toLowerCase());
    return [composite,...parts].filter(s=>s.length>=2);
  }));
}
const keywords=new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
/** Conservative lexical scan: skip all comments and strings, including multiline strings. */
export function diffIdentifiers(lines:readonly string[]):string[]{
  const identifiers:string[]=[];
  for(const side of ['old','new']){
    const code=lines.filter(l=>!l.startsWith('---')&&!l.startsWith('+++')&&!l.startsWith('@@')&&(l.startsWith(' ')||l.startsWith(side==='old'?'-':'+'))).map(l=>l.slice(1)).join('\n');
    let i=0;
    while(i<code.length){
      const ch=code[i]!;
      if(ch==='#'){while(i<code.length&&code[i]!=='\n')i++;continue;}
      if(ch==='"'||ch==="'"){
        const delimiter=code.slice(i,i+3)===ch.repeat(3)?ch.repeat(3):ch;i+=delimiter.length;
        while(i<code.length&&!code.startsWith(delimiter,i)){if(code[i]==='\\')i++;i++;}i+=delimiter.length;continue;
      }
      if(/[A-Za-z_]/.test(ch)){
        const start=i++;while(i<code.length&&/[A-Za-z_0-9]/.test(code[i]!))i++;
        const word=code.slice(start,i);
        // String prefixes are not identifiers. Literal contents remain excluded.
        if(!keywords.has(word)&&!(/^[rubf]{1,2}$/i.test(word)&&['"',"'"].includes(code[i]??'')))identifiers.push(word);
      }else i++;
    }
  }
  return unique(identifiers);
}
export interface InvestigationObservation {kind:'diff'|'changed_path'|'anchor'|'route'|'search_query'|'hint';provenance:string;text?:string;lines?:readonly string[]}
export function buildInvestigationQuery(observations:readonly InvestigationObservation[]){
  const sources=observations.map(o=>({kind:o.kind,provenance:o.provenance,tokens:lexicalTokens(o.kind==='diff'?diffIdentifiers(o.lines??[]).join(' '):o.text??'')})).sort((a,b)=>a.provenance<b.provenance?-1:a.provenance>b.provenance?1:0);
  const tokens=unique(sources.flatMap(s=>s.tokens));
  // Snowball can collapse two distinct surface tokens. Keep one stable representative
  // per effective term so repeated observations cannot multiply query frequency.
  const representatives=new Map<string,string>();for(const t of tokens)for(const term of tokenize(t))if(!representatives.has(term))representatives.set(term,t);
  const bm25Tokens=[...representatives.keys()].sort(),query=bm25Tokens.map(t=>representatives.get(t)!).join(' ');
  return {tokens,bm25Tokens,query,sources};
}
