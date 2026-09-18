import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { assert, DomainError, validateDefinition, createRun, transition, changeImpact, affectedKeys, event, expand,definitionOf,resolveBoundInputs } from './engine.js';
import { RunCommandSchema, InstanceDataSchema, InstanceCreateOptionsSchema,OutputWriteSchema, type InstanceCreateOptions, type InstanceDataEntry, type WorkflowDefinition, type WorkflowRun, type DocumentSnapshot, type Actor } from '../shared/types.js';
import {archiveFile,archiveBytes,readInstanceFile} from './instance-data.js';
import {InputLibrary} from './input-library.js';
import type {InputSnapshots} from '../shared/properties.js';

export const hash = (content: string) => createHash('sha256').update(content).digest('hex');
export function atomicWrite(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary,text,'utf8'); fs.renameSync(temporary,file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export class Store extends EventEmitter {
  db: DatabaseSync;
  library:InputLibrary;
  constructor(public root: string,options:{maintenanceRestart?:boolean}={}) {
    super(); fs.mkdirSync(root,{recursive:true});
    this.db=new DatabaseSync(path.join(root,'history.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_versions(id TEXT, revision INTEGER, json TEXT, PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT, response TEXT);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, path TEXT, hash TEXT, content TEXT, time TEXT, source TEXT);
      CREATE INDEX IF NOT EXISTS doc_path ON documents(path,time);
    `);
    this.library=new InputLibrary(this);
    if(options.maintenanceRestart){
      const executing=this.runs().some(r=>['active','pause_requested'].includes(r.status)&&Object.values(r.nodes).some(n=>n.status==='running'&&!n.children.length));
      if(executing){this.db.close();throw new DomainError('仍有任务节点执行，不能使用维护重启；请先停止相关操作',409);}
    }
    for (const run of this.runs()) {
      if(options.maintenanceRestart)continue;
      if(run.status==='active'&&run.events.every(e=>e.action==='start'||(e.action==='data'&&e.actor==='user'))&&Object.values(run.nodes).every(n=>['pending','ready'].includes(n.status))){
        run.status='prepared';run.revision++;event(run,'system','prepared_migration',undefined,'旧版仅创建、尚无执行活动的实例改为待执行');this.persistRun(run);
      }
      if (['active','pause_requested'].includes(run.status)) {
        for (const n of Object.values(run.nodes)) if (n.status==='running') n.status='recovery';
        run.status='recovery'; run.revision++; event(run,'system','restart',undefined,'服务重启，执行需要确认恢复'); this.persistRun(run);
      }
    }
    // Restore readable mirrors after an interrupted filesystem export.
    for (const def of this.workflows()) atomicWrite(this.workflowFile(def.id),JSON.stringify(def,null,2));
  }
  close() { this.db.close(); }
  workflowFile(id: string) { return path.join(this.root,'flows',id,'workflow.json'); }
  workflows(): WorkflowDefinition[] { return (this.db.prepare('SELECT json FROM workflows').all() as {json:string}[]).map(r=>JSON.parse(r.json)); }
  workflow(id: string): WorkflowDefinition {
    const row = this.db.prepare('SELECT json FROM workflows WHERE id=?').get(id) as {json:string}|undefined;
    assert(row,'流程不存在',404); return JSON.parse(row.json);
  }
  runs(workflowId?: string): WorkflowRun[] {
    const values=(this.db.prepare('SELECT json FROM runs ORDER BY rowid DESC').all() as {json:string}[]).map(r=>JSON.parse(r.json) as WorkflowRun);
    return workflowId ? values.filter(r=>r.workflowId===workflowId) : values;
  }
  run(id: string): WorkflowRun {
    const row=this.db.prepare('SELECT json FROM runs WHERE id=?').get(id) as {json:string}|undefined;
    assert(row,'运行记录不存在',404); return JSON.parse(row.json);
  }
  persistRun(run: WorkflowRun) { this.db.prepare('INSERT OR REPLACE INTO runs(id,json) VALUES (?,?)').run(run.id,JSON.stringify(run)); }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=operation(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  idempotent<T>(scope: string, id: string, payload: unknown, operation: () => T): T {
    assert(typeof id==='string' && id.length>=8 && id.length<=160,'缺少有效操作 ID');
    const key=scope+':'+id; const fingerprint=hash(JSON.stringify(payload));
    const old=this.db.prepare('SELECT fingerprint,response FROM operations WHERE id=?').get(key) as {fingerprint:string;response:string}|undefined;
    if (old) { assert(old.fingerprint===fingerprint,'操作 ID 已用于其他请求',409); return JSON.parse(old.response); }
    return this.transaction(()=>{
      const result=operation();
      const response=JSON.stringify(result);
      this.db.prepare('INSERT INTO operations VALUES (?,?,?)').run(key,fingerprint,response); return JSON.parse(response) as T;
    });
  }
  saveWorkflow(input: unknown, expectedRevision: number, operationId: string) {
    const def=validateDefinition(input);
    const result=this.idempotent('workflow',operationId,{input,expectedRevision},()=>{
      const row=this.db.prepare('SELECT revision FROM workflows WHERE id=?').get(def.id) as {revision:number}|undefined;
      assert((row?.revision ?? 0)===expectedRevision,'流程已被修改，请刷新或另存副本',409);
      def.revision=expectedRevision+1; def.updatedAt=new Date().toISOString();
      const json=JSON.stringify(def);
      this.db.prepare('INSERT OR REPLACE INTO workflows VALUES (?,?,?)').run(def.id,def.revision,json);
      this.db.prepare('INSERT INTO workflow_versions VALUES (?,?,?)').run(def.id,def.revision,json);
      return def;
    });
    atomicWrite(this.workflowFile(result.id),JSON.stringify(this.workflow(result.id),null,2));
    this.emit('change',{type:'workflow',id:result.id}); return result;
  }
  mdPath(input: string) {
    assert(typeof input==='string' && path.isAbsolute(input),'MD 必须使用绝对路径');
    assert(/\.(md|markdown)$/i.test(input),'仅支持 Markdown 文件');
    return path.normalize(input);
  }
  readDocument(input: string): DocumentSnapshot {
    const file=this.mdPath(input);
    assert(fs.existsSync(file),'MD 文件不存在：'+file,404);
    assert(fs.statSync(file).isFile() && fs.statSync(file).size<=4*1024*1024,'MD 文件不是普通文件或超过 4MB');
    const content=fs.readFileSync(file,'utf8'); return {path:file,content,hash:hash(content)};
  }
  rememberDocument(doc: DocumentSnapshot, source: string) {
    this.db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?)').run(randomUUID(),doc.path,doc.hash,doc.content,new Date().toISOString(),source);
  }
  documentHistory(input: string) {
    return this.db.prepare('SELECT * FROM documents WHERE path=? ORDER BY rowid DESC LIMIT 100').all(this.mdPath(input));
  }
  saveDocument(input: string, content: string, expectedHash: string|null, operationId: string) {
    const file=this.mdPath(input); assert(typeof content==='string' && Buffer.byteLength(content)<=4*1024*1024,'文档超过 4MB');
    const existing=fs.existsSync(file) ? this.readDocument(file) : null;
    const previousOperation=this.db.prepare('SELECT response,fingerprint FROM operations WHERE id=?').get('document:'+operationId) as {response:string;fingerprint:string}|undefined;
    const payload={file,content,expectedHash};
    if (previousOperation) { assert(previousOperation.fingerprint===hash(JSON.stringify(payload)),'操作 ID 已用于其他请求',409); return JSON.parse(previousOperation.response) as DocumentSnapshot; }
    if ((existing?.hash ?? null)!==expectedHash) {
      this.rememberDocument({path:file,content,hash:hash(content)},'conflict-draft');
      if (existing) this.rememberDocument(existing,'external');
      throw new DomainError('文件已被外部修改。你的草稿和磁盘版本均已保留，请对比后重新保存。',409,{current:existing});
    }
    const next={path:file,content,hash:hash(content)};
    const result=this.idempotent('document',operationId,payload,()=>{
      if (existing) this.rememberDocument(existing,'before-save');
      this.rememberDocument(next,'saved'); atomicWrite(file,content); return next;
    });
    this.emit('change',{type:'document',path:file}); return result;
  }
  snapshots(def: WorkflowDefinition,inputs?:InputSnapshots) {
    const result: Record<string,DocumentSnapshot>={};
    for (const instance of Object.values(expand(def))) {
      const n=def.graphs.find(g=>g.id===instance.graphId)!.nodes.find(n=>n.id===instance.nodeId)!;
      for (const p of [n.mdPath,...n.references].filter(Boolean)) if(!result[p])result[p]=this.readDocument(p);
    }
    for(const resource of Object.values(inputs?.resources||{}))if(resource.mdPath&&!result[resource.mdPath])result[resource.mdPath]=this.readDocument(resource.mdPath);
    return result;
  }
  createInstance(workflowId: string, operationId: string, threadId?: string, inputOptions:InstanceCreateOptions={}) {
    const options=InstanceCreateOptionsSchema.parse(inputOptions);
    const run=this.idempotent('create-instance',operationId,{workflowId,threadId,options},()=>{
      const def=this.workflow(workflowId); assert(!def.archived,'已归档流程不能建立实例');
      assert(options.expectedWorkflowRevision===undefined||options.expectedWorkflowRevision===def.revision,'流程模板已变化，请重新打开建立实例窗口',409);
      for(const [graphId,nodeInputs] of Object.entries(options.inputs||{})){
        const graph=def.graphs.find(g=>g.id===graphId);assert(graph,'输入引用了不存在的子流程');
        for(const [nodeId,values] of Object.entries(nodeInputs)){const node=graph.nodes.find(n=>n.id===nodeId);assert(node,'输入引用了不存在的节点');node.inputValues={...node.inputValues,...values};}
      }
      validateDefinition(def);
      const inputs=this.library.collect(def);
      const r=createRun(def,this.snapshots(def,inputs),threadId);r.instanceName=options.name;r.inputOverrides=options.inputs;r.inputSnapshots=inputs;this.persistRun(r); return r;
    }); this.emit('change',{type:'run',id:run.id}); return run;
  }
  command(input: unknown, actor: Actor) {
    const cmd=RunCommandSchema.parse(input);
    const run=this.idempotent('run',cmd.operationId,{cmd,actor},()=>{
      const r=this.run(cmd.runId);
      const target=cmd.action==='apply' ? this.instanceTarget(r) : undefined;
      const inputSnapshots=target?this.library.collect(target):undefined;
      const documents=target?this.snapshots(target,inputSnapshots):undefined;
      if(target&&documents)assert(cmd.impactToken===this.impactToken(r,target,documents,inputSnapshots),'版本、输入、资源或 MD 已变化，请重新预览应用影响',409);
      if(cmd.nodeKey&&['enter','complete'].includes(cmd.action)){
        const n=r.nodes[cmd.nodeKey];if(n){const snapshots=resolveBoundInputs(r,n.key).snapshots;
          for(const id of Object.keys({...snapshots.assets,...(cmd.action==='complete'?n.outputSnapshots?.assets:{})}))this.library.read(id);
        }
      }
      transition(r,cmd,actor,target&&documents ? {def:target,documents,inputSnapshots} : undefined);
      if(cmd.action==='complete'&&cmd.evidence){
        const files=cmd.evidence.artifacts.map(p=>archiveFile(this.root,p));
        (r.dataEntries??=[]).push({id:randomUUID(),nodeKey:cmd.nodeKey,attempt:r.nodes[cmd.nodeKey!].attempt,workflowRevision:r.definition.revision,actor,kind:'output',title:'阶段完成成果',content:JSON.stringify(cmd.evidence,null,2),files,createdAt:new Date().toISOString()});
      }
      this.persistRun(r); return r;
    }); this.emit('change',{type:'run',id:run.id}); return run;
  }
  instanceTarget(run:WorkflowRun){
    const def=this.workflow(run.workflowId);
    for(const g of def.graphs)for(const n of g.nodes){
      const values=run.inputOverrides?.[g.id]?.[n.id];if(!values)continue;
      const retained=Object.fromEntries(Object.entries(values).filter(([id])=>n.properties?.some(p=>p.id===id)));
      n.inputValues={...n.inputValues,...retained};
    }
    return def;
  }
  impact(runId: string, nodeKey?: string) {
    const run=this.run(runId);
    if (nodeKey) return {affected:affectedKeys(run.nodes,[nodeKey])};
    const def=this.instanceTarget(run);
    const inputs=this.library.collect(def),documents=this.snapshots(def,inputs);
    const {candidate,...impact}=changeImpact(run,def,documents,inputs);
    const before=run.definition.globalConstraints||'',after=def.globalConstraints||'';
    return {...impact,globalConstraints:before===after?undefined:{before,after},targetWorkflowRevision:def.revision,impactToken:this.impactToken(run,def,documents,inputs)};
  }
  addData(input:unknown,actor:Actor,uploads:{name:string;base64:string}[]=[]){
    const data=InstanceDataSchema.parse(input);assert(uploads.length+data.filePaths.length<=20,'每条记录最多 20 个附件');
    assert(uploads.every(f=>typeof f.name==='string'&&f.name.length>0&&typeof f.base64==='string'&&f.base64.length<=14*1024*1024),'上传文件无效或超过 10MB');
    const run=this.idempotent('instance-data',data.operationId,{data,actor,uploads},()=>{
      const r=this.run(data.runId);assert(r.revision===data.expectedRevision,'实例已更新，请刷新后保留草稿重新提交',409);
      assert(!data.nodeKey||r.nodes[data.nodeKey],'实例中没有此节点');
      const files=[...data.filePaths.map(p=>archiveFile(this.root,p)),...uploads.map(f=>archiveBytes(this.root,f.name,Buffer.from(f.base64,'base64')))];
      const item:InstanceDataEntry={id:randomUUID(),nodeKey:data.nodeKey,attempt:data.nodeKey?r.nodes[data.nodeKey].attempt:undefined,workflowRevision:r.definition.revision,actor,kind:data.kind,title:data.title,content:data.content,files,createdAt:new Date().toISOString()};
      (r.dataEntries??=[]).push(item);r.revision++;event(r,actor,'data',data.nodeKey,{id:item.id,title:item.title,kind:item.kind});this.persistRun(r);return r;
    });this.emit('change',{type:'run',id:run.id});return run;
  }
  writeOutputs(input:unknown,actor:Actor){
    const data=OutputWriteSchema.parse(input);
    const result=this.idempotent('node-output',data.operationId,{data,actor},()=>{
      const run=this.run(data.runId);assert(run.revision===data.expectedRevision,'实例已更新，请刷新',409);
      assert(['active','pause_requested'].includes(run.status),'实例未在执行');
      const node=run.nodes[data.nodeKey];assert(node,'节点不存在',404);
      assert(node.status==='running','请先进入节点；已完成的输出必须重试后才能修改');
      const spec=definitionOf(run,node.key);assert(actor!=='ai'||spec.completion!=='user_only','人工验收节点不能由 AI 写入输出',403);
      assert(Object.keys(data.values).length>0,'输出值不能为空');
      const snapshots=this.library.capture(spec.outputProperties||[],data.values);
      node.outputs={...node.outputs,...data.values};node.outputSnapshots={assets:{...node.outputSnapshots?.assets,...snapshots.assets},resources:{...node.outputSnapshots?.resources,...snapshots.resources},documents:{...node.outputSnapshots?.documents,...snapshots.documents}};
      node.outputSnapshots=this.library.usedSnapshots(spec.outputProperties||[],node.outputs,node.outputSnapshots);
      node.outputRevision=run.definition.revision;
      const entry={id:randomUUID(),nodeKey:node.key,attempt:node.attempt,workflowRevision:run.definition.revision,actor,values:data.values,snapshots,createdAt:new Date().toISOString()};
      (run.outputEntries??=[]).push(entry);run.revision++;event(run,actor,'outputs',node.key,{id:entry.id,properties:Object.keys(data.values)});this.persistRun(run);return run;
    });this.emit('change',{type:'run',id:result.id});return result;
  }
  instanceFile(runId:string,entryId:string,index:number){const r=this.run(runId),entry=r.dataEntries?.find(e=>e.id===entryId);assert(entry&&Number.isInteger(index)&&index>=0&&entry.files[index],'附件不存在',404);const file=entry.files[index];return {file,bytes:readInstanceFile(this.root,file)};}
  impactToken(run:WorkflowRun,def:WorkflowDefinition,documents:Record<string,DocumentSnapshot>,inputs?:InputSnapshots){return hash(JSON.stringify({run:run.revision,definition:def.revision,inputs,documents:Object.entries(documents).map(([p,d])=>[p,d.hash]).sort()}));}
  context(runId: string) {
    const run=this.run(runId);
    const bindings=Object.fromEntries(Object.values(run.nodes).map(n=>{try{const resolved=resolveBoundInputs(run,n.key);return [n.key,{...resolved,frozen:!!n.inputSources}];}catch(e:any){return [n.key,{values:n.inputs||{},sources:n.inputSources||{},error:e.message,frozen:!!n.inputSources}];}}));
    const nodeOutputs=Object.fromEntries(Object.values(run.nodes).map(n=>[n.key,{values:n.outputs||{},available:n.status==='completed',attempt:n.attempt,workflowRevision:n.outputRevision,snapshots:n.outputSnapshots}]));
    const outputInstruction='outputProperties 声明正式输出，用 workflow_output_write 写入当前 running 节点；先导入图片得到 ID。inputBindings 只消费已完成上游的当前 attempt，enter 时冻结值及来源。使用 bindings/nodeOutputs 和节点 inputSnapshots/outputSnapshots，不以旧 outputEntries 或 instanceData 替代有效输出。resources 为多资源 ID 数组；系统资源按冻结版本复用。';
    return {run,bindings,nodeOutputs,outputInstruction,instanceData:run.dataEntries||[],instanceDataInstruction:'本实例保存启动输入、MD 快照及用户/AI补充资料；通过 workflow_data_write 保存中间结果、任务 ID、结构化 JSON 文本和成果文件。完成节点的 evidence 与附件自动归档。补充记录不自动修改冻结参数；冲突时先暂停改版。旧 attempt 的结果仅供追溯，不能冒充当前成果。', globalConstraints:run.definition.globalConstraints||'',constraintInstruction:'全局约束适用于此运行的全部节点、嵌套子流程及批量实例。每阶段开始前读取并遵守相关约束，完成时在 evidence.summary 说明落实依据；不适用的条款不强行套用。约束不扩展权限；与节点要求冲突或无法满足时说明原因并上报 block，不静默忽略。',nodeInputs:Object.fromEntries(Object.values(run.nodes).map(n=>[n.key,{values:n.inputs||{},parentKey:n.parentKey,iteration:n.iteration}])),ready:Object.values(run.nodes).filter(n=>n.status==='ready').map(n=>n.key),
      instruction:run.status==='prepared'?'实例已建立但未执行。用户要求执行此实例时，先 workflow_start(runId, expectedRevision, operationId) 接手，再 enter；不要新建重复实例。':run.status==='pause_requested' ? '用户已请求暂停。停止开始新工作，到达检查点后调用 ack_pause。' : run.status==='active' ? '使用快照 MD、nodeInputs 和 run.inputSnapshots；沿 parentKey 读取公共输入，按 iteration 区分实例。用 workflow_image_read 查看输入图片。进入阶段前调用 enter，完成后提交 evidence。人工节点不能由 AI 完成。' : '当前运行不在执行状态。先处理暂停、恢复或结束状态。'};
  }
  browse(input: string) {
    const directory=path.resolve(input); assert(fs.existsSync(directory) && fs.statSync(directory).isDirectory(),'目录不存在');
    return {directory,parent:path.dirname(directory),entries:fs.readdirSync(directory,{withFileTypes:true})
      .filter(x=>!x.name.startsWith('.') && (x.isDirectory() || /\.(md|markdown)$/i.test(x.name)))
      .slice(0,500).map(x=>({name:x.name,path:path.join(directory,x.name),directory:x.isDirectory()})).sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name))};
  }
}
