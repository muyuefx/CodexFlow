import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {NodeDefinition,WorkflowDefinition} from '../shared/types';
const c=new Client({name:'codex-input-feature-setup',version:'1'});
await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:43127/mcp')));
async function call(name:string,args:any={}){const r=await c.callTool({name,arguments:args});const v=JSON.parse((r.content as any[]).find(x=>x.type==='text').text);if(r.isError)throw Error(JSON.stringify(v));return v;}
const source='C:/Users/muyue/.codex/skills/agame-scene-assets',sha=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function inventory(dir:string):Record<string,string>{return Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name);return e.isDirectory()?Object.entries(inventory(p)):[[p,sha(p)]];}));}
const hashes=inventory(source);
try{
 const tools=await c.listTools();assert.ok(tools.tools.find(t=>t.name==='workflow_image_read'));
 const meta=await(await fetch('http://127.0.0.1:43127/api/meta')).json();
 const folder=path.join(meta.root,'documents','property-demo');
 const doc=async(name:string,content:string)=>{const p=path.join(folder,name+'.md');if(!fs.existsSync(p))await call('workflow_document_write',{path:p,content,expectedHash:null,operationId:randomUUID()});return p;};
 const resources=await call('workflow_resources');const imported:string[]=[];
 const catalog=JSON.parse(fs.readFileSync(path.join(source,'references/baseline-islands/catalog.json'),'utf8'));
 for(const b of catalog.baselines){if(b.status!=='ready')continue;const id='agame-'+b.id;if(resources.some((r:any)=>r.id===id)){imported.push(id);continue;}
   const originalImage=path.join(source,b.image);assert.equal(sha(originalImage),b.image_sha256);
   const image=await call('workflow_image_import',{path:originalImage,operationId:randomUUID()});
   const profile=await doc('resource-'+b.id,fs.readFileSync(path.join(source,b.profile),'utf8'));
   await call('workflow_resource_save',{resource:{id,title:b.name,category:'基准岛屿',description:b.style_summary,imageIds:[image.id],mdPath:profile,metadata:{source:path.join(source,'references/baseline-islands/catalog.json'),sourceId:b.id,sourceRevision:String(b.revision),sourceImageHash:b.image_sha256,confirmation:b.confirmation,styleKey:b.style_key||''},revision:0,archived:false},expectedRevision:0,operationId:randomUUID()});imported.push(id);
 }
 const node=async(id:string,title:string,extra:Partial<NodeDefinition>={}):Promise<NodeDefinition>=>({id,title,description:'使用节点输入，完成本阶段工作。',kind:'task',mdPath:await doc(id,`# ${title}\n\n这是通用节点输入演示，不授权岛屿生成或任何付费任务。\n\n执行前读取 workflow_context 的 nodeInputs 和父级 inputs；目标 goal、参考 pictures、参考资源 reference 和数量 count 都来自表单，不从固定文本猜测。实际查看图片与所选资源快照。\n\n批量子流程中按 iteration 区分每份，保留独立结果。此示例仅整理每份输入摘要，写在当前演示任务目录，最后汇总；不调用图像或建模服务。\n\n完成条件：输入与结果已核对。\n`),references:[],criteria:['输入与结果已核对'],completion:'ai_or_user',position:{x:40,y:60},...extra});
 const existing=await call('workflow_list');
 if(!existing.workflows.some((w:any)=>w.id==='node-inputs-demo')){
  const batch=await node('batch','填写目标与批量数量',{kind:'subflow',subflowId:'item',description:'填写目标、图片和数量，为每份任务提供输入。',properties:[
   {id:'goal',label:'目标',type:'textarea',help:'描述你想做什么、希望得到什么结果。',required:true},
   {id:'pictures',label:'参考图片',type:'image'},
   {id:'reference',label:'已有参考',type:'resource',resourceCategory:'基准岛屿'},
   {id:'count',label:'生成数量',type:'number',integer:true,min:1,max:100,required:true,defaultValue:3},
   {id:'quality',label:'详细程度',type:'select',options:[{value:'brief',label:'简要'},{value:'detailed',label:'详细'}],defaultValue:'brief'},
   {id:'check',label:'完成后复查',type:'boolean',defaultValue:true}
  ],repeat:{propertyId:'count',mode:'sequential'}});
  const end=await node('summary','汇总独立成果',{description:'汇总每份任务的结果与检查记录。',position:{x:400,y:60}});
  const item=await node('work','执行这一份任务',{description:'读取本份序号和公共输入，整理独立结果。'});
  const def:WorkflowDefinition={id:'node-inputs-demo',schemaVersion:1,title:'节点输入 · 可变数量示例',description:'通用属性示例：目标、图片、资源、数量、选项和开关都可自定义；数量默认 3，可改为 4。仅演示输入整理，不启动实际岛屿制作。',category:'入门示例',revision:0,archived:false,updatedAt:'',rootGraphId:'main',graphs:[{id:'main',title:'输入与批量执行',nodes:[batch,end],edges:[{id:'join',source:'batch',target:'summary'}]},{id:'item',title:'每份任务模板',nodes:[item],edges:[]}]};
  await call('workflow_save',{workflow:def,expectedRevision:0,operationId:randomUUID()});
 }
 assert.deepEqual(inventory(source),hashes,'原 Skill 必须保持不变');
 console.log(JSON.stringify({workflowId:'node-inputs-demo',resources:imported,originalSkillUnchanged:true,started:false}));
}finally{await c.close();}
