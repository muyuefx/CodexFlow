import type { GraphDefinition } from '../shared/types';
export function layout(g:GraphDefinition):GraphDefinition {
  const ranks=new Map<string,number>();const visiting=new Set<string>();
  function rank(id:string):number { if(ranks.has(id))return ranks.get(id)!; if(visiting.has(id))return 0; visiting.add(id);
    const r=Math.max(0,...g.edges.filter(e=>e.target===id).map(e=>rank(e.source)+1));visiting.delete(id);ranks.set(id,r);return r; }
  const columns=new Map<number,string[]>();g.nodes.forEach(n=>{const r=rank(n.id);columns.set(r,[...(columns.get(r)||[]),n.id]);});
  const height=Math.max(1,...[...columns.values()].map(c=>c.length));
  return {...g,nodes:g.nodes.map(n=>{const r=ranks.get(n.id)!;const col=columns.get(r)!;return {...n,position:{x:60+r*330,y:70+(height-col.length)*102+col.indexOf(n.id)*205}};})};
}
