import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store';
import {seedDemo} from '../server/demo';

function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'flow-instance-'));let store=new Store(dir);seedDemo(store);return {dir,get store(){return store;},restart(){store.close();store=new Store(dir);},close(){store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('flow-instance-'));fs.rmSync(dir,{recursive:true,force:true});}};}
test('实例数据隔离、固定来源、CAS、幂等与重启恢复',()=>{const f=setup();try{
 const a=f.store.createInstance('welcome',randomUUID()),b=f.store.createInstance('welcome',randomUUID()),input={runId:a.id,expectedRevision:a.revision,operationId:randomUUID(),kind:'input',title:'用户目标',content:'海岸营地',filePaths:[]};
 const next=f.store.addData(input,'user');assert.equal(next.dataEntries?.[0].actor,'user');assert.equal(next.revision,a.revision+1);assert.deepEqual(f.store.addData(input,'user'),next);assert.equal(f.store.run(b.id).dataEntries,undefined);
 assert.throws(()=>f.store.addData({...input,operationId:randomUUID()},'ai'),/实例已更新/);
 assert.throws(()=>f.store.addData({...input,expectedRevision:next.revision,nodeKey:'other',operationId:randomUUID()},'ai'),/没有此节点/);
 f.restart();assert.equal(f.store.context(a.id).instanceData[0].content,'海岸营地');assert.equal(f.store.run(a.id).definition.revision,a.definition.revision);
}finally{f.close();}});
test('归档文件是独立副本，上传可读，缺失及链接不冒充已存文件',()=>{const f=setup();try{
 const r=f.store.createInstance('welcome',randomUUID()),source=path.join(f.dir,'成果.json');fs.writeFileSync(source,'{"island":1}');
 const next=f.store.addData({runId:r.id,expectedRevision:r.revision,operationId:randomUUID(),kind:'output',title:'AI 设计',content:'{"length":300}',filePaths:[source,path.join(f.dir,'missing.hip'),'https://example.com/result']},'ai',[{name:'note.txt',base64:Buffer.from('用户附件').toString('base64')}]);
 fs.writeFileSync(source,'changed');const e=next.dataEntries![0];assert.equal(f.store.instanceFile(r.id,e.id,0).bytes.toString(),'{"island":1}');assert.equal(f.store.instanceFile(r.id,e.id,3).bytes.toString(),'用户附件');assert.equal(e.files[1].status,'missing');assert.equal(e.files[2].status,'link');
 assert.throws(()=>f.store.instanceFile(r.id,e.id,-1),/附件不存在/);
 fs.writeFileSync(path.join(f.dir,'instance-files',e.files[0].hash!),'tampered');assert.throws(()=>f.store.instanceFile(r.id,e.id,0),/校验失败/);
}finally{f.close();}});
test('完成阶段自动保存成果，重试保留旧轮次而不复用完成状态',()=>{const f=setup();try{
 let r=f.store.createInstance('welcome',randomUUID());r=f.store.command({runId:r.id,expectedRevision:r.revision,operationId:randomUUID(),action:'activate'},'ai');const spec=r.definition.graphs[0].nodes.find(n=>n.id==='brief')!;
 const output=path.join(f.dir,'generated.md');fs.writeFileSync(output,'# 实际成果');
 const command={runId:r.id,expectedRevision:r.revision,operationId:randomUUID(),action:'complete',nodeKey:'brief',evidence:{summary:'完成',checks:spec.criteria.map(criterion=>({criterion,passed:true,note:'检查通过'})),artifacts:[output]}};
 r=f.store.command(command,'ai');assert.equal(r.dataEntries?.length,1);assert.equal(f.store.command(command,'ai').dataEntries?.length,1);
 const old=r.dataEntries![0];r=f.store.command({runId:r.id,expectedRevision:r.revision,operationId:randomUUID(),action:'retry',nodeKey:'brief'},'ai');assert.equal(r.nodes.brief.attempt,2);assert.equal(old.attempt,1);assert.equal(r.dataEntries![0].id,old.id);assert.equal(f.store.instanceFile(r.id,old.id,0).bytes.toString(),'# 实际成果');
}finally{f.close();}});

test('建立实例不执行；接手同一实例，拒绝重复或过期激活',()=>{const f=setup();try{
 const op=randomUUID(),r=f.store.createInstance('welcome',op,undefined,{name:'本次任务'});
 assert.equal(r.status,'prepared');assert.equal(r.instanceName,'本次任务');assert.equal(r.events[0].action,'create');
 assert.deepEqual(f.store.createInstance('welcome',op,undefined,{name:'本次任务'}),r);
 assert.throws(()=>f.store.command({runId:r.id,expectedRevision:r.revision,operationId:randomUUID(),action:'enter',nodeKey:'brief'},'ai'));
 f.restart();assert.equal(f.store.run(r.id).status,'prepared');assert.equal(f.store.run(r.id).revision,r.revision);
 const cmd={runId:r.id,expectedRevision:r.revision,operationId:randomUUID(),action:'activate'};
 assert.throws(()=>f.store.command(cmd,'user'));
 const active=f.store.command(cmd,'ai');assert.equal(active.id,r.id);assert.equal(active.status,'active');assert.equal(f.store.runs().length,1);
 assert.deepEqual(f.store.command(cmd,'ai'),active);
 assert.throws(()=>f.store.command({...cmd,operationId:randomUUID()},'ai'));
 assert.throws(()=>f.store.command({...cmd,expectedRevision:active.revision,operationId:randomUUID()},'ai'));
 const stopped=f.store.command({runId:r.id,expectedRevision:active.revision,operationId:randomUUID(),action:'cancel'},'user');
 assert.throws(()=>f.store.command({...cmd,expectedRevision:stopped.revision,operationId:randomUUID()},'ai'));
}finally{f.close();}});
test('仅旧版无执行活动的实例改为待执行，保留原资料',()=>{const f=setup();try{
 const r=f.store.createInstance('welcome',randomUUID());r.status='active';r.events[0].action='start';f.store.persistRun(r);
 f.restart();const migrated=f.store.run(r.id);assert.equal(migrated.status,'prepared');assert.equal(migrated.id,r.id);assert.deepEqual(migrated.documents,r.documents);assert.equal(migrated.events.at(-1)?.action,'prepared_migration');
}finally{f.close();}});
