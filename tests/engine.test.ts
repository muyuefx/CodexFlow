import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {validateDefinition, definitionOf} from '../server/engine.js';
import type {WorkflowDefinition,NodeDefinition,WorkflowRun,Actor,RunCommand} from '../shared/types.js';

function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codexflow-test-'));
  const file=path.join(dir,'说明.md');fs.writeFileSync(file,'# 要求\n\n完成并验证结果。');
  const node=(id:string,extra:Partial<NodeDefinition>={}):NodeDefinition=>({id,title:id,kind:'task',description:'',mdPath:file,references:[],criteria:['产物已验证'],completion:'ai_or_user',position:{x:0,y:0},...extra});
  const edge=(source:string,target:string)=>({id:source+'_'+target,source,target});
  const def:WorkflowDefinition={schemaVersion:1,id:'test',title:'测试流程',description:'',category:'测试',archived:false,revision:0,updatedAt:'',rootGraphId:'main',graphs:[{id:'main',title:'根流程',nodes:[node('a'),node('b'),node('c'),node('d',{completion:'user_only'})],edges:[edge('a','b'),edge('a','c'),edge('b','d'),edge('c','d')]}]};
  const store=new Store(dir);
  const save=(d=def)=>store.saveWorkflow(d,store.workflows().find(x=>x.id===d.id)?.revision||0,randomUUID());
  function cleanup(){store.close();const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('codexflow-test-'));fs.rmSync(resolved,{recursive:true,force:true});}
  return {dir,file,node,edge,def,store,save,cleanup};
}
function command(store:Store,run:WorkflowRun,action:RunCommand['action'],key?:string,actor:Actor='ai',extra:Partial<RunCommand>={}) {
  if(action==='apply')extra={impactToken:(store.impact(run.id) as any).impactToken,...extra};
  return store.command({runId:run.id,expectedRevision:run.revision,operationId:randomUUID(),action,nodeKey:key,...extra},actor);
}
function complete(store:Store,r:WorkflowRun,key:string,actor:Actor='ai') {
  return command(store,r,'complete',key,actor,{evidence:{summary:'已验证并完成',checks:definitionOf(r,key).criteria.map(criterion=>({criterion,passed:true,note:'实际检查通过'})),artifacts:[]}});
}
test('并行汇合、人工门禁、整体结束条件',()=>{
  const f=fixture();try{f.save();let r=startTestRun(f.store,'test',randomUUID());assert.equal(r.nodes.d.status,'pending');
    assert.throws(()=>complete(f.store,r,'d','user'),/不能完成/);
    r=command(f.store,r,'enter','a');r=complete(f.store,r,'a');assert.equal(r.nodes.b.status,'ready');assert.equal(r.nodes.c.status,'ready');
    r=complete(f.store,r,'b');assert.equal(r.nodes.d.status,'pending');r=complete(f.store,r,'c');
    assert.throws(()=>complete(f.store,r,'d'),/必须由用户/);assert.throws(()=>command(f.store,r,'finish',undefined,'ai',{reason:'完成'}),/未完成/);
    r=complete(f.store,r,'d','user');r=command(f.store,r,'finish',undefined,'ai',{reason:'所有成果已检查，人工验收通过'});assert.equal(r.status,'completed');
    assert.throws(()=>command(f.store,r,'retry','a'),/已结束/);
  }finally{f.cleanup();}
});
test('同一操作幂等，竞争上报只接受一次',()=>{
  const f=fixture();try{f.save();const r=startTestRun(f.store,'test',randomUUID());const cmd={runId:r.id,expectedRevision:r.revision,operationId:randomUUID(),action:'enter',nodeKey:'a'};
    const first=f.store.command(cmd,'ai');assert.deepEqual(f.store.command(cmd,'ai'),first);
    assert.throws(()=>f.store.command({...cmd,operationId:randomUUID()},'user'),/状态已变化/);
    assert.throws(()=>f.store.command({...cmd,action:'complete'},'ai'),/操作 ID/);
    assert.equal(f.store.run(r.id).events.filter(e=>e.action==='enter').length,1);
  }finally{f.cleanup();}
});
test('AI 必须提交逐项验收说明，空内容不能伪完成',()=>{
  const f=fixture();try{f.save();const r=startTestRun(f.store,'test',randomUUID());assert.throws(()=>command(f.store,r,'complete','a','ai',{evidence:{summary:'好了',checks:[],artifacts:[]}}),/缺少通过/);assert.equal(f.store.run(r.id).revision,r.revision);}finally{f.cleanup();}
});
test('三层嵌套、重复子流程引用分别执行',()=>{
  const f=fixture();try{f.def.graphs=[{id:'main',title:'根',nodes:[f.node('x',{kind:'subflow',subflowId:'sub'}),f.node('y',{kind:'subflow',subflowId:'sub'})],edges:[]},{id:'sub',title:'子',nodes:[f.node('z',{kind:'subflow',subflowId:'inner'})],edges:[]},{id:'inner',title:'孙',nodes:[f.node('leaf')],edges:[]}];f.save();let r=startTestRun(f.store,'test',randomUUID());
    assert.equal(Object.keys(r.nodes).length,6);r=command(f.store,r,'enter','x');assert.equal(r.nodes['x/z'].status,'ready');assert.equal(r.nodes['y/z'].status,'pending');
    r=command(f.store,r,'enter','x/z');assert.throws(()=>complete(f.store,r,'x'),/子流程/);r=complete(f.store,r,'x/z/leaf');r=complete(f.store,r,'x/z');r=complete(f.store,r,'x');assert.equal(r.nodes.y.status,'ready');assert.equal(r.nodes['y/z/leaf'].status,'pending');
  }finally{f.cleanup();}
});
test('拒绝依赖环、递归子流程、重复节点及无效引用',()=>{
  const f=fixture();try{const cycle=structuredClone(f.def);cycle.graphs[0].edges.push(f.edge('d','a'));assert.throws(()=>validateDefinition(cycle),/依赖环/);
    const recursion=structuredClone(f.def);recursion.graphs[0].nodes[0]={...recursion.graphs[0].nodes[0],kind:'subflow',subflowId:'main'};assert.throws(()=>validateDefinition(recursion),/递归/);
    const dupe=structuredClone(f.def);dupe.graphs[0].nodes.push(dupe.graphs[0].nodes[0]);assert.throws(()=>validateDefinition(dupe),/重复/);
    const bad=structuredClone(f.def);bad.graphs[0].edges[0].target='missing';assert.throws(()=>validateDefinition(bad),/不存在/);
  }finally{f.cleanup();}
});
test('MD 冻结快照、外部修改冲突、两份内容保留',()=>{
  const f=fixture();try{f.save();const r=startTestRun(f.store,'test',randomUUID());const doc=f.store.readDocument(f.file);fs.writeFileSync(f.file,'磁盘新版');assert.equal(f.store.run(r.id).documents[f.file].content,doc.content);
    assert.throws(()=>f.store.saveDocument(f.file,'我的编辑',doc.hash,randomUUID()),/外部修改/);
    assert.equal(fs.readFileSync(f.file,'utf8'),'磁盘新版');const history=f.store.documentHistory(f.file) as any[];assert.ok(history.some(h=>h.content==='我的编辑'));assert.ok(history.some(h=>h.content==='磁盘新版'));
    f.store.saveDocument(f.file,'合并后的内容',f.store.readDocument(f.file).hash,randomUUID());assert.equal(fs.readFileSync(f.file,'utf8'),'合并后的内容');
  }finally{f.cleanup();}
});
test('失效或缺失 MD 阻止启动，草稿仍可保存',()=>{
  const f=fixture();try{f.def.graphs[0].nodes[0].mdPath=path.join(f.dir,'missing.md');f.save();assert.throws(()=>startTestRun(f.store,'test',randomUUID()),/不存在/);assert.equal(f.store.runs().length,0);}finally{f.cleanup();}
});
test('协作暂停到检查点，保存新定义不改当前快照',()=>{
  const f=fixture();try{f.save();let r=startTestRun(f.store,'test',randomUUID());r=command(f.store,r,'enter','a');r=command(f.store,r,'pause',undefined,'user');assert.equal(r.status,'pause_requested');assert.throws(()=>command(f.store,r,'enter','b'),/暂停请求/);
    const changed=f.store.workflow('test');changed.title='新标题';changed.graphs[0].nodes[0].description='新要求';f.save(changed);assert.equal(f.store.run(r.id).definition.title,'测试流程');
    assert.throws(()=>command(f.store,r,'apply',undefined,'user',{targetWorkflowRevision:2}),/确认暂停/);
    r=command(f.store,r,'ack_pause');assert.equal(r.status,'paused');r=command(f.store,r,'apply',undefined,'user',{targetWorkflowRevision:2});assert.equal(r.definition.title,'新标题');assert.equal(r.status,'paused');assert.equal(r.nodes.a.attempt,2);
    r=command(f.store,r,'resume',undefined,'user');assert.equal(r.nodes.a.status,'ready');
  }finally{f.cleanup();}
});
test('仅布局或名称变化保留完成结果；内容变化重置下游',()=>{
  const f=fixture();try{f.save();let r=startTestRun(f.store,'test',randomUUID());r=complete(f.store,r,'a');r=complete(f.store,r,'b');r=command(f.store,r,'pause',undefined,'user');
    let d=f.store.workflow('test');d.graphs[0].nodes[0].title='改名';d.graphs[0].nodes[0].position.x=100;f.save(d);assert.deepEqual(f.store.impact(r.id).affected,[]);
    r=command(f.store,r,'apply',undefined,'user',{targetWorkflowRevision:2});assert.equal(r.nodes.a.status,'completed');assert.equal(r.nodes.b.status,'completed');
    d=f.store.workflow('test');d.graphs[0].nodes[1].criteria=['新增检查'];f.save(d);const impact=f.store.impact(r.id);assert.ok(impact.affected.includes('b'));assert.ok(impact.affected.includes('d'));assert.ok(!impact.affected.includes('a'));assert.ok(!impact.affected.includes('c'));
    r=command(f.store,r,'apply',undefined,'user',{targetWorkflowRevision:3});assert.equal(r.nodes.a.status,'completed');assert.notEqual(r.nodes.b.status,'completed');assert.ok(r.events.some(e=>e.action==='previous_version'));
  }finally{f.cleanup();}
});
test('重做保留旧结果并使下游失效，独立分支保留',()=>{
  const f=fixture();try{f.save();let r=startTestRun(f.store,'test',randomUUID());r=complete(f.store,r,'a');r=complete(f.store,r,'b');r=complete(f.store,r,'c');r=complete(f.store,r,'d','user');r=command(f.store,r,'retry','b','user');assert.equal(r.nodes.b.status,'ready');assert.equal(r.nodes.c.status,'completed');assert.equal(r.nodes.d.status,'pending');assert.equal(r.nodes.b.attempt,2);assert.ok(r.events.some(e=>e.action==='invalidate'));}finally{f.cleanup();}
});
test('服务重启将执行中运行置为待恢复且不自动继续',()=>{
  const f=fixture();f.save();let r=startTestRun(f.store,'test',randomUUID());r=command(f.store,r,'enter','a');f.store.close();const reopened=new Store(f.dir);
  try{r=reopened.run(r.id);assert.equal(r.status,'recovery');assert.equal(r.nodes.a.status,'recovery');assert.throws(()=>complete(reopened,r,'a'),/待恢复/);r=command(reopened,r,'resume',undefined,'user');assert.equal(r.nodes.a.status,'ready');}finally{reopened.close();assert.ok(path.basename(f.dir).startsWith('codexflow-test-'));fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('子阶段改版保留无关兄弟成果，仅使父级与下游失效',()=>{
  const f=fixture();try{
    f.def.graphs=[{id:'main',title:'根',nodes:[f.node('parent',{kind:'subflow',subflowId:'sub'}),f.node('out')],edges:[f.edge('parent','out')]},{id:'sub',title:'子',nodes:[f.node('left'),f.node('right')],edges:[]}];f.save();let r=startTestRun(f.store,'test',randomUUID());
    r=command(f.store,r,'enter','parent');r=complete(f.store,r,'parent/left');r=complete(f.store,r,'parent/right');r=complete(f.store,r,'parent');r=complete(f.store,r,'out');r=command(f.store,r,'pause',undefined,'user');
    const d=f.store.workflow('test');d.graphs[1].nodes[0].description='修订左分支';f.save(d);const impact=f.store.impact(r.id);assert.deepEqual(new Set(impact.affected),new Set(['parent/left','parent','out']));
    r=command(f.store,r,'apply',undefined,'user',{targetWorkflowRevision:2});assert.equal(r.nodes['parent/right'].status,'completed');assert.notEqual(r.nodes.out.status,'completed');
  }finally{f.cleanup();}
});
test('预览后 MD 再变化，拒绝应用过期影响清单',()=>{
  const f=fixture();try{f.save();let r=startTestRun(f.store,'test',randomUUID());r=command(f.store,r,'pause',undefined,'user');const impact=f.store.impact(r.id) as any;fs.writeFileSync(f.file,'预览后修改');assert.throws(()=>command(f.store,r,'apply',undefined,'user',{targetWorkflowRevision:1,impactToken:impact.impactToken}),/重新预览/);assert.equal(f.store.run(r.id).revision,r.revision);}finally{f.cleanup();}
});
test('未引用的子流程文档缺失，不影响有效根流程启动',()=>{
  const f=fixture();try{f.def.graphs.push({id:'unused',title:'未挂载',nodes:[f.node('old',{mdPath:path.join(f.dir,'已移除.md')})],edges:[]});f.save();const r=startTestRun(f.store,'test',randomUUID());assert.equal(Object.keys(r.nodes).length,4);}finally{f.cleanup();}
});

function startTestRun(store:Store,id:string,operationId:string){const r=store.createInstance(id,operationId);return store.command({runId:r.id,expectedRevision:r.revision,operationId:randomUUID(),action:'activate'},'ai');}
