import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WorkflowSchema, RunCommandSchema, InstanceDataSchema, InstanceCreateOptionsSchema, OutputWriteSchema } from '../shared/types.js';
import type { Store } from './store.js';
import {ResourceSchema} from '../shared/properties.js';
export function makeMcp(getStore:()=>Store) {
  const server=new McpServer({name:'codex-flow',version:'1.0.0'});
  const tool=(name:string,description:string,schema:z.ZodRawShape,fn:(args:any)=>unknown)=>{
    const readOnly=['workflow_list','workflow_get','workflow_context','workflow_impact','workflow_document_read','workflow_resources','workflow_instances'].includes(name);
    server.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:readOnly,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async args=>{
      try { const value=await fn(args); return {content:[{type:'text' as const,text:JSON.stringify(value)}]}; }
      catch(e:any) { return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:e.message,status:e.statusCode,details:e.details})}]}; }
    });
  };
  tool('workflow_list','列出流程库及运行概览。流程草稿不会自动执行。',{},()=>({workflows:getStore().workflows(),runs:getStore().runs().map(r=>({id:r.id,title:r.title,instanceName:r.instanceName,status:r.status,revision:r.revision,workflowId:r.workflowId}))}));
  tool('workflow_get','读取完整流程定义，可用于生成、修改和保存草稿。',{workflowId:z.string()},a=>getStore().workflow(a.workflowId));
  tool('workflow_save','保存生成或修改后的流程草稿；不会启动执行。节点 description 是给用户看的单句摘要，通常 15–30 字，最多 60 字；步骤、节点专用技术约束、路径和 AI 指令放关联 MD。跨阶段做事原则放 workflow.globalConstraints，修改节点时保留它。必须使用稳定 ID、绝对 MD 路径、完成条件。支持 task 和引用 graphs 内子流程的 subflow。',{workflow:WorkflowSchema,expectedRevision:z.number().int(),operationId:z.string()},a=>getStore().saveWorkflow(a.workflow,a.expectedRevision,a.operationId));
  tool('workflow_instance_create','独立建立待执行实例，冻结模板、MD 和本次输入，不启动执行。inputs 按 graphId/nodeId/propertyId 组织，仅覆盖本实例填写值，不修改模板。',{workflowId:z.string(),operationId:z.string(),threadId:z.string().optional(),...InstanceCreateOptionsSchema.shape},a=>getStore().createInstance(a.workflowId,a.operationId,a.threadId,a));
  tool('workflow_start','接手已有待执行实例；仅按 runId 开始，不创建新实例。先 workflow_context 读取最新 revision；若实例已 active，直接继续节点，暂停或恢复状态按 context 处理。',{runId:z.string(),expectedRevision:z.number().int(),operationId:z.string()},a=>getStore().command({...a,action:'activate'},'ai'));
  tool('workflow_context','每个阶段前读取最新状态、可执行节点、冻结的 MD 与 globalConstraints。全局约束覆盖全部子流程及批量实例，完成时说明落实依据。遇到暂停请求先停止开始新工作并确认暂停。',{runId:z.string()},a=>getStore().context(a.runId));
  tool('workflow_transition','进入或更新节点、暂停/恢复、重试及结束流程。actor 固定为 ai，不能完成 user_only 节点。complete 需要 evidence，每项 criterion 必须通过且提供说明。finish 需要所有节点完成及 reason 总结。expectedRevision 来自最新 context，每次使用新 operationId，网络重试复用原 ID。',RunCommandSchema.shape,a=>getStore().command(a,'ai'));
  tool('workflow_impact','预览应用最新定义或重试节点的影响。apply 仅在确认暂停后可用。',{runId:z.string(),nodeKey:z.string().optional()},a=>getStore().impact(a.runId,a.nodeKey));
  tool('workflow_document_read','读取实际 Markdown 文件及 hash。执行时优先使用运行快照。',{path:z.string()},a=>getStore().readDocument(a.path));
  tool('workflow_document_write','新建或编辑用户授权的 Markdown，保留历史并检测冲突。新文件 expectedHash=null；已有文件使用最近读取的 hash。不要覆盖已存在文件来绕过冲突。',{path:z.string(),content:z.string(),expectedHash:z.string().nullable(),operationId:z.string()},a=>getStore().saveDocument(a.path,a.content,a.expectedHash,a.operationId));
  tool('workflow_instances','流程实例集：列出每次运行的状态及资料数量。用 workflow_context(runId) 读取完整输入、文档快照、AI/用户资料和成果历史。',{workflowId:z.string().optional()},a=>getStore().runs(a.workflowId).map(r=>({id:r.id,workflowId:r.workflowId,title:r.title,instanceName:r.instanceName,status:r.status,revision:r.revision,createdAt:r.createdAt,updatedAt:r.updatedAt,dataCount:r.dataEntries?.length||0})));
  tool('workflow_data_write','追加本次运行的输入、笔记或成果数据，actor 固定 ai。content 可保存文字或 JSON；filePaths 中本地文件复制归档（每文件最多 256MB），链接/缺失/过大文件显式标记。保留旧记录和重试历史，不改冻结输入或完成状态。携带最新 run.revision，每次写入后使用返回的新版本；先记录外部任务 ID 再继续，避免恢复时重复提交。',InstanceDataSchema.shape,a=>getStore().addData(a,'ai'));
  tool('workflow_output_write','写入当前执行节点的正式输出；先声明 outputProperties，图片需真实导入。绑定 inputBindings 只消费已完成上游当前 attempt。版本与操作 ID 必填；固定 AI 身份，不完成节点。',OutputWriteSchema.shape,a=>getStore().writeOutputs(a,'ai'));
  tool('workflow_resources','列出可选资源（例如已完成基准岛屿）。资源分类由用户定义，单选用 resource，多选用 resources ID 数组；程序化系统可按分类复用。',{},()=>getStore().library.list());
  tool('workflow_resource_save','保存独立资源库条目，不修改来源 Skill。图片使用 workflow_image_import 的 ID；mdPath 可引用说明。',{resource:ResourceSchema,expectedRevision:z.number().int(),operationId:z.string()},a=>getStore().library.save(a.resource,a.expectedRevision,a.operationId));
  tool('workflow_image_import','把本地参考图片复制到流程库的不可变图片存储，返回 ID 和路径；原文件保持不变。image 属性的值为图片 ID 数组。',{path:z.string(),operationId:z.string()},a=>getStore().library.importFile(a.path,a.operationId));
  server.registerTool('workflow_image_read',{description:'按图片 ID 查看参考图片，执行时使用运行 inputSnapshots 中的图片 ID。',inputSchema:{id:z.string()},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async a=>{
    try{const {asset,bytes}=getStore().library.read(a.id);return {content:[{type:'image' as const,data:bytes.toString('base64'),mimeType:asset.mime},{type:'text' as const,text:JSON.stringify(asset)}]};}catch(e:any){return {isError:true,content:[{type:'text' as const,text:e.message}]};}
  });
  return server;
}
