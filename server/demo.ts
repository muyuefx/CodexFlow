import path from 'node:path';
import fs from 'node:fs';
import type { Store } from './store.js';
import type { NodeDefinition, WorkflowDefinition } from '../shared/types.js';
export function seedDemo(store: Store) {
  if (store.workflows().length) return;
  const docs=path.join(store.root,'documents','welcome'); fs.mkdirSync(docs,{recursive:true});
  const node=(id:string,title:string,x:number,y:number,extra:Partial<NodeDefinition>={}):NodeDefinition=>{
    const mdPath=path.join(docs,id+'.md');
    if (!fs.existsSync(mdPath)) fs.writeFileSync(mdPath,`# ${title}\n\n这是一个可编辑的示例阶段。请将此文档替换为你实际使用的要求。\n\n## 执行要求\n\n- 阅读当前阶段的输入。\n- 完成具体工作，并保留可核实的产物。\n\n## 完成条件\n\n- 已完成本阶段并记录结果。\n`,'utf8');
    return {id,title,kind:'task',description:'',mdPath,references:[],criteria:['已完成本阶段并记录结果'],completion:'ai_or_user',position:{x,y},...extra};
  };
  const edge=(source:string,target:string)=>({id:source+'_'+target,source,target});
  const def:WorkflowDefinition={schemaVersion:1,id:'welcome',title:'从想法到交付',description:'一个可以进入、编辑和运行的示例。先理解流程，再换成你的 MD。',category:'入门示例',archived:false,revision:0,rootGraphId:'main',updatedAt:'',graphs:[
    {id:'main',title:'从想法到交付',nodes:[node('brief','定义目标',40,155),node('research','收集参考',360,45),node('spec','整理要求',360,265),node('build','制作与验证',700,155,{kind:'subflow',subflowId:'production'}),node('review','人工验收',1040,155,{completion:'user_only'})],edges:[edge('brief','research'),edge('brief','spec'),edge('research','build'),edge('spec','build'),edge('build','review')]},
    {id:'production',title:'制作与验证',nodes:[node('draft','制作初稿',40,155),node('quality','质量检查',370,155,{kind:'subflow',subflowId:'quality'}),node('package','整理产物',700,155)],edges:[edge('draft','quality'),edge('quality','package')]},
    {id:'quality',title:'质量检查',nodes:[node('check','核对要求',40,155),node('fix','修正与复验',370,155)],edges:[edge('check','fix')]}
  ]};
  store.saveWorkflow(def,0,'seed-welcome-1');
}
