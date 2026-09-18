import fs from 'node:fs';
import {agameSummaries} from './agame-summaries.js';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {validateDefinition,expand} from '../server/engine.js';
import type {NodeDefinition,GraphDefinition,WorkflowDefinition} from '../shared/types.js';

const source='C:/Users/muyue/.codex/skills/agame-scene-assets';
const sha=(s:Buffer|string)=>createHash('sha256').update(s).digest('hex');
function inventory(dir:string):Record<string,string>{return Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name);return e.isDirectory()?Object.entries(inventory(p)):[[p,sha(fs.readFileSync(p))]];}));}
const before=inventory(source);
const client=new Client({name:'codex-agame-template-author',version:'1.0.0'});
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:43127/mcp')));
async function call(name:string,args:Record<string,unknown>={}){const r=await client.callTool({name,arguments:args});const v=JSON.parse((r.content as any[]).find(x=>x.type==='text').text);if(r.isError)throw Error(JSON.stringify(v));return v;}
try{
 const listed=await call('workflow_list');
 const id='agame-scene-assets-baseline';
 assert(!listed.workflows.some((w:any)=>w.id===id),'已有同 ID 流程，停止以免覆盖用户编辑');
 const meta=await(await fetch('http://127.0.0.1:43127/api/meta')).json();
 const folder=path.join(meta.root,'documents',id);
 const refs=new Map<string,string>();
 async function write(p:string,content:string){await call('workflow_document_write',{path:p,content,expectedHash:null,operationId:randomUUID()});}
 async function reference(name:string){if(refs.has(name))return refs.get(name)!;const p=path.join(source,name==='SKILL'?'SKILL.md':`references/${name}.md`);assert(fs.existsSync(p),p);const target=path.join(folder,'sources',`${name}.md`);await write(target,`<!-- 只读参考副本；原文件：${p}；SHA256：${before[p]}。本工作流以独立节点说明为执行入口；不修改原 Skill。 -->\n\n`+fs.readFileSync(p,'utf8').replace(/\]\(([^)]+)\)/g,(m,link)=>{if(/^(https?:|#|[A-Za-z]:)/.test(link))return m;const [file,anchor]=link.split('#');return `](<${path.resolve(path.dirname(p),file).replaceAll('\\','/')}${anchor?'#'+anchor:''}>)`;}));refs.set(name,target);return target;}
 const common=`## 执行约定\n\n这是独立流程模板，创建模板不授权场景制作、付费生成或资源同步。执行前由用户给出本次目标与范围；首次基准完整生产才使用本主线，已有 HIP 小改或批量迁移应另建裁剪流程。\n\n原 agame-scene-assets Skill 整个目录只读，包括原脚本、库存、基准目录及经验文档。新增基准档案与任务记录写到本工作流独立成果目录，禁止写回原 Skill。引用副本用于追溯，副本中链接到原文件时同样只读。\n\n每阶段先读取 workflow_context，使用运行冻结文档；enter 后才开始，完成时逐项提交 checks、成果说明和真实文件路径。人工节点只能由用户在界面完成，已有明确确认可由用户直接标记，不要求重新作选择。缺输入或模式不符则上报阻塞，不猜测或跳过。\n\n第0阶段按实际计划模式完成只读选材与设计；不能在普通执行模式冒充计划模式。未允许持久化时在计划正文交接，切换执行模式并获得启动指令后再保存生产成果。流程定义不是已执行成果。\n\n同一 HIP、Houdini 会话、HDA、发布目标和同步队列只允许一个写入者。并行仅用于稳定输入的只读核实/独立配方；共享场景写入串行。AI 不用用户身份接口完成门禁。\n\n子流程所有子节点通过后还要检查父节点条件。重试保留历史；修改执行要求先暂停并预览影响，再应用新版本。实图迭代在本节点内按已确认范围进行，没有自动循环边。大步骤汇报实际剩余步骤与汇合点。\n`;
 const graphs:GraphDefinition[]=[];
 async function node(id:string,title:string,instructions:string,criteria:string[],refNames:string[],subflowId?:string,manual=false):Promise<NodeDefinition>{const mdPath=path.join(folder,'nodes',id+'.md');const references=await Promise.all([]) as string[];for(const r of ['SKILL',...refNames])references.push(await reference(r));await write(mdPath,`# ${title}\n\n## 本阶段工作\n\n${instructions}\n\n## 完成条件\n\n${criteria.map(c=>'- '+c).join('\n')}\n\n## 完成方式\n\n${manual?'仅用户完成；AI 提交待确认内容后进入等待。':'AI 或用户；AI 必须提交可检查的依据。'}\n\n${common}\n## 参考\n\n${references.map(p=>`- [${path.basename(p)}](<${p.replaceAll('\\','/')}> )`.replace('> )','>)')).join('\n')}\n`);return{id,title,kind:subflowId?'subflow':'task',description:agameSummaries[id]??(()=>{throw Error('缺少简短阶段说明：'+id);})(),mdPath,references,criteria,completion:manual?'user_only':'ai_or_user',subflowId,position:{x:0,y:0}};}
 function graph(id:string,title:string,nodes:NodeDefinition[],pairs?:string[][]){const links=pairs??nodes.slice(1).map((n,i)=>[nodes[i].id,n.id]);const edges=links.map(([source,target])=>({id:source+'_'+target,source,target}));const depth=new Map<string,number>();function rank(id:string):number{if(depth.has(id))return depth.get(id)!;const d=Math.max(0,...edges.filter(e=>e.target===id).map(e=>rank(e.source)+1));depth.set(id,d);return d;}const rows=new Map<number,number>();for(const n of nodes){const d=rank(n.id),r=rows.get(d)||0;n.position={x:40+d*330,y:60+r*205};rows.set(d,r+1);}graphs.push({id,title,nodes,edges});}
 const N=node;
 graph('planning','第0阶段 · 选材与设计',[
  await N('recommend','推荐资源组合','读取美术经验入口与相关反馈；仅查询本需求相关库存。提出首选/备选组合、用途、证据、缺口和可玩性风险；未选定前不出图、不制作。',['推荐包含真实资源 ID、用途、证据与缺口'],['asset-selection','baseline-preparation']),
  await N('select','用户确认选材','展示明确主包、补件和排除项，等待用户选择。拥有状态不能替代本场景选择。',['用户明确选定本场景资源及用途'],['asset-selection'],undefined,true),
  await N('elements','核实元素与角色','优先已有 Houdini 缓存，再核实 UE 包内真实模块和示例 Level；记录 direct/adapt/missing/unknown 与证据，不启动同步。',['关键画面元素均对应已选包与真实证据','影响主体的缺件已有处理决定'],['baseline-preparation','maintenance']),
  await N('design','设计岛屿参考方案','根据已核实元素设计岸线、台地、聚落、路线与林缘；平缓海岸为主。形成设计长宽/高差、构图与提示词草案，明确假设。',['空间方案及参考图草案可追溯到已选元素','设计尺寸和未决项已明确标注'],['baseline-preparation','workflow-reporting'])
 ]);
 graph('concept','参考图与独立基准档案',[
  await N('image','生成并审查基准图','执行模式持久化计划；官方 imagegen 依据已选元素出图，实际查看 UE 写实观感、缓岸、通路及资源一致性；偏离先修参考。',['实际图片通过资源一致性、空间关系及缓岸检查'],['baseline-preparation','workflow-reporting']),
  await N('approve_image','用户确认基准图','向用户展示通过 AI 自检的原图与主要判断；等待用户确认作为基准。',['用户明确确认本图作为基准'],['island-baselines'],undefined,true),
  await N('baseline_record','保存独立基准档案','将原图原样复制到本工作流独立 artifacts/baselines 目录，核对哈希并记录 ID、修订、style_key、确认依据、元素映射与风格。根据用户“不要动原 Skill”，不写原 Skill 的 catalog.json 或 assets；此处是独立档案，不宣称已收录原知识库。',['原图复制后哈希一致且可读取','独立档案有 ID、资源依据和用户确认记录'],['island-baselines'])
 ]);
 graph('road_reference','纯地形与连续路网',[
  await N('terrain_image','提取纯地形背景','由本岛已确认效果图提取纯地形，保持岸线、机位与高差；移除建筑植被道具及水面遮挡，不重设计路网。',['地形背景保持本岛机位、岸线和缓坡关系'],['terrain-road-reference']),
  await N('road_lines','核对并补齐路网','对照同一原图记录可见路段，设计遮挡段和可编辑中心线；保留合理终点，推断段明确标注。',['完整路网含可见依据、控制点与明确推断段'],['terrain-road-reference']),
  await N('compose','锁定合成与自检','使用原 Skill 已有合成脚本只读运行，输入输出另置任务目录。相同中心线置顶合成到效果图及地形图，检查连接、终点、错穿和未覆盖原图。',['两个底图使用同一锁定线网且原图未覆盖','连通性、推断段与地形对齐已检查'],['terrain-road-reference'])
 ],[['terrain_image','compose'],['road_lines','compose']]);
 graph('terrain','地形参考 → 高模 → 初始 HIP',[
  await N('roads','地形与路网参考','进入内部并完成两个独立图像/线网准备分支，再汇合审查。',['地形背景与路网合成均通过检查'],['terrain-road-reference'],'road_reference'),
  await N('highpoly','生成并检查地形高模','仅在用户已启动相应生成范围且数量明确时提交高模任务。先查已有任务，保存任务 ID 并跟进模型；不充值、不重复付费提交。实际核实岸坡、结构与红线表现。',['高模任务完成且真实模型已读取检查','任务 ID 与对应地形参考关系已保存'],['workflow-reporting']),
  await N('fbx','交付 FBX 与 Base Color','用隔离转换器提取真实绑定颜色贴图并转 FBX，回读几何、单位、UV、法线和贴图。验证后按原规则可恢复地回收本任务源 GLB，保留必要缓存及记录。',['FBX 回读与真实 Base Color 绑定验证通过'],['workflow-reporting']),
  await N('initial_hip','复用 HDA 创建初始 HIP','先读项目 HDA_LIBRARY.md 及 AGame_Island_From_Mesh 同名说明，核实真实契约与依赖。在独立工程使用一个 Geo，HeightField 域两边均为 2×max(设计长,宽)，接地形/曲线两路。按规定英文命名存 PipeLine，FBX/颜色放 fbx；接三 Final 与缓存 HDA，此步不导出。',['初始 HIP 及必要输入已保存且未覆盖无关工程','计算域、地形/曲线输出及缓存终端契约已核实'],['terrain-hip-from-mesh','ue-final-export'])
 ]);
 graph('readiness','资源与 HDA 就绪汇合',[
  await N('assets','核实资产并补齐必需缓存','按已选必需模块检查源路径、签名与可读几何；仅缺失/过期项增量同步。同步队列单写入者；全部必需项 Ready 后才能制作。',['全部必需模块缓存可读、签名匹配且无未处理错误'],['maintenance']),
  await N('hda_scan','只读评估 HDA 复用','读取项目索引和匹配 HDA 同名说明，先判断参数能否满足，再判断兼容扩展；记录输入输出与约束。只读，不与同步分支并发写场景。',['已有 HDA 候选、接口、复用决定与缺口清楚'],['houdini-first-workflow']),
  await N('join','汇总制作前置','两个分支全部完成后核实目标 HIP、现有 Geo、有效阶段 OUT、资产输入和临时目录。缺项阻塞，不从必需列表静默删除。',['目标 HIP、Geo、有效 OUT 及全部必需资源已绑定'],['maintenance','houdini-first-workflow'])
 ],[['assets','join'],['hda_scan','join']]);
 graph('production','Houdini 场景制作',[
  await N('scene_plan','实图分析与程序化方案','按需读取专业制作 Skill、美术经验和反馈；通过 MCP 获取本岛现状及必要参考。提出本轮关键差距、保留项与可复用 HDA 方案；已有确认沿用。',['方案说明关键差距、制作边界与可核实目标'],['houdini-first-workflow','island-ue-preview']),
  await N('approve_plan','用户确认制作方案','展示程序化方案及必要参考，等待用户明确确认范围。已确认范围内优化无需逐轮重新审批；新范围另行确认。',['用户明确确认本轮场景制作方案'],['houdini-first-workflow'],undefined,true),
  await N('layout','布局与结构 HDA','执行容器检查，所有系统留在目标现有 Geo；先参数后内部网络，Wrangle/VEX 优先。复用资产与职责明确的 HDA，锁定主建筑锚点、路线、入口和净空，不造普通模型，不设场景白盒阶段。',['布局符合已定锚点与通路约束','有效阶段 OUT、公开接口及下游消费者已同步'],['houdini-first-workflow']),
  await N('ecology','生态与道具布置','复用 HDA 与已核实模型；环境 mask 联合控制坡度、高度、生态、道路及建筑禁刷。道具按功能、支撑、间距和朝向组织。共享 HIP 写入按顺序执行。',['生态遵循环境 mask 且重要通路无侵占','道具的支撑、尺度、功能关系通过必要检查'],['houdini-first-workflow']),
  await N('weather','风化与自然细节','复用对应通用 HDA，依据材质、生境和表面关系制作风化；保留主体可读性，不用噪声或加密掩盖结构缺陷。',['风化已处理并有实际检查依据'],['houdini-first-workflow','workflow-reporting']),
  await N('preview','集成与 Preview 检查','MCP 聚焦本岛 HDA、自主设置视口，实际看截图核实结构、接地、通路与净空；修复本范围根因。同步阶段 OUT 和 Final 汇总，Preview 不替代 UE 实图。',['相关结构、接地、通路与净空已检查','最终汇总完整且 Final 仅供导出链消费'],['houdini-first-workflow','ue-final-export'])
 ]);
 graph('delivery','UE 实图闭环与收尾',[
  await N('cache','写出并核对三类缓存','核实 AGame_Island_Cache 实际定义、接口、岛名和按钮，写出 Landscape/PTS/Geo；合法空结果也输出，不复用旧缓存凑数。',['同一轮三类缓存均可读、新鲜、类型与属性正确'],['ue-final-export','island-ue-preview']),
  await N('rebuild','仅重建本岛输出','优先用户连接的 UE 官方 MCP，核实项目、关卡、Actor 和三缓存输入；仅 Rebuild 本岛，超时先查状态，不扩大为 Bake 或全关卡操作。',['对应本岛 Actor 重建完成并引用本轮三缓存'],['island-ue-preview']),
  await N('iterate','实图对比与必要修复','MCP 定位取景并回读，再截图实际检查；先修本范围物件 bug，再选最关键 1–2 项差距。已确认范围内按 HIP/HDA 调整→三缓存→本岛 Rebuild→可比截图迭代，达标即收尾；具体阻点如实报告，不以工具成功替代通过。',['主要制作目标有真实截图与对比依据','关键缺陷已解决，限制和未测项如实记录'],['island-ue-preview','houdini-first-workflow']),
  await N('publish','保存、发布与交接','保存 HIP；实际修改的 HDA 按范围正式发布并同步项目同名 MD/索引。交接缓存、Actor、视角、实图与未测项；经验记独立任务文档，不写原 Skill。用户自行玩法/性能验收，不添加独立最终人工等待关卡。所有节点完成后 AI 提交总体总结 finish。',['正式成果已保存，交接路径与真实状态完整','本轮总结区分已检查、未测及剩余限制'],['workflow-reporting','island-ue-preview'])
 ]);
 graph('main','AGame · 首次基准岛屿完整制作',[
  await N('scope','确认本次目标与适用范围','使用前填写场景目标、预期产物、可写工程与资源范围。此模板用于首次完整基准岛屿生产；纯查询、已有基准批量迁移、局部微调不运行全线，应另建相应流程。缺少目标时先询问；创建本模板不意味着用户已启动制作。',['本次目标、实际范围、所需输入与执行边界已明确'],['SKILL']),
  await N('planning','第0阶段 · 选材与设计','在实际计划模式执行内部选材、元素核实和布局设计，不启动制作。',['第0阶段各子节点完成且关键缺口已解决'],['baseline-preparation'],'planning'),
  await N('start_production','切换执行模式并启动制作','向用户交接计划，待实际执行模式且用户明确启动相应范围；不能把创建模板、点击进入或沉默当作付费与生产授权。用户在界面标记此门禁。',['系统已处执行模式且用户明确启动约定范围'],['baseline-preparation'],undefined,true),
  await N('concept','第1步 · 基准参考图','依照计划生成与审图，用户确认后保存到独立基准档案。',['基准图通过检查与用户确认，独立档案已保存'],['baseline-preparation'],'concept'),
  await N('terrain','地形与初始 HIP','完成内部纯地形/连续路线、高模、FBX 和初始 HIP 交接。',['参考、高模、FBX 和初始 HIP 对应关系完整'],['terrain-hip-from-mesh'],'terrain'),
  await N('readiness','资产与 HDA 就绪','并行准备资源核实及只读 HDA 评估，全部汇合后才进入制作。',['资源与 HDA 前置通过，目标容器已绑定'],['maintenance'],'readiness'),
  await N('production','布局、生态与风化','按已确认方案在同一 Geo 内顺序组合可复用 HDA。',['布局、生态、道具、风化及集成检查完成'],['houdini-first-workflow'],'production'),
  await N('delivery','UE 实图闭环与交付','完成三缓存、本岛重建、实际截图对比及必要修复，保存发布后提交总结。',['实图目标及保存交接完成，所有必要阶段有依据'],['island-ue-preview'],'delivery')
 ]);
 const def:WorkflowDefinition=validateDefinition({schemaVersion:1,id,title:'AGame · 首次基准岛屿完整制作',description:'基于 agame-scene-assets 的独立可编辑模板。原 Skill 只读；新基准档案保存在工作流成果目录。含第0阶段、参考图、地形/路网、初始 HIP、资源/HDA 汇合、布局生态风化、UE 实图闭环。先填写任务目标再执行；不含可选批量迁移或局部微调。',category:'Skill 工作流',archived:false,revision:0,rootGraphId:'main',graphs,updatedAt:''});
 const expanded=expand(def);assert.equal(Object.keys(expanded).length,graphs.reduce((n,g)=>n+g.nodes.length,0));
 for(const g of graphs)for(const n of g.nodes){assert(n.criteria.length>0);for(const p of [n.mdPath,...n.references])assert(fs.existsSync(p),p);}
 const saved=await call('workflow_save',{workflow:def,expectedRevision:0,operationId:randomUUID()});
 const readback=await call('workflow_get',{workflowId:id});assert.deepEqual(readback,saved);
 const afterList=await call('workflow_list');assert(!afterList.runs.some((r:any)=>r.workflowId===id),'不应启动运行');
 assert.deepEqual(inventory(source),before,'原 Skill 文件内容或文件集合发生变化');
 const report={workflowId:id,title:saved.title,revision:saved.revision,graphs:graphs.length,nodes:Object.keys(expanded).length,manualNodes:graphs.flatMap(g=>g.nodes).filter(n=>n.completion==='user_only').length,maxDepth:Math.max(...Object.keys(expanded).map(k=>k.split('/').length)),sourceFilesUnchanged:Object.keys(before).length,sourceHashes:before,folder,runStarted:false};
 await write(path.join(folder,'README.md'),`# ${saved.title}\n\n这是独立模板，尚未开始执行。\n\n- ${report.graphs} 个画布，${report.nodes} 个节点，最深 ${report.maxDepth} 层，${report.manualNodes} 个人工确认节点。\n- 原 Skill 全目录 ${report.sourceFilesUnchanged} 个文件生成前后 SHA256 与文件集合一致。\n- 双击子流程逐层进入；节点 MD 位于 nodes，来源副本位于 sources。\n- 首次使用先编辑“确认本次目标与适用范围”。\n- 基准收录和经验记录使用独立目录，不写回原 Skill。\n- 本流程不包含第12步批量迁移、单独库存查询或已有场景小改；这些入口需要独立裁剪。\n- 查看流程不代表授权生产；实际开始需用户目标与启动指令。\n`);
 fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/agame-template-created.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({...report,sourceHashes:undefined},null,2));
}finally{await client.close();}
