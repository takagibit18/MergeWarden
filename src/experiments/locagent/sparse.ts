import snowball from 'snowball-stemmers';
// LocAgent pins bm25s 0.2.3: English stopwords before Snowball, Lucene BM25.
const stemmer = snowball.newStemmer('english');
const stop = new Set('a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with'.split(' '));
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []).filter(t => !stop.has(t)).map(t => stemmer.stem(t));
}
export class SparseIndex {
  private lengths: number[]; private avg: number;
  private postings = new Map<string, Map<number, number>>();
  constructor(documents: string[]) {
    this.lengths = documents.map((text, i) => {
      const tokens = tokenize(text);
      for (const token of tokens) { let row = this.postings.get(token); if (!row) { row = new Map(); this.postings.set(token, row); } row.set(i, (row.get(i) ?? 0) + 1); }
      return tokens.length;
    });
    this.avg = this.lengths.reduce((a,b)=>a+b,0) / (documents.length || 1);
  }
  search(query: string, topK = 10): { index: number; score: number }[] {
    const scores = new Map<number, number>();
    for (const token of tokenize(query)) {
      const row = this.postings.get(token); if (!row) continue;
      const idf = Math.log(1 + (this.lengths.length - row.size + 0.5) / (row.size + 0.5));
      for (const [i, tf] of row) {
        // bm25s Lucene omits the constant (k1+1); preserving that matters for score fidelity.
        const score = Math.fround(idf * tf / (tf + 1.5 * (0.25 + 0.75 * this.lengths[i]! / this.avg)));
        scores.set(i, Math.fround((scores.get(i) ?? 0) + score));
      }
    }
    return [...scores].filter(([,score])=>score>0).map(([index,score])=>({index,score})).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,topK);
  }
  stats(): { documents: number; terms: number; postings: number; tokens: number } {
    let postings=0;for(const row of this.postings.values())postings+=row.size;
    return {documents:this.lengths.length,terms:this.postings.size,postings,tokens:this.lengths.reduce((sum,value)=>sum+value,0)};
  }
}
// RapidFuzz token_set_ratio uses normalized Indel similarity (LCS), NOT Levenshtein.
function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 100;
  const left=[...a],right=[...b];let prev = new Uint32Array(right.length+1);
  for (const ch of left) { const next = new Uint32Array(right.length+1); for(let j=1;j<=right.length;j++)next[j]=ch===right[j-1]?prev[j-1]!+1:Math.max(prev[j]!,next[j-1]!); prev=next; }
  return 200*prev[right.length]!/(left.length+right.length);
}
export function fuzzyScore(query: string, entity: string): number {
  const tokens = (s:string)=>new Set(s.replaceAll('_',' ').replaceAll('-',' ').match(/[\p{L}\p{N}_]+/gu)??[]);
  const a=tokens(query),b=tokens(entity),common=[...a].filter(t=>b.has(t)).sort().join(' ');
  const x=[...a].filter(t=>!b.has(t)).sort().join(' '),y=[...b].filter(t=>!a.has(t)).sort().join(' ');
  if(!a.size||!b.size)return 0;
  if(common&&(!x||!y))return 100;
  const ax=[common,x].filter(Boolean).join(' '),by=[common,y].filter(Boolean).join(' ');
  return Math.max(ratio(ax,by),common?ratio(common,ax):0,common?ratio(common,by):0);
}
