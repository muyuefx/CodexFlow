import {repeatCount,type PropertyDefinition} from './properties.js';
import type {WorkflowDefinition,NodeDefinition} from './types.js';

export interface BindingNode {nodeKey:string;title:string;spec:NodeDefinition;parentKey?:string;dependencies:string[];children:string[];outputs:PropertyDefinition[]}
// Shared by the editor and server: bindings never add hidden scheduling edges.
export function expandedBindingNodes(def:WorkflowDefinition):Record<string,BindingNode>{
 const nodes:Record<string,BindingNode>={};
 function mount(graphId:string,parentKey?:string,prefix=parentKey?parentKey+'/':'',previous:string[]=[],depth=0):string[]{
  if(depth>32)throw Error('子流程嵌套超过 32 层');
  const graph=def.graphs.find(g=>g.id===graphId);if(!graph)return [];
  const mounted:string[]=[];
  for(const spec of graph.nodes){
   if(Object.keys(nodes).length>=3000)throw Error('展开后的节点超过 3000 个');
   const nodeKey=prefix+spec.id,deps=graph.edges.filter(e=>e.target===spec.id).map(e=>prefix+e.source);
   nodes[nodeKey]={nodeKey,title:spec.title,spec,parentKey,dependencies:deps.length?deps:previous,children:[],outputs:spec.outputProperties||[]};mounted.push(nodeKey);
   if(parentKey)nodes[parentKey].children.push(nodeKey);
   if(spec.kind==='subflow'&&spec.subflowId){let prior:string[]=[];for(let i=1;i<=repeatCount(spec);i++)prior=mount(spec.subflowId,nodeKey,spec.repeat?nodeKey+'/'+i+'/':undefined,spec.repeat?.mode==='sequential'?prior:[],depth+1);}
  }
  return mounted;
 }
 mount(def.rootGraphId);return nodes;
}
export function precedingKeys(nodes:Record<string,BindingNode>,consumerKey:string):Set<string>{
 const complete=new Set<string>();
 function finish(key:string){if(complete.has(key)||!nodes[key])return;complete.add(key);const n=nodes[key];n.dependencies.forEach(finish);n.children.forEach(finish);ancestors(n.parentKey);}
 function ancestors(key?:string){if(!key)return;const n=nodes[key];if(!n)return;n.dependencies.forEach(finish);ancestors(n.parentKey);}
 const consumer=nodes[consumerKey];if(consumer){consumer.dependencies.forEach(finish);ancestors(consumer.parentKey);}complete.delete(consumerKey);return complete;
}
export function bindingCandidates(def:WorkflowDefinition,consumerKey:string){
 const nodes=expandedBindingNodes(def),keys=precedingKeys(nodes,consumerKey);
 return [...keys].filter(k=>nodes[k].outputs.length).map(k=>({nodeKey:k,title:nodes[k].title,outputs:nodes[k].outputs}));
}
export function bindingErrors(def:WorkflowDefinition):string[]{
 const nodes=expandedBindingNodes(def),errors:string[]=[];
 for(const n of Object.values(nodes)){
  const upstream=precedingKeys(nodes,n.nodeKey);
  for(const [id,binding] of Object.entries(n.spec.inputBindings||{})){
   const input=n.spec.properties?.find(p=>p.id===id),source=nodes[binding.nodeKey],output=source?.outputs.find(p=>p.id===binding.outputId);
   if(!input){errors.push(n.nodeKey+' 绑定了不存在的输入：'+id);continue;}
   if(!source||!output){errors.push(n.nodeKey+' 输出来源不存在，批量路径必须指定 iteration：'+binding.nodeKey+'/'+binding.outputId);continue;}
   if(!upstream.has(binding.nodeKey))errors.push(n.nodeKey+' 输出来源必须是已确定先行的上游：'+binding.nodeKey);
   if(input.type!==output.type)errors.push(n.nodeKey+' 绑定属性类型不匹配：'+id);
   if(input.resourceCategory&&input.resourceCategory!==output.resourceCategory)errors.push(n.nodeKey+' 绑定资源分类不匹配：'+id);
  }
 }
 return errors;
}
