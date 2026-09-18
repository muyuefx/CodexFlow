import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {validateDefinition,resolveBoundInputs} from '../server/engine.js';
import {bindingCandidates} from '../shared/output-bindings.js';
import type {NodeDefinition,WorkflowDefinition,WorkflowRun,RunCommand} from '../shared/types.js';

const pixelPng='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=';

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'flow-outputs-'));const md=path.join(dir,'task.md');const png=path.join(dir,'pixel.png');
  fs.writeFileSync(md,'# task');fs.writeFileSync(png,Buffer.from(pixelPng,'base64'));const store=new Store(dir);
  const node=(id:string,extra:Partial<NodeDefinition>={}):NodeDefinition=>({id,title:id,kind:'task',description:'输出测试',criteria:['已验证'],completion:'ai_or_user',position:{x:0,y:0},references:[],mdPath:md,...extra});
  const image={id:'image',label:'成果图',type:'image' as const,required:true};
  const def:WorkflowDefinition={id:'outputs',title:'输出流程',description:'',category:'测试',schemaVersion:1,revision:0,updatedAt:'',archived:false,rootGraphId:'main',graphs:[
    {id:'main',title:'主线',nodes:[node('phase',{kind:'subflow',subflowId:'sub'}),node('consumer',{properties:[{...image}],inputBindings:{image:{nodeKey:'phase/publish',outputId:'image'}}})],edges:[{id:'to-consumer',source:'phase',target:'consumer'}]},
    {id:'sub',title:'子流程',nodes:[node('draft',{outputProperties:[{...image}]}),node('approve',{completion:'user_only'}),node('publish',{outputProperties:[{...image}]})],edges:[{id:'draft-approve',source:'draft',target:'approve'},{id:'approve-publish',source:'approve',target:'publish'}]}
  ]};
  const save=(d=def)=>store.saveWorkflow(d,store.workflows().find(w=>w.id===d.id)?.revision||0,randomUUID());
  const command=(r:WorkflowRun,action:RunCommand['action'],nodeKey?:string,actor:'ai'|'user'='ai',extra:any={})=>store.command({runId:r.id,expectedRevision:r.revision,operationId:randomUUID(),action,nodeKey,...extra},actor);
  const complete=(r:WorkflowRun,key:string,actor:'ai'|'user'='ai')=>command(r,'complete',key,actor,{evidence:{summary:'已验证',checks:[{criterion:'已验证',passed:true,note:'检查通过'}],artifacts:[]}});
  const start=()=>{const prepared=store.createInstance('outputs',randomUUID());return command(prepared,'activate');};
  const cleanup=()=>{store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('flow-outputs-'));fs.rmSync(dir,{recursive:true,force:true});};
  return {dir,md,png,store,def,node,save,command,complete,start,cleanup};
}

test('必填输出、CAS、幂等和图片声明在真实临时 Store 中受约束',()=>{const f=fixture();try{
  f.save();let r=f.start();r=f.command(r,'enter','phase');r=f.command(r,'enter','phase/draft');
  assert.throws(()=>f.complete(r,'phase/draft'),/输出 成果图/);
  const image=f.store.library.importFile(f.png,randomUUID()),op=randomUUID();
  const written=f.store.writeOutputs({runId:r.id,nodeKey:'phase/draft',values:{image:[image.id]},expectedRevision:r.revision,operationId:op},'ai');
  assert.deepEqual(f.store.writeOutputs({runId:r.id,nodeKey:'phase/draft',values:{image:[image.id]},expectedRevision:r.revision,operationId:op},'ai'),written);
  assert.throws(()=>f.store.writeOutputs({runId:r.id,nodeKey:'phase/draft',values:{image:[image.id]},expectedRevision:r.revision-1,operationId:randomUUID()},'ai'),/实例已更新/);
  assert.throws(()=>f.store.writeOutputs({runId:r.id,nodeKey:'phase/draft',values:{other:[image.id]},expectedRevision:written.revision,operationId:randomUUID()},'ai'),/未声明/);
  assert.throws(()=>f.store.writeOutputs({runId:r.id,nodeKey:'phase/draft',values:{image:['f'.repeat(64)]},expectedRevision:written.revision,operationId:randomUUID()},'ai'),/图片不存在/);
  assert.throws(()=>f.store.writeOutputs({runId:r.id,nodeKey:'phase/draft',values:{image:'wrong'},expectedRevision:written.revision,operationId:randomUUID()},'ai'),/成果图/);
  r=f.complete(written,'phase/draft');assert.equal(r.nodes['phase/draft'].status,'completed');
  assert.throws(()=>f.store.writeOutputs({runId:r.id,nodeKey:'phase/draft',values:{image:[image.id]},expectedRevision:r.revision,operationId:randomUUID()},'ai'),/重试后/);
}finally{f.cleanup();}});

test('跨子流程候选经人工确认后发布，消费者冻结图片、来源 attempt 与快照',()=>{const f=fixture();try{
  f.save();const image=f.store.library.importFile(f.png,randomUUID());assert.ok(bindingCandidates(f.def,'consumer').some(x=>x.nodeKey==='phase/publish'&&x.outputs[0].id==='image'));
  let r=f.start();r=f.command(r,'enter','phase');r=f.command(r,'enter','phase/draft');r=f.store.writeOutputs({runId:r.id,nodeKey:'phase/draft',values:{image:[image.id]},expectedRevision:r.revision,operationId:randomUUID()},'ai');r=f.complete(r,'phase/draft');
  r=f.command(r,'enter','phase/approve');assert.equal(r.nodes['phase/approve'].status,'waiting');
  assert.throws(()=>f.complete(r,'phase/approve'),/必须由用户/);r=f.complete(r,'phase/approve','user');
  r=f.command(r,'enter','phase/publish');r=f.store.writeOutputs({runId:r.id,nodeKey:'phase/publish',values:{image:[image.id]},expectedRevision:r.revision,operationId:randomUUID()},'ai');r=f.complete(r,'phase/publish');r=f.complete(r,'phase');
  r=f.command(r,'enter','consumer');const consumer=r.nodes.consumer;
  assert.deepEqual(consumer.inputs?.image,[image.id]);assert.deepEqual(consumer.inputSources?.image,{nodeKey:'phase/publish',outputId:'image',attempt:1,workflowRevision:r.definition.revision});
  assert.equal(consumer.inputSnapshots?.assets[image.id].id,image.id);assert.equal(f.store.context(r.id).bindings.consumer.frozen,true);
}finally{f.cleanup();}});

test('绑定拒绝无来源、未完成来源、类型和批量 iteration，输出不能有默认值',()=>{const f=fixture();try{
  const invalid=structuredClone(f.def);const consumer=invalid.graphs[0].nodes.find(n=>n.id==='consumer')!;
  consumer.outputProperties=[{id:'image',label:'自身图',type:'image'}];consumer.inputBindings={image:{nodeKey:'consumer',outputId:'image'}};assert.throws(()=>validateDefinition(invalid),/先行的上游/);
  const omittedIteration=structuredClone(f.def);const phase=omittedIteration.graphs[0].nodes.find(n=>n.id==='phase')!;phase.properties=[{id:'count',label:'份数',type:'number',integer:true,defaultValue:2}];phase.repeat={propertyId:'count',mode:'parallel'};omittedIteration.graphs[0].nodes.find(n=>n.id==='consumer')!.inputBindings={image:{nodeKey:'phase/draft',outputId:'image'}};assert.throws(()=>validateDefinition(omittedIteration),/来源不存在.*iteration/);
  const mismatch=structuredClone(f.def);const publish=mismatch.graphs[1].nodes.find(n=>n.id==='publish')!;publish.outputProperties=[{id:'image',label:'成果图',type:'text'}];assert.throws(()=>validateDefinition(mismatch),/类型不匹配/);
  const defaultOutput=structuredClone(f.def);defaultOutput.graphs[1].nodes.find(n=>n.id==='publish')!.outputProperties=[{id:'image',label:'成果图',type:'image',defaultValue:[]} as any];assert.throws(()=>validateDefinition(defaultOutput),/流程格式/);
  f.save();let r=f.start();assert.throws(()=>resolveBoundInputs(r,'consumer'),/尚未完成/);
  // A completed producer without the optional output still cannot supply a bound consumer.
  const missing=structuredClone(r);missing.nodes['phase/publish'].status='completed';assert.throws(()=>resolveBoundInputs(missing,'consumer'),/上游输出缺失/);
}finally{f.cleanup();}});

test('重试保留旧输出追溯并清除当前输出和冻结输入；apply 正确评估声明、绑定、资源变化',()=>{const f=fixture();try{
  const image=f.store.library.importFile(f.png,randomUUID());let resource=f.store.library.save({id:'ref',title:'基准',category:'岛屿',description:'v1',imageIds:[image.id],mdPath:f.md,revision:0,archived:false},0,randomUUID());
  f.def.graphs[1].nodes.find(n=>n.id==='publish')!.outputProperties=[{id:'image',label:'成果图',type:'image',required:true},{id:'refs',label:'资源',type:'resources',resourceCategory:'岛屿',required:true}];
  f.def.graphs[0].nodes.find(n=>n.id==='consumer')!.properties=[{id:'image',label:'成果图',type:'image',required:true},{id:'refs',label:'资源',type:'resources',resourceCategory:'岛屿',required:true},{id:'libraryRefs',label:'库资源',type:'resources',resourceCategory:'岛屿',defaultValue:['ref']}];f.def.graphs[0].nodes.find(n=>n.id==='consumer')!.inputBindings={image:{nodeKey:'phase/publish',outputId:'image'},refs:{nodeKey:'phase/publish',outputId:'refs'}};
  f.save();let r=f.start();r=f.command(r,'enter','phase');r=f.command(r,'enter','phase/draft');r=f.store.writeOutputs({runId:r.id,nodeKey:'phase/draft',values:{image:[image.id]},expectedRevision:r.revision,operationId:randomUUID()},'ai');r=f.complete(r,'phase/draft');r=f.command(r,'enter','phase/approve');r=f.complete(r,'phase/approve','user');r=f.command(r,'enter','phase/publish');r=f.store.writeOutputs({runId:r.id,nodeKey:'phase/publish',values:{image:[image.id],refs:['ref']},expectedRevision:r.revision,operationId:randomUUID()},'ai');r=f.complete(r,'phase/publish');r=f.complete(r,'phase');r=f.command(r,'enter','consumer');
  const frozen=structuredClone(r.nodes.consumer);r=f.command(r,'pause');r=f.command(r,'ack_pause');
  let d=f.store.workflow('outputs');d.graphs[1].nodes.find(n=>n.id==='publish')!.outputProperties![0].label='改显示名';d.graphs[0].nodes.find(n=>n.id==='consumer')!.properties![0].label='改输入显示名';f.store.saveWorkflow(d,d.revision,randomUUID());assert.deepEqual(f.store.impact(r.id).affected,[]);
  let impact=f.store.impact(r.id) as any;r=f.command(r,'apply',undefined,'user',impact);assert.deepEqual(r.nodes['phase/publish'].outputs,{image:[image.id],refs:['ref']});assert.deepEqual(r.nodes.consumer.inputSources,frozen.inputSources);
  resource=f.store.library.save({...resource,description:'v2'},resource.revision,randomUUID());impact=f.store.impact(r.id) as any;assert.ok(impact.affected.includes('consumer'));
  d=f.store.workflow('outputs');d.graphs[1].nodes.find(n=>n.id==='publish')!.outputProperties!.push({id:'caption',label:'说明',type:'text'});f.store.saveWorkflow(d,d.revision,randomUUID());impact=f.store.impact(r.id) as any;assert.ok(impact.affected.includes('phase/publish'));assert.ok(impact.affected.includes('consumer'));
  // Retry is allowed while paused and invalidates both producer and bound consumer while retaining immutable history.
  r=f.command(r,'retry','phase/publish','user');assert.equal(r.nodes['phase/publish'].outputs,undefined);assert.equal(r.nodes.consumer.inputSources,undefined);assert.equal(r.nodes.consumer.inputs?.image,null);assert.ok((r.outputEntries||[]).some(x=>x.nodeKey==='phase/publish'&&x.values.refs));
  const invalidation=r.events.find(e=>e.action==='invalidate')!;assert.match(JSON.stringify(invalidation.detail),/"outputs"/);
}finally{f.cleanup();}});

test('多选资源在建实例时校验分类、归档和缺失，运行资源快照独立于库更新',()=>{const f=fixture();try{
  const image=f.store.library.importFile(f.png,randomUUID());let a=f.store.library.save({id:'a',title:'A',category:'岛屿',description:'old',imageIds:[image.id],mdPath:f.md,revision:0,archived:false},0,randomUUID());
  let b=f.store.library.save({id:'b',title:'B',category:'建筑',description:'wrong',imageIds:[],revision:0,archived:false},0,randomUUID());
  f.def.graphs[0].nodes.find(n=>n.id==='consumer')!.properties=[{id:'set',label:'资源组',type:'resources',resourceCategory:'岛屿',required:true,defaultValue:['a','b']}];f.def.graphs[0].nodes.find(n=>n.id==='consumer')!.inputBindings=undefined;
  f.save();assert.throws(()=>f.store.createInstance('outputs',randomUUID()),/分类不匹配/);
  b=f.store.library.save({...b,category:'岛屿',archived:true},b.revision,randomUUID());assert.throws(()=>f.store.createInstance('outputs',randomUUID()),/已归档/);
  b=f.store.library.save({...b,archived:false},b.revision,randomUUID());let r=f.store.createInstance('outputs',randomUUID());assert.equal(r.inputSnapshots?.resources.a.description,'old');
  a=f.store.library.save({...a,description:'new'},a.revision,randomUUID());assert.equal(f.store.run(r.id).inputSnapshots?.resources.a.description,'old');
  const d=f.store.workflow('outputs');d.graphs[0].nodes.find(n=>n.id==='consumer')!.inputValues={set:['missing']};f.store.saveWorkflow(d,d.revision,randomUUID());assert.throws(()=>f.store.createInstance('outputs',randomUUID()),/资源不存在/);
}finally{f.cleanup();}});
