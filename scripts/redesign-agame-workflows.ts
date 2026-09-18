import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {validateDefinition,expand,createRun} from '../server/engine.js';
import {layout} from '../src/layout.js';
import type {NodeDefinition,GraphDefinition,WorkflowDefinition} from '../shared/types.js';
import type {PropertyDefinition} from '../shared/properties.js';

const source='C:/Users/muyue/.codex/skills/agame-scene-assets';
const skills='C:/Users/muyue/.codex/skills';
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
function inventory(dir:string):Record<string,string>{return Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name);return e.isDirectory()?Object.entries(inventory(p)):[[p,sha(fs.readFileSync(p))]];}));}
const originalSkill=inventory(source),client=new Client({name:'agame-workflow-redesign',version:'2'});
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:43127/mcp')));
async function call(name:string,args:any={}){const r=await client.callTool({name,arguments:args});const value=JSON.parse((r.content as any[]).find(x=>x.type==='text').text);if(r.isError)throw Error(JSON.stringify(value));return value;}
const apply=process.argv.includes('--apply');
try{
 const list=await call('workflow_list'),base=await call('workflow_get',{workflowId:'agame-scene-assets-baseline'}) as WorkflowDefinition;
 const before=JSON.parse(fs.readFileSync('logs/agame-redesign-before.json','utf8')).def as WorkflowDefinition;
 assert.equal(base.revision,before.revision,'用户已保存新版本，请先合并，不覆盖');
 const derivativeId='agame-derived-islands';assert(!list.workflows.some((w:any)=>w.id===derivativeId),'衍生流程已存在，先读取并合并');
 assert(!list.runs.some((r:any)=>r.workflowId===base.id&&!['completed','cancelled'].includes(r.status)),'首次基准存在未结束运行，请先审查影响');
 const resources=await call('workflow_resources');assert(resources.some((r:any)=>r.category==='基准岛屿'&&!r.archived),'需要可选的已确认基准');
 const meta=await(await fetch('http://127.0.0.1:43127/api/meta')).json();
 const edition='redesign-'+new Date().toISOString().replace(/[:.]/g,'-');
 const docs=new Map<string,string>(),references=new Map<string,string>();
 const commonConstraints=`1. 执行以本次实例冻结的目标、输入、约束和 MD 为准。开始每阶段先 workflow_context，进入后才动手；用 workflow_data_write 保存关键设计数据、外部任务编号和中间成果，完成时提交实际依据。重试与恢复先查旧任务，避免重复生成或重复付费。
2. 原 agame-scene-assets Skill 整个目录只读。新增档案、基准图片和任务数据保存在 Codex Flow 实例与独立资源库；不写回原 Skill，不覆盖已验收图、模型、用户工程或手工参数。仅编辑流程不授权制作。
3. Houdini PCG 先复用已有 HDA 与参数；需要改算法时先考虑成熟原生 SOP，VEX 适合简短自定义规则或更合适的高效实现。按实际 cook 时间、内存、稳定性与维护成本选择，不固定全 SOP 或全 VEX。大数据分支检查目标规模、常用参数重算范围与主要耗时；未测不声称提速，不以缓存命中冒充算法改善。
4. 避免重复解包、逐点全场扫描、无界候选和无必要全量预览。环境 mask、道路/建筑禁刷、接地、稳定 ID 与 Seed 契约不可因优化丢失；运行时 Python SOP 默认不用，MCP/HOM 编排不受此限制。仅验证本次受影响分支，不扩展成无关全场审计。
5. 同一目标 HIP 复用现有唯一场景 Geo；没有 Geo 才创建。节点创建前核实容器与当前有效 OUT，HDA 内不增加网络展示框/便签。先查 HDA_LIBRARY.md 与同名说明，参数够用只调参，缺口再兼容扩展；生成规则归 HDA，HIP 只组合输入、实例与接口，三个 Final 只供导出链消费。
6. 同一 Houdini 会话、HIP、HDA、发布目标和同步队列单一写入者。只读资源核实与独立资料可并行，分支全部完成才汇合；多岛制作默认顺序。保存前核实实际路径和依赖，不借用未保存的其他工程。
7. 原图与实际成果分开：AI 参考图不称为 UE 实机截图，提示词与工具成功不代替实际查看。新岛保持可信尺度与 UE 写实观感，缓坡海岸为主、少量局部崖段；不追溯重画已确认基准。用户当次明确地貌要求优先。
8. 缺输入、关键资产或接口时报告实际阻塞，不伪造完成。付费生成仅限本次明确启动的数量和范围，不充值、不增购、不额外增加岛屿；不确定提交先查任务。相同问题连续两次针对性返工仍失败时停止该项并报告，不无限重试。
9. 修复共同根因，不按截图中的某一件物体叠加偏移补丁。先用相关数据定位，再在负责规则的系统内做最小充分修复；核对受影响对象及必要对照，不扩展无关系统。
10. 结果按实例及完整 nodeKey/iteration 存储。AI 设计尺寸、测量结果、资源来源、检查状态分开记录；旧 attempt 结果仅供追溯。补充资料不静默改冻结参数，要求变化先暂停、预览并应用新版本。`;
 const baselineConstraints=commonConstraints+`\n11. 首次基准第0阶段使用真实计划模式只读选材与设计，执行模式才出图与写生产文件。保留选材、基准图及制作方案的必要确认；确认范围内 AI 连续完成制作和必要修复，不逐节点追加审批。\n12. 完整场景由 AI 负责必要的三缓存写出、仅本岛 Rebuild、MCP 实图对比与修复，再保存、正式发布和交接。不设独立最终人工验收关卡；用户自行验收玩法与 UE 性能。用户要求收尾时不追加美术循环或重复复核，如实交接已检、未测及剩余限制。`;
 const derivativeConstraints=commonConstraints+`\n11. 衍生岛屿使用用户选定的已确认基准与明确数量，不拿当前 HIP、上次迁移岛或最近图片替代，不重新执行首次选材。继承已知资源依据，关键新题材或缺件再补充必要决定。\n12. 保留建筑文化、材质生态和尺度语言，重新设计岸线与地形骨架，并改变道路拓扑或聚落关系；整批也不能重复。概念文生图仅用提炼的风格文字和新空间方案，不传基准或上一岛图片；地形提取才使用本岛已通过的新图。\n13. 本流程终点为每岛对应的效果图、地形参考、FBX/Base Color 和一个初始地形 HIP。只接好 AGame_Island_Cache，不写正式缓存、不布置建筑生态、不导入 UE，不把衍生结果自动升级为基准。数量与方向明确后不逐岛要求审批；确有新范围或阻塞才询问。`;
 const folder=(id:string)=>path.join(meta.root,'documents',id,edition);
 function ref(id:string,file:string){const absolute=path.resolve(file),key=id+'|'+absolute;if(references.has(key))return references.get(key)!;assert(fs.existsSync(absolute),absolute);const dest=path.join(folder(id),'sources',sha(absolute).slice(0,8)+'-'+path.basename(absolute));const content=fs.readFileSync(absolute,'utf8').replace(/\]\(([^)]+)\)/g,(match,link)=>{if(/^(https?:|#|[A-Za-z]:)/.test(link))return match;const [file,anchor]=link.split('#');return `](<${path.resolve(path.dirname(absolute),file).replaceAll('\\','/')}${anchor?'#'+anchor:''}>)`;});docs.set(dest,`<!-- 来源只读快照：${absolute}；SHA256 ${sha(fs.readFileSync(absolute))}。原 Skill 只读；涉及向 Skill 收录的动作由本流程独立资源库承担。 -->\n\n${content}`);references.set(key,dest);return dest;}
 const src=(name:string)=>path.join(source,'references',name+'.md');
 const hda=(name:string)=>path.join(skills,'houdini-modular-seed-hda','references',name+'.md');
 const commonRefs=[hda('sop-vex-performance'),hda('hda-reuse-and-documentation'),hda('system-network-organization')];
 function document(id:string,n:NodeDefinition,body:string,refs:string[]=[]){n.mdPath=path.join(folder(id),'nodes',n.id+'.md');n.references=[...new Set(refs)].map(p=>ref(id,p));docs.set(n.mdPath,`# ${n.title}\n\n## 使用本次输入\n\n先 workflow_context 读取 globalConstraints、nodeInputs、instanceData 和冻结文档。节点资料优先本次 run 与当前 attempt；不要从模板示例猜目标。所有阶段共用主图 scope 输入；衍生数量来自 batch.inputs.count，当前岛序号沿 parentKey 查所属批量实例的 iteration。\n\n## 本阶段工作\n\n${body}\n\n## 实例数据\n\n用 workflow_data_write 按完整 nodeKey 保存本阶段关键数据（content 可用 JSON）、外部任务 ID、文件路径及必要中间成果。不要只留聊天回复；写入后使用返回 revision。完成时 evidence 引用实际文件，附件会自动复制归档；超过归档上限或缺失文件如实说明。原 Skill 整个目录保持只读，新增基准收录到工作流独立资源库。\n\n## 完成条件\n\n${n.criteria.map(c=>'- '+c).join('\n')}\n\n完成方式：${n.completion==='user_only'?'由用户在界面确认。AI 展示待确认成果后等待，不伪造用户身份。':'AI 或用户；AI 须提交每项检查的真实依据。'}\n\n## 参考\n\n${n.references.map(p=>`- [${path.basename(p)}](<${p.replaceAll('\\','/')}>)`).join('\n')}\n`);}
 const node=(id:string,title:string,description:string,criteria:string[],extra:Partial<NodeDefinition>={}):NodeDefinition=>({id,title,description,criteria,kind:'task',completion:'ai_or_user',mdPath:'',references:[],position:{x:0,y:0},...extra});
 const graph=(id:string,title:string,nodes:NodeDefinition[],pairs?:string[][]):GraphDefinition=>layout({id,title,nodes,edges:(pairs||nodes.slice(1).map((n,i)=>[nodes[i].id,n.id])).map(([source,target])=>({id:source+'_'+target,source,target}))});
 const property=(id:string,label:string,type:PropertyDefinition['type'],extra:Partial<PropertyDefinition>={}):PropertyDefinition=>({id,label,type,...extra});
 function addProperties(n:NodeDefinition,properties:PropertyDefinition[]){const old=n.properties||[];assert(!properties.some(p=>old.some(o=>o.id===p.id)),'发现同 ID 用户属性，先合并');n.properties=[...old,...properties];n.inputValues={...n.inputValues};}

 const b=structuredClone(base);b.description='填写岛屿目标与参考图，完成选材、基准入库、地形 HIP、场景制作及 UE 实图自检；全过程数据归入独立实例。';b.globalConstraints=baselineConstraints;
 const nodes=new Map(b.graphs.flatMap(g=>g.nodes).map(n=>[n.id,n]));const get=(id:string)=>{const n=nodes.get(id);assert(n,id);return n;};
 get('scope').title='填写岛屿目标与制作范围';get('scope').description='填写想做的岛屿、参考图与制作边界。';
 addProperties(get('scope'),[
  property('goal','想做怎样的岛屿','textarea',{required:true,help:'描述风格、用途、聚落和主要体验。'}),property('pictures','参考图片','image',{help:'上传风格、构图或场景参考，可留空。'}),
  property('selectedAssets','已选资源包','textarea',{help:'已有选择直接沿用，未选则由选材阶段推荐。'}),property('islandName','岛屿名称','text'),property('styleKey','英文命名前缀','text',{help:'可留空，由设计阶段给出 ASCII style_key；创建文件前核实。'}),
  property('length','建议长度（米）','number',{min:1,help:'可留空，由设计阶段明确；不是已测尺寸。'}),property('width','建议宽度（米）','number',{min:1}),property('preserve','必须保留 / 不允许修改','textarea'),
  property('projectRoot','项目目录','text',{defaultValue:'G:/AGame'}),property('ueTarget','UE 目标关卡与岛屿','text',{help:'可在制作方案阶段明确；未唯一定位前不操作 UE。'})
 ]);
 const perf=node('performance','检查计算性能','检查关键分支耗时与调参重算范围。',['本次大数据分支的输入规模、cook 与重算范围已检查','瓶颈处理依据与未测项已记录']);
 const production=b.graphs.find(g=>g.id==='production')!;production.nodes.push(perf);production.edges.push({id:'preview_performance',source:'preview',target:'performance'});nodes.set(perf.id,perf);
 get('baseline_record').title='基准入库供后续选择';get('baseline_record').description='保存已确认原图与档案，加入可选择的基准库。';get('baseline_record').criteria=['已确认原图与档案独立保存且哈希一致','基准资源已入库，包含确认依据、style_key 与资源来源'];
 const instructions:Record<string,[string,string[]]>={
 scope:['读取 scope 输入的 goal、pictures、已选资源、尺寸与保留项；实际查看输入图片。确认这是从新基准到完整场景的任务；既有 HIP 小改不要强行套本主线。把本次目标、范围、已有确认、待明确项写入实例；未提供的尺寸与 style_key 留给设计阶段明确，不擅自使用当前打开工程。仅启动管理器记录不代表外部制作已获新授权。',[src('baseline-preparation')]],
 planning:['按子流程完成第0阶段。在真实计划模式进行只读选材、包内元素核实与方案讨论；不能以普通回复假称切换。没有切换工具时告知用户切换。计划模式不写生产文件，交接放计划正文；允许的流程状态更新也须服从当前模式工具权限，恢复执行模式后补录实例。',[src('baseline-preparation')]],
 recommend:['先读美术经验入口和相关反馈；按 scope.goal 和图片从真实库存提出少量合适资源组合，包含 ID、用途、证据和缺口。已有明确选材沿用，不重问；不得在未选材前先生成最终岛屿图。',[src('asset-selection'),src('baseline-preparation'),path.join(skills,'art-experience-library/SKILL.md'),src('scene-aesthetic-review')]],
 select:['展示首选组合及影响关键轮廓的缺件，用户确认本场景采用的资源。已有明确选择可直接提交为待人工完成依据，不让用户重新选一遍；AI 不能替用户点完成。',[src('asset-selection')]],
 elements:['对已选包按 Houdini 库→UE 库只读核实代表元素、可读几何与示例信息；建立元素→画面角色表并标 direct/adapt/missing/unknown。关键缺件有处理决定才进入设计；库存拥有或 Ready 不等于本场景可用。此处不提前同步整库。',[src('baseline-preparation'),src('maintenance')]],
 design:['依据已选元素设计岸线、内陆地貌、聚落、路线、林缘与参考图提示词。结合用户输入的建议尺寸给出米制 designLength/designWidth，明确设计值不是测量值；确定英文 style_key、空间关系、必须保留项和未决缺口。计划正文形成最小交接，不制作图片。',[src('baseline-preparation'),src('workflow-reporting')]],
 start_production:['展示已定方案、所选资源、设计尺寸、输出范围和预计需要的图片/高模任务。确认系统实际为执行模式且用户明确启动本次范围；后续已有授权不逐步重复询问。确认后再保存计划与生产数据，原 Skill 不写回。',[src('baseline-preparation')]],
 concept:['依次生成并审查基准图、交用户确认、保存独立档案并加入资源库。基准图不等于 UE 成果，也不意味着完整场景完成。',[src('baseline-preparation'),src('island-baselines')]],
 image:['执行模式先保存计划交接到实例，再按官方 imagegen 规则依据已选元素生成图。实际检查资源一致性、UE 写实质感、缓岸、聚落尺度与通路；不合格先修图，不迁就生成图扩大选材。保存原图、实际检查依据和有效版本。',[src('workflow-reporting'),src('baseline-preparation')]],
 approve_image:['向用户展示已自检的实际基准原图及简短说明，等待确认它作为基准；不能把工具成功视为用户认可。用户只认可图像时不冒称认可场景生产结果。',[src('island-baselines')]],
 baseline_record:['不修改 Skill 基准目录。将用户确认原图通过 workflow_image_import 复制到独立图片库，核对哈希；用 workflow_document_write 在本流程成果目录保存独立基准档案（ID、revision、style_key、风格身份、原空间骨架、资源依据、确认来源）。workflow_resource_save 写入 category=基准岛屿、imageIds 和 mdPath；metadata 记录 sourceRunId、confirmation、stage=concept_confirmed、styleKey 和原图哈希。同图按哈希去重，不覆盖他人条目。写入后再次读取资源，验证后续衍生流程可以选择；此时只确认基准图，完整场景状态在最终交接再更新。',[src('island-baselines')]],
 terrain:['保持本岛基准图→纯地形/连续路网→高模→FBX/真实颜色贴图→初始 HIP 的映射，不重复出已通过版本。各步骤数据和任务 ID 记入实例。',[src('terrain-road-reference'),src('terrain-hip-from-mesh')]],
 roads:['纯地形背景与可见路线核对可在输入冻结后独立准备；两者全部完成才锁定合成。红线只是平面标记，不声称真实坡度/通行已通过。',[src('terrain-road-reference')]],
 terrain_image:['以本岛已通过效果图提取纯地形背景，保留机位、岸线、台地、高差与缓坡；移除建筑、植物、道具、独立石块与遮挡。原图保留，地形提取不重新设计道路。遵守图像工具编辑规则。',[src('terrain-road-reference')]],
 road_lines:['从本岛图核对可见道路，依据地形与入口设计补齐遮挡段，保存可编辑节点、边、控制点与推断段；不要最近点硬连或强制闭合所有终点。',[src('terrain-road-reference')]],
 compose:['使用已授权的锁线脚本，把同一完整中心线置顶合成到效果图和纯地形背景。保存线数据、透明层、蒙版及对照图；检查连通、推断段、对齐、图层外像素和原图保留。最终线网不再交生成模型重画；必要尺寸来自实例已定设计。',[src('terrain-road-reference')]],
 highpoly:['必要图像检查通过后在既有明确启动范围内，用用户资源管理器提交对应 Tripo 高模。先查是否已有任务；立即用实例记录保存任务 ID、输入图哈希、提交状态，再跟进下载和真实模型检查。结果不确定先查状态，不能重复付费。采用真实支持的高模设置，不套道具低模/PBR流程。',[src('workflow-reporting')]],
 fbx:['用已核实转换器在隔离进程导出 FBX，并提取真实材质绑定的 Base Color。回读核对几何、UV、单位/范围和贴图映射，不擅自重缩放或重做颜色；多材质按实际适配。通过后仅回收本任务交付 GLB，优先回收站并记录恢复位置，不删除资源管理器仍引用的内部缓存。',[src('workflow-reporting')]],
 initial_hip:['读取 HDA_LIBRARY.md 与 AGame_Island_From_Mesh 同名说明，复用锁定定义和依赖。由已定设计长宽取 D=2×max(长,宽)，HeightField Size 两项均为 D，Uniform Scale=1；不能从归一化 FBX 猜设计尺寸。FBX/Base Color 用真实路径，连接两个阶段输出与三个 Final，再接已核实 AGame_Island_Cache（不猜内部类型/端口）。默认 HIP 到 E:/Project/DCCProject/Houdini/AGame/PipeLine/，输入到 fbx/，英文 style_key+可用序号，先检查文件不冲突。不借用未保存工程，不新建 HDA、不写正式缓存；只核实必要文件、参数、两路和终端接线后保存一个 HIP。',[src('terrain-hip-from-mesh'),src('ue-final-export'),...commonRefs]],
 readiness:['已选必需资产缓存核实与只读 HDA 复用评估可并行，全部就绪再汇合。共享同步队列、HDA 或 Houdini 写入保持一个执行者。',[src('maintenance'),src('houdini-first-workflow')]],
 assets:['仅核实本场景已选必需模块的缓存签名、几何可读性和引擎标识；缺失/过期按维护规范同步，处理错误后才能进入制作，不扩展整库同步。普通道具按 Houdini 库→UE 库→经授权 AI 建模解决，不在 Houdini 补造普通模型。',[src('maintenance'),src('houdini-first-workflow')]],
 hda_scan:['只读查项目 HDA_LIBRARY.md、匹配同名说明与真实接口；按复用→实例调参→兼容扩展→职责缺口新建决策，说明关键分支可用 SOP、VEX 规则与性能预算，不创建节点。',[...commonRefs]],
 join:['汇合两分支，绑定实际 HIP、唯一场景 Geo、当前有效阶段 OUT、资产版本与 HDA 依赖；任一必需资源未知或错误都先阻塞。记录绑定路径供后续阶段使用，不绑定最近打开的无关场景。',[src('houdini-first-workflow'),hda('stage-output-handoff')]],
 production:['按已确认制作方案完成布局、环境 mask 生态/道具、风化、集成和必要性能检查。所有子阶段完成再完成父节点，不把 Preview 通过当最终 UE 交付。',[src('houdini-first-workflow')]],
 scene_plan:['结合基准图、已定地形、当前场景 MCP 实图与素材能力，找决定性质感差距；提交程序化方案、锁定锚点、工具复用策略、预计改善及 HIP/UE 改动范围。无现有 UE 结果时如实以地形 Preview/基准分析，不伪造截图。设计性能预算并说明关键检查。',[src('houdini-first-workflow'),src('scene-aesthetic-review')]],
 approve_plan:['向用户展示具体场景制作方案与修改范围，等待用户确认；在已确认方案内后续连续微调无需逐轮再问，新增系统或破坏接口再说明并确认。',[src('houdini-first-workflow')]],
 layout:['先复用参数，确有缺口再兼容扩展 HDA。主建筑/地标/入口通过锚点锁定，连续道路按真实地形与曲线组织；房屋资源拼装与 Layout 职责分离。不要普通模型硬造或使用一次性裸网络。阶段 OUT 同步消费者；性能按全局约束选择原生 SOP 与短 VEX。',[src('houdini-first-workflow'),...commonRefs,hda('stage-output-handoff')]],
 ecology:['依据坡度、高度/水位、生境、道路、建筑占用和禁刷区域建立环境密度 mask，采用合适 Scatter/原生采样与 VEX 专用规则。按模型真实占用、接触关系、稳定 ID 和朝向组织生态道具，不用随机点簇或全场拉密掩盖缺陷。检查疏密、支撑、通路和必要对照对象。',[src('houdini-first-workflow'),hda('terrain-mask-scatter'),hda('sop-vex-performance')]],
 weather:['保留完整生产中的风化阶段；按环境、接触面与使用关系调整自然细节，不均匀噪声铺满。优先现有 HDA 参数；新增通用规则入所属 HDA“效果优化”，避免 HIP 外层补丁与无关材质改动。',[src('houdini-first-workflow')]],
 preview:['在唯一场景 Geo 集成当前阶段 OUT，用 MCP 聚焦有效 Preview 看实际模型，检查相关结构、接地、穿插、通路和净空。先修共同根因，不逐物件加偏移；三个 Final 只消费最终汇总供导出，不反供制作。此检查不渲染、不代替引擎实图。',[src('houdini-first-workflow'),src('ue-final-export')]],
 performance:['对新建或实际修改的大数据分支记录本次输入规模、主要耗时、可获得内存和常用参数一次重算范围，区分首次 cook、改参和缓存。定位具体瓶颈后才比较适用 SOP/VEX，不做机械重写或无关全场基准测试。检查优化未破坏 mask、禁刷、接地、稳定 ID 与 Seed；同名说明记必要结果，未测项诚实标注。',[hda('sop-vex-performance')]],
 delivery:['按子阶段完成缓存、仅本岛重建、MCP 实图检查和必要修复，然后正式保存交接。没有独立最终人工验收等待关卡；用户后续反馈另处理范围。',[src('island-ue-preview')]],
 cache:['核实 AGame_Island_Cache 的当前真实定义、类型、接口、岛名与输出路径；Final Landscape/PTS/Geo 完整且同轮，必要空输出有效。若一个实际按钮输出三类，只执行一次；完成后回读新鲜度、内容与属性，失败不使用旧文件凑齐。',[src('ue-final-export'),src('island-ue-preview')]],
 rebuild:['通过已连接的官方 UE MCP 唯一定位本岛关卡/文件夹/HDA Actor，核对三个缓存来自本轮且没有进行中的 Cook/Rebuild/PIE。仅 Rebuild 本岛，等待并核实完成；超时先查状态，不全关卡重建或擅自改材质插件。',[src('island-ue-preview')]],
 iterate:['通过 MCP 设置并回读合适视角、截图并实际看图；优先复用有效视角。先修本次明显 bug，再处理1–2项关键观感差距。在已确认方案内完成 HDA 调整→三缓存→本岛 Rebuild→可比实图闭环；有具体问题才新一轮，无改善先修正判断。不要每次换镜头或重新生成参考掩盖差异。目标达到、改善受限或用户要求收尾时停止迭代，记录实际检查与未测项，不追加最终验收循环。',[src('island-ue-preview'),src('houdini-first-workflow'),src('scene-aesthetic-review')]],
 publish:['完成必要保存与正式发布，交接 HIP、实际改动 HDA/依赖/同名说明和索引、三类缓存、UE 对应 Actor、有效截图与剩余限制。HDA 参数经验写到本流程独立档案，不写回原 Skill。将先前创建的基准资源条目更新 stage=scene_delivered，并追加真实 sceneRunId、HIP 与交付信息，不另造新基准。用户明确接手/收尾时只完成必要保存交接，不追加复核。所有必需节点完成后 AI 用 finish 提交本轮总结；下一任务另行启动。',[src('island-ue-preview'),hda('hda-parameter-recipes')]]
 };
 for(const [id,n] of nodes){assert(instructions[id],id);document(b.id,n,...instructions[id]);}
 b.graphs=b.graphs.map(layout);validateDefinition(b);

 const derivative:WorkflowDefinition={schemaVersion:1,id:derivativeId,title:'AGame · 衍生岛屿批量制作',description:'选择已确认基准、填写目标与数量，逐岛设计不同布局并交付初始 HIP；过程数据与成果保存到实例集。',category:'Skill 工作流',revision:0,archived:false,updatedAt:'',rootGraphId:'main',graphs:[],globalConstraints:derivativeConstraints};
 const dn=(id:string,title:string,summary:string,body:string,criteria:string[],refs:string[],extra:Partial<NodeDefinition>={})=>{const n=node(id,title,summary,criteria,extra);document(derivative.id,n,body,refs);return n;};
 const scope=dn('scope','选择基准与填写目标','选择已有基准，填写衍生方向与保留要求。','读取 scope 的 baseline、goal、pictures 和 preserve，以及 batch.count。从 run.inputSnapshots.resources 精确读取所选资源，核对已确认原图、revision、哈希和档案，实际看图；不能使用当前 HIP 或最近迁移图替代。目标数量必须已填且为正整数。附图只用于提炼要求，不改所选基准身份。保存 baseline_id/revision/hash、用户选择依据、风格保留清单与制作终点；历史资源依据缺失如实标注，不伪造也不强制重跑首次选材。',['所选基准原图、档案、修订和哈希已核实','用户目标、明确数量及初始 HIP 交付范围已记录'],[src('island-baselines'),src('workflow-reporting')]);
 addProperties(scope,[property('baseline','使用哪个基准岛屿','resource',{required:true,resourceCategory:'基准岛屿',help:'从已确认基准库选择，保留原基准不变。'}),property('goal','想做怎样的衍生岛屿','textarea',{required:true,help:'描述希望的空间变化、用途或差异方向。'}),property('pictures','补充参考图片','image',{help:'供 AI 理解要求；概念生成仍采用文字描述。'}),property('preserve','必须保留 / 禁止出现','textarea'),property('styleKey','英文命名前缀（可选）','text',{help:'留空沿用基准档案；缺失时先确定合法前缀。'}),property('startIndex','起始编号（可选）','number',{integer:true,min:1,help:'留空查找空闲编号；绝不覆盖已有 HIP。'})]);
 const plan=dn('batch_plan','设计整批差异方案','确定每座岛的地形、聚落和路网差异。','读取所选基准风格身份与原空间骨架，为明确数量 N 制作一张差异表，每岛给建议长宽/高差、岸线骨架、高低地关系、道路拓扑和聚落组织。岸线与地形必须显著变化，道路或聚落至少一项显著变化，整批也不重复；选2–3个互相支持的主变化而非极端题材。设计尺寸标建议而非基准实测。保存 JSON islands[{iteration,style_key,designLength,designWidth,coast,terrain,roads,settlements}] 到实例；后续按 iteration 消费。已有方向与数量明确直接推进，不逐岛额外审批；关键资源/题材变化先解决实际缺口。',['每个实例都有独立空间方案与设计尺寸','基准及整批比较满足风格保留和结构差异要求'],[src('island-baselines')]);
 const batch=dn('batch','逐岛生成与初始 HIP','按填写数量逐岛生成，分别保存结果。','本节点 repeat 绑定自己的 count，sequential 顺序执行。每份独立 nodeKey 与 iteration，共享只读基准与整批方案；同一 Houdini 会话仅一个写入者。先检查整批方案已有 N 份，每岛全部步骤完成后才能进入下一岛。恢复读取实例资料与外部任务状态，不重做已通过参考或重复付费。父节点仅在所有实例子节点及对应文件完整后完成。',['指定数量的独立岛屿均完成子流程','每岛效果图、地形参考、模型与 HIP 映射完整'],[src('workflow-reporting')],{kind:'subflow',subflowId:'island',repeat:{propertyId:'count',mode:'sequential'},properties:[property('count','生成几个岛屿','number',{required:true,integer:true,min:1,max:100,help:'请明确填写数量；不预填，避免误开批量付费任务。'})]});
 const summary=dn('summary','汇总整批成果','汇总每座岛的文件、差异与检查结果。','检查实际已交付数量与 batch.count 相等，按实例序号整理简短清单：基准ID/修订/哈希、独立空间方案、有效效果图与地形图、模型任务ID、FBX/Base Color、初始HIP、必要检查状态及未测项。文件重名或缺失先处理，不以请求次数算完成数量。成果保存实例集，历史失败保留；每岛默认仅一个HIP及必需输入，不生成多份说明/测试工程。衍生岛不自动收录为新基准，不继续场景制作或UE；节点完成后 AI finish 总结本批。',['交付数量及所有文件对应关系已核对','实例资料可恢复，未测项与衍生边界已说明'],[src('workflow-reporting'),src('terrain-hip-from-mesh')]);
 derivative.graphs.push(graph('main','输入 → 批量生成 → 汇总',[scope,plan,batch,summary]));
 const design=dn('design','读取本岛设计','读取本份方案，锁定命名与设计尺寸。','沿 parentKey 找到 batch 下当前岛 iteration，从 batch_plan 保存数据读取对应方案。核对 style_key、长宽、可用编号及文件路径，和已完成其他岛对比。不得把首岛数据复制成全批相同方案，设计没有可辨差异先回到本阶段修正并保存实例。',['当前序号对应方案、尺寸和安全文件名已锁定'],[src('island-baselines'),src('terrain-hip-from-mesh')]);
 const concept=dn('concept','生成衍生效果图并审查','生成不同布局，检查风格与结构差异。','官方 imagegen 文生图只输入基准的文字风格保留项、新空间方案和 UE 写实要求，不传基准图或上一岛图片，不使用最近图片。实际对照基准和已完成本批岛：风格不跑偏、岸线和高低地组织显著变、道路或聚落至少一项显著变；旋转、镜像、换机位不算。缓岸为主，失败先改本图，不进入付费模型；连续两次针对性返工仍失败上报具体阻塞。通过后的原图与检查写入当前实例。',['实图风格与基准相容，空间结构及批内差异明确','通过的本岛原图与检查依据已保存'],[src('island-baselines'),src('workflow-reporting')]);
 const roads=dn('roads','制作本岛地形与路网','从本岛图提取地形，核对并锁定连续路网。','只消费本岛 concept 的有效图。纯地形提取与可见路网核对可独立准备，汇合后锁定合成；不借基准或另一岛的地形和路网。',[ '本岛纯地形与锁定路网检查通过'],[src('terrain-road-reference')],{kind:'subflow',subflowId:'roads'});
 const high=dn('highpoly','生成并检查高模','提交本岛地形高模，跟进并检查实际结果。',instructions.highpoly[0],get('highpoly').criteria,[src('workflow-reporting')]);
 const fbx=dn('fbx','整理 FBX 与颜色贴图','转换验证模型，保存真实颜色贴图。',instructions.fbx[0],get('fbx').criteria,[src('workflow-reporting')]);
 const hip=dn('initial_hip','创建本岛初始 HIP','复用现有工具，保存地形与曲线工程。',instructions.initial_hip[0]+' 本衍生流程到此岛初始工程为止，不追加场景建筑生态、正式缓存写出或 UE Rebuild。',get('initial_hip').criteria,[src('terrain-hip-from-mesh'),src('ue-final-export'),...commonRefs]);
 derivative.graphs.push(graph('island','每座衍生岛屿',[design,concept,roads,high,fbx,hip]));
 derivative.graphs.push(graph('roads','本岛地形与连续路网',['terrain_image','road_lines','compose'].map(id=>{const old=get(id);return dn(id,old.title,old.description,instructions[id][0],old.criteria,instructions[id][1]);}),[['terrain_image','compose'],['road_lines','compose']]));
 validateDefinition(derivative);

 // Static acceptance uses isolated in-memory data only; it never starts production runs.
 for(const def of [b,derivative]){for(const g of def.graphs)for(const n of g.nodes){assert(n.description.length<=60);assert(docs.has(n.mdPath));for(const p of n.references)assert(docs.has(p));}assert(def.globalConstraints?.includes('cook'));}
 const snapshots=Object.fromEntries([...docs].map(([p,content])=>[p,{path:p,content,hash:sha(content)}]));
 assert.throws(()=>createRun(b,snapshots),/请填写/);assert.throws(()=>createRun(derivative,snapshots),/请填写/);
 for(const count of [1,3,4]){const check=structuredClone(derivative);check.graphs[0].nodes.find(n=>n.id==='scope')!.inputValues={baseline:resources[0].id,goal:'仅用于内存结构校验'};check.graphs[0].nodes.find(n=>n.id==='batch')!.inputValues={count};const run=createRun(check,snapshots);assert.equal(run.nodes.batch.children.length,6*count);assert.ok(run.nodes[`batch/${count}/roads/compose`]);if(count>1)assert.ok(run.nodes['batch/2/design'].dependencies.includes('batch/1/initial_hip'));assert.deepEqual(run.nodes.summary.dependencies,['batch']);assert.equal(run.definition.globalConstraints,derivativeConstraints);}
 fs.writeFileSync('logs/agame-redesign-preview.json',JSON.stringify({baseline:b,derivative,documentPaths:[...docs.keys()],checks:'结构、必填、1/3/4 个独立实例及顺序依赖通过'},null,2));
 if(apply){
   // Persist all new documents first. Existing documents and prior definition versions remain recoverable.
   for(const [p,content] of docs)await call('workflow_document_write',{path:p,content,expectedHash:null,operationId:randomUUID()});
   const savedBase=await call('workflow_save',{workflow:b,expectedRevision:base.revision,operationId:randomUUID()});
   const savedDerivative=await call('workflow_save',{workflow:derivative,expectedRevision:0,operationId:randomUUID()});
   for(const expected of [savedBase,savedDerivative]){const actual=await call('workflow_get',{workflowId:expected.id});assert.deepEqual(actual,expected);for(const n of actual.graphs.flatMap((g:any)=>g.nodes)){assert(fs.existsSync(n.mdPath));for(const p of n.references)assert(fs.existsSync(p));}}
   assert.deepEqual(inventory(source),originalSkill,'原 Skill 文件发生变化');
   const after=await call('workflow_list');assert.equal(after.runs.length,list.runs.length,'不应启动任何制作运行');
   const result={baseline:{id:b.id,revision:savedBase.revision,nodes:b.graphs.reduce((s,g)=>s+g.nodes.length,0)},derivative:{id:derivative.id,revision:savedDerivative.revision,nodes:derivative.graphs.reduce((s,g)=>s+g.nodes.length,0)},documents:docs.size,resources:resources.filter((r:any)=>r.category==='基准岛屿').map((r:any)=>r.title),originalSkillUnchanged:true,productionStarted:false};fs.writeFileSync('logs/agame-redesign-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }else console.log(JSON.stringify({preview:'logs/agame-redesign-preview.json',documents:docs.size,validated:true,applied:false}));
}finally{await client.close();}
