import { z } from 'zod';
import {PropertySchema,PropertyValueSchema,RepeatSchema,type PropertyValue,type InputSnapshots} from './properties.js';
export const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const NODE_DESCRIPTION_MAX_LENGTH = 60;
export const NodeSchema = z.object({
  id: Id, title: z.string().min(1).max(200), kind: z.enum(['task', 'subflow']),
  description: z.string().max(NODE_DESCRIPTION_MAX_LENGTH, '阶段说明最多 60 字，详细要求请写入 Markdown。').regex(/^[^\r\n]*$/, '阶段说明只写一句话，不要换行；详细要求请写入 Markdown。').describe('给用户看的简短阶段摘要，通常 15–30 字，最多 60 字、单行；只说明做什么及结果，执行步骤、技术约束和路径放关联 Markdown。').default(''), mdPath: z.string().default(''), references: z.array(z.string()).default([]),
  criteria: z.array(z.string().min(1)).default([]), completion: z.enum(['ai_or_user', 'user_only']).default('ai_or_user'),
  subflowId: Id.optional(), position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  properties:z.array(PropertySchema).max(50).optional(),
  inputValues:z.record(PropertyValueSchema).optional(),
  outputProperties:z.array(PropertySchema.omit({defaultValue:true}).strict()).max(50).optional(),
  inputBindings:z.record(z.object({nodeKey:z.string().regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/).max(3000),outputId:z.string().min(1).max(64)}).strict()).optional(),
  repeat:RepeatSchema.optional()
});
export const GraphSchema = z.object({ id: Id, title: z.string(), nodes: z.array(NodeSchema).max(500),
  edges: z.array(z.object({ id: Id, source: Id, target: Id })).max(2000) });
export const WorkflowSchema = z.object({
  schemaVersion: z.literal(1), id: Id, title: z.string().min(1).max(200), description: z.string().default(''),
  globalConstraints: z.string().max(20000, '全局约束最多 20000 字。').describe('用户定义的全流程执行约束，适用于所有节点、嵌套子流程和批量实例；每次运行冻结。').optional(),
  category: z.string().default('通用'), archived: z.boolean().default(false), revision: z.number().int().nonnegative(),
  rootGraphId: Id, graphs: z.array(GraphSchema).min(1).max(100), updatedAt: z.string().default('')
});
export type NodeDefinition = z.infer<typeof NodeSchema>;
export type GraphDefinition = z.infer<typeof GraphSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowSchema>;
export type NodeStatus = 'pending' | 'ready' | 'running' | 'waiting' | 'blocked' | 'failed' | 'completed' | 'recovery';
export type RunStatus = 'prepared' | 'active' | 'pause_requested' | 'paused' | 'recovery' | 'completed' | 'cancelled';
export type Actor = 'user' | 'ai' | 'system';
export interface Evidence { summary: string; checks: { criterion: string; passed: boolean; note: string }[]; artifacts: string[] }
export interface NodeRun {
  key: string; nodeId: string; graphId: string; parentKey?: string; dependencies: string[]; children: string[];
  status: NodeStatus; attempt: number; reason?: string; evidence?: Evidence; completedBy?: Actor;
  startedAt?: string; completedAt?: string;
  inputs?:Record<string,PropertyValue>; iteration?:number;
  outputs?:Record<string,PropertyValue>; outputSnapshots?:InputSnapshots; inputSnapshots?:InputSnapshots; outputRevision?:number;
  inputSources?:Record<string,OutputSource>;
}
export interface OutputSource {nodeKey:string;outputId:string;attempt:number;workflowRevision:number}
export interface OutputEntry {id:string;nodeKey:string;attempt:number;workflowRevision:number;actor:Actor;values:Record<string,PropertyValue>;snapshots:InputSnapshots;createdAt:string}
export interface DocumentSnapshot { path: string; content: string; hash: string }
export interface RunEvent { id: string; time: string; actor: Actor; action: string; nodeKey?: string; detail?: unknown }
export interface WorkflowRun {
  instanceName?:string;
  inputOverrides?:InstanceCreateOptions['inputs'];
  id: string; workflowId: string; title: string; revision: number; status: RunStatus; createdAt: string; updatedAt: string;
  definition: WorkflowDefinition; documents: Record<string, DocumentSnapshot>; nodes: Record<string, NodeRun>;
  events: RunEvent[]; summary?: string; threadId?: string;
  inputSnapshots?:InputSnapshots;
  dataEntries?: InstanceDataEntry[];
  outputEntries?:OutputEntry[];
}
export const OutputWriteSchema=z.object({runId:Id,nodeKey:z.string().min(1),values:z.record(PropertyValueSchema),expectedRevision:z.number().int().nonnegative(),operationId:z.string().min(8).max(160)});
export interface InstanceFile { name:string; originalPath?:string; archivePath?:string; hash?:string; size?:number; status:'stored'|'missing'|'link'|'too_large'; }
export interface InstanceDataEntry { id:string; nodeKey?:string; attempt?:number; workflowRevision:number; actor:Actor; kind:'input'|'output'|'note'; title:string; content:string; files:InstanceFile[]; createdAt:string; }
export const InstanceDataSchema=z.object({runId:Id,expectedRevision:z.number().int().nonnegative(),operationId:z.string().min(8).max(160),nodeKey:z.string().optional(),kind:z.enum(['input','output','note']),title:z.string().min(1).max(160),content:z.string().max(200000).default(''),filePaths:z.array(z.string().min(1).max(4000)).max(20).default([])});
export const EvidenceSchema = z.object({ summary: z.string().min(1), checks: z.array(z.object({ criterion: z.string(), passed: z.boolean(), note: z.string() })), artifacts: z.array(z.string()) });
export const RunCommandSchema = z.object({
  runId: Id, expectedRevision: z.number().int().nonnegative(), operationId: z.string().min(8).max(160),
  action: z.enum(['activate', 'enter', 'complete', 'block', 'fail', 'wait', 'retry', 'pause', 'ack_pause', 'resume', 'cancel', 'finish', 'apply']),
  nodeKey: z.string().optional(), reason: z.string().optional(), evidence: EvidenceSchema.optional(),
  confirmedStopped: z.boolean().optional(), targetWorkflowRevision: z.number().int().optional(), impactToken:z.string().optional()
});
export type RunCommand = z.infer<typeof RunCommandSchema>;
export const InstanceCreateOptionsSchema=z.object({name:z.string().trim().min(1).max(160).optional(),expectedWorkflowRevision:z.number().int().optional(),inputs:z.record(z.record(z.record(PropertyValueSchema))).optional()});
export type InstanceCreateOptions=z.infer<typeof InstanceCreateOptionsSchema>;
export const statusLabels: Record<NodeStatus | RunStatus, string> = { prepared:'待执行', pending:'未开始', ready:'可执行', running:'执行中', waiting:'等待人工', blocked:'已阻塞', failed:'失败', completed:'已完成', recovery:'待恢复', active:'进行中', pause_requested:'正在请求暂停', paused:'已暂停', cancelled:'已取消' };
