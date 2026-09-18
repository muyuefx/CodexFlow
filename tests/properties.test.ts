import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store';
import {validateDefinition,expand} from '../server/engine';
import {resolvedInputs} from '../shared/properties';
import {nodeHandoff} from '../shared/node-handoff';
import type {NodeDefinition,WorkflowDefinition,WorkflowRun,RunCommand} from '../shared/types';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=';
function setup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'flow-inputs-'));const md=path.join(dir,'task.md');fs.writeFileSync(md,'# 验证任务');let store=new Store(dir);
 const node=(id:string,extra:Partial<NodeDefinition>={}):NodeDefinition=>({id,title:id,kind:'task',description:'简短说明',criteria:['通过'],completion:'ai_or_user',position:{x:0,y:0},references:[],mdPath:md,...extra});
 const def:WorkflowDefinition={id:'inputs',title:'任意可配置流程',description:'',category:'测试',schemaVersion:1,revision:0,updatedAt:'',archived:false,rootGraphId:'main',graphs:[{id:'main',title:'主线',nodes:[node('batch',{kind:'subflow',subflowId:'child',properties:[{id:'count',label:'数量',type:'number',integer:true,min:1,max:100,defaultValue:3},{id:'goal',label:'目标',type:'textarea',required:true}],inputValues:{goal:'独立目标'},repeat:{propertyId:'count',mode:'parallel'}}),node('join')],edges:[{id:'edge',source:'batch',target:'join'}]},{id:'child',title:'每份任务',nodes:[node('work')],edges:[]}]};
 const save=(d=def)=>store.saveWorkflow(d,store.workflows().find(x=>x.id===d.id)?.revision||0,randomUUID());
 const cmd=(r:WorkflowRun,action:RunCommand['action'],nodeKey?:string,extra:any={})=>store.command({runId:r.id,expectedRevision:r.revision,operationId:randomUUID(),action,nodeKey,...extra},'ai');
 const complete=(r:WorkflowRun,k:string)=>cmd(r,'complete',k,{evidence:{summary:'已检查',checks:[{criterion:'通过',passed:true,note:'实际通过'}],artifacts:[]}});
 return {dir,md,node,def,get store(){return store;},save,cmd,complete,restart(){store.close();store=new Store(dir);},cleanup(){store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('flow-inputs-'));fs.rmSync(dir,{recursive:true,force:true});}};
}
test('属性默认值与填写值独立，必填与类型校验覆盖保存和运行',()=>{const f=setup();try{
 const n=f.def.graphs[0].nodes[0];n.properties!.push({id:'enabled',label:'开关',type:'boolean',defaultValue:true});n.inputValues!.enabled=false;assert.equal(resolvedInputs(n).enabled,false);assert.equal(resolvedInputs(n).count,3);
 n.inputValues!.count=4;assert.equal(resolvedInputs(n).count,4);assert.equal(n.properties![0].defaultValue,3);
 n.inputValues!.count='4';assert.throws(()=>f.save(),/数字/);n.inputValues!.count=4;
 n.inputValues!.goal='';f.save();assert.throws(()=>startTestRun(f.store,'inputs',randomUUID()),/请填写/);
 n.inputValues!.goal='需要四份';f.save();const run=startTestRun(f.store,'inputs',randomUUID());assert.equal(run.nodes.batch.inputs?.count,4);assert.equal(run.nodes.batch.inputs?.enabled,false);
 f.restart();assert.equal(f.store.run(run.id).nodes.batch.inputs?.count,4);assert.equal(f.store.run(run.id).status,'recovery');
}finally{f.cleanup();}});
test('批量子流程 3 改 4 独立展开，所有分支完成才可汇合',()=>{const f=setup();try{
 f.save();const old=startTestRun(f.store,'inputs',randomUUID());assert.equal(old.nodes.batch.children.length,3);
 const d=f.store.workflow('inputs');d.graphs[0].nodes[0].inputValues!.count=4;f.save(d);let r=startTestRun(f.store,'inputs',randomUUID());assert.equal(r.nodes.batch.children.length,4);assert.equal(f.store.run(old.id).nodes.batch.children.length,3);
 r=f.cmd(r,'enter','batch');assert.equal(r.nodes['batch/4/work'].status,'ready');r=f.complete(r,'batch/1/work');assert.equal(r.nodes['batch/2/work'].status,'ready');assert.throws(()=>f.complete(r,'batch'),/子流程/);
 for(let i=2;i<=4;i++)r=f.complete(r,`batch/${i}/work`);r=f.complete(r,'batch');assert.equal(r.nodes.join.status,'ready');
}finally{f.cleanup();}});
test('顺序实例隔离及嵌套计数限制',()=>{const f=setup();try{
 const n=f.def.graphs[0].nodes[0];n.repeat!.mode='sequential';f.save();let r=startTestRun(f.store,'inputs',randomUUID());r=f.cmd(r,'enter','batch');assert.equal(r.nodes['batch/1/work'].status,'ready');assert.equal(r.nodes['batch/2/work'].status,'pending');r=f.complete(r,'batch/1/work');assert.equal(r.nodes['batch/2/work'].status,'ready');
 n.inputValues!.count=0;assert.throws(()=>validateDefinition(f.def),/最小|小于|数量/);n.inputValues!.count=101;assert.throws(()=>validateDefinition(f.def),/最大|大于|数量/);
 n.inputValues!.count=3;n.repeat!.propertyId='missing';assert.throws(()=>validateDefinition(f.def),/整数属性/);
}finally{f.cleanup();}});
test('图片独立保存、资源快照与 MD 快照冻结，暂停应用才刷新输入',()=>{const f=setup();try{
 const source=path.join(f.dir,'source.png');fs.writeFileSync(source,Buffer.from(png,'base64'));const image=f.store.library.importFile(source,randomUUID());fs.writeFileSync(source,'已修改来源');assert.ok(f.store.library.read(image.id).bytes.length>0);
 let resource=f.store.library.save({id:'ref',title:'已有参考',category:'基准',description:'旧版本',imageIds:[image.id],mdPath:f.md,revision:0,archived:false},0,randomUUID());
 const n=f.def.graphs[0].nodes[0];n.properties!.push({id:'ref',label:'参考',type:'resource',resourceCategory:'基准',defaultValue:'ref'},{id:'pictures',label:'参考图',type:'image',defaultValue:[image.id]});f.save();let r=startTestRun(f.store,'inputs',randomUUID());assert.equal(r.inputSnapshots?.resources.ref.description,'旧版本');
 resource=f.store.library.save({...resource,description:'新版'},resource.revision,randomUUID());assert.equal(f.store.context(r.id).run.inputSnapshots?.resources.ref.description,'旧版本');
 r=f.cmd(r,'pause');const impact=f.store.impact(r.id);assert.ok(impact.affected.includes('batch'));assert.ok(impact.affected.includes('join'));
 f.store.library.save({...resource,description:'又更新'},resource.revision,randomUUID());assert.throws(()=>f.cmd(r,'apply',undefined,{targetWorkflowRevision:1,impactToken:(impact as any).impactToken}),/变化/);
 const fresh=f.store.impact(r.id);r=f.cmd(r,'apply',undefined,{targetWorkflowRevision:1,impactToken:(fresh as any).impactToken});assert.equal(r.inputSnapshots?.resources.ref.description,'又更新');
 fs.writeFileSync(f.md,'# 外部变更');assert.ok(f.store.impact(r.id).affected.includes('batch'));assert.equal(r.documents[f.md].content,'# 验证任务');
 fs.writeFileSync(image.path,'损坏');assert.throws(()=>startTestRun(f.store,'inputs',randomUUID()),/外部修改/);
}finally{f.cleanup();}});
test('修改属性值需要重做，界面标签变化保留结果；交接含子流程和未保存输入',()=>{const f=setup();try{
 f.save();let r=startTestRun(f.store,'inputs',randomUUID());r=f.cmd(r,'enter','batch');r=f.complete(r,'batch/1/work');r=f.cmd(r,'pause');r=f.cmd(r,'ack_pause');
 const d=f.store.workflow('inputs');d.graphs[0].nodes[0].properties![0].label='生成几个';f.save(d);assert.deepEqual(f.store.impact(r.id).affected,[]);
 d.graphs[0].nodes[0].inputValues!.count=4;f.save(d);const impact=f.store.impact(r.id);assert.ok(impact.affected.includes('batch/1/work'));r=f.cmd(r,'apply',undefined,{targetWorkflowRevision:(impact as any).targetWorkflowRevision,impactToken:(impact as any).impactToken});assert.equal(r.nodes.batch.children.length,4);assert.equal(r.nodes['batch/1/work'].status,'pending');assert.equal(r.nodes.batch.inputs?.count,4);
 const prompt=nodeHandoff(d,'main','batch',{dirty:true});assert.match(prompt,/未保存编辑/);assert.match(prompt,/"count": 4/);assert.match(prompt,/relatedGraphs/);assert.match(prompt,/我希望修改为/);
}finally{f.cleanup();}});

test('全局约束版本隔离、嵌套实例继承、暂停应用及旧结果保留',()=>{const f=setup();try{
 f.def.globalConstraints='比较 SOP 与 VEX 的适用性和性能';f.save();
 const other={...structuredClone(f.def),id:'other',globalConstraints:'独立要求'};f.save(other);
 let r=startTestRun(f.store,'inputs',randomUUID());r=f.cmd(r,'enter','batch');r=f.complete(r,'batch/1/work');
 const d=f.store.workflow('inputs');d.globalConstraints='关键耗时步骤核实性能，选择合适的 SOP 或 VEX';f.save(d);
 let context=f.store.context(r.id);assert.equal(context.globalConstraints,f.def.globalConstraints);assert.equal(context.nodeInputs['batch/1/work'].parentKey,'batch');assert.match(context.constraintInstruction,/批量实例/);
 assert.equal(f.store.workflow('other').globalConstraints,'独立要求');
 r=f.cmd(r,'pause');r=f.cmd(r,'ack_pause');const impact=f.store.impact(r.id);
 assert.deepEqual(new Set(impact.affected),new Set(Object.keys(r.nodes)));assert.deepEqual((impact as any).globalConstraints,{before:f.def.globalConstraints,after:d.globalConstraints});
 d.globalConstraints+='，保留检查依据';f.save(d);
 assert.throws(()=>f.cmd(r,'apply',undefined,{targetWorkflowRevision:(impact as any).targetWorkflowRevision,impactToken:(impact as any).impactToken}),/变化|版本/);
 const fresh=f.store.impact(r.id);r=f.cmd(r,'apply',undefined,{targetWorkflowRevision:(fresh as any).targetWorkflowRevision,impactToken:(fresh as any).impactToken});
 assert.equal(r.status,'paused');assert.equal(r.nodes['batch/1/work'].status,'pending');assert.equal(r.nodes['batch/1/work'].attempt,2);
 assert.ok(JSON.stringify(r.events).includes('已检查'));assert.ok(JSON.stringify(r.events).includes(f.def.globalConstraints!));
 assert.equal(f.store.context(r.id).globalConstraints,d.globalConstraints);
 assert.match(nodeHandoff(d,'main','batch'),/关键耗时步骤核实性能/);
 f.restart();assert.equal(f.store.workflow('inputs').globalConstraints,d.globalConstraints);assert.equal(f.store.context(r.id).globalConstraints,d.globalConstraints);
 d.globalConstraints='';f.save(d);assert.equal(f.store.impact(r.id).affected.length,Object.keys(r.nodes).length);
 assert.equal(f.store.context(r.id).globalConstraints,r.definition.globalConstraints);
}finally{f.cleanup();}});

test('旧流程没有约束仍兼容，空值不触发重做，约束长度校验拒绝覆盖',()=>{const f=setup();try{
 f.save();const r=startTestRun(f.store,'inputs',randomUUID());assert.equal(f.store.context(r.id).globalConstraints,'');
 const d=f.store.workflow('inputs');d.globalConstraints='';f.save(d);assert.deepEqual(f.store.impact(r.id).affected,[]);
 d.globalConstraints='字'.repeat(20001);assert.throws(()=>f.save(d),/全局约束/);assert.equal(f.store.workflow('inputs').globalConstraints,'');
}finally{f.cleanup();}});

function startTestRun(store:Store,id:string,operationId:string){const r=store.createInstance(id,operationId);return store.command({runId:r.id,expectedRevision:r.revision,operationId:randomUUID(),action:'activate'},'ai');}

test('本次输入独立冻结；模板改名和改版不覆盖实例填写',()=>{const f=setup();try{
 const template=f.save();const options={name:'四个衍生岛',expectedWorkflowRevision:template.revision,inputs:{main:{batch:{count:4,goal:'本次目标'}}}};
 let r=f.store.createInstance('inputs',randomUUID(),undefined,options);
 assert.equal(r.status,'prepared');assert.equal(r.nodes.batch.children.length,4);assert.equal(r.nodes.batch.inputs?.goal,'本次目标');
 assert.equal(f.store.workflow('inputs').graphs[0].nodes[0].inputValues?.goal,'独立目标');
 assert.equal(f.store.workflow('inputs').graphs[0].nodes[0].inputValues?.count,undefined);
 const other=f.store.createInstance('inputs',randomUUID(),undefined,{inputs:{main:{batch:{count:2}}}});assert.equal(other.nodes.batch.children.length,2);assert.equal(f.store.run(r.id).nodes.batch.children.length,4);
 const edited=f.store.workflow('inputs');edited.title='新版名称';edited.graphs[0].nodes[0].inputValues!.count=6;f.save(edited);
 assert.throws(()=>f.store.createInstance('inputs',randomUUID(),undefined,options),/模板已变化/);
 r=f.cmd(r,'activate');r=f.cmd(r,'pause');const impact=f.store.impact(r.id);assert.deepEqual(impact.affected,[]);
 r=f.cmd(r,'apply',undefined,impact);assert.equal(r.nodes.batch.inputs?.count,4);assert.equal(r.nodes.batch.inputs?.goal,'本次目标');assert.equal(r.status,'paused');assert.equal(r.definition.title,'新版名称');
}finally{f.cleanup();}});
