# 正式输出、图片参考与程序化系统

## 节点接口

`properties`、`inputValues` 和 `defaultValue` 继续分别表示输入接口、用户填写值和默认值。`outputProperties` 声明执行产物，支持同一组属性类型，但禁止默认值；`required` 表示完成前必须存在。运行输出不保存到模板。

```json
{
  "outputProperties": [{"id":"referenceImages","label":"原画图集","type":"image","required":true}],
  "inputBindings": {"referenceImages":{"nodeKey":"concept/baseline_record","outputId":"referenceImages"}}
}
```

上例分别展示生产节点的声明和消费节点的绑定。消费节点还须声明同类型的输入属性。只支持同一运行内、现有流程顺序保证完成的上游；不自动增加隐藏依赖。完整节点路径例如 `concept/baseline_record` 或 `batch/1/design`，不使用 graphId 前缀、通配符或“最近结果”。重复子流程的各次实例不得猜测来源。

绑定优先于手动值，但原填写值保留，解绑后恢复。建立实例时允许上游尚未产出；进入消费节点时解析并冻结值、生产 attempt、流程版本及图片/资源快照。批量展开数量不能绑定执行后才产生的输出。

## 写入和消费

使用 `workflow_output_write({runId,nodeKey,values,expectedRevision,operationId})` 写入当前 running 节点的输出。支持分批写入已声明字段，使用返回的 revision；同一请求重试沿用 operationId。图片须先 `workflow_image_import`，不能用路径冒充 ID；服务核实文件存在、内容哈希和字段类型。MCP 身份固定 AI，不能代替人工确认。

必需输出缺失阻止节点完成。消费者只读取已完成生产节点的本轮输出。已完成输出不能修改，需要重试节点；重试使相关下游失效，旧记录在 `outputEntries` 保留。应用新定义须暂停、预览影响，不能自动升级已有实例。

`workflow_context` 增加 `nodeOutputs`、`bindings`、`outputInstruction`。节点 `outputs/outputSnapshots` 是当前轮次的产物，`inputs/inputSources/inputSnapshots` 是进入时冻结的消费数据。缺失来源在 bindings.error 指明。实际看图使用 `workflow_image_read`，不能只读取清单便声称查看过。

## 一个岛屿复用多个系统

`resources` 类型是最多 20 个不重复资源 ID 的数组，`resource` 保持原单选行为。将 `resourceCategory` 设为 `程序化系统`，即可在“本岛引用系统”中组合木屋、集装箱、道路等不同系统。分类名称是筛选条件，不代表系统已验证。

系统作为独立资源保存：title、description、mdPath、imageIds，以及 metadata 中的 hdaPath、typeName、version、applicability、dependencies、parameters、validationStatus。版本应包含实际 HDA 类型版本，依赖说明包含子 HDA；不以资源条目 revision 替代资产版本。每个实际交付/扩展系统都应登记，同名说明及 HDA_LIBRARY.md 仍是技术依据。

库保存系统接口与复用依据，具体岛屿布局、区域和参数保留在 HIP，不在 Flow 表单维护另一份。已选系统的资源记录、图片和说明按实例冻结。后续库更新不自动影响旧实例；破坏接口的新 HDA 版本保留旧依赖。缺失、过期或未验证系统显式说明，不通过登记操作伪造验收。

## 部署维护

正常服务重启继续执行原有恢复保护。仅在已核实没有实际任务节点执行时，可以用 `node dist-server/index.js --maintenance-restart` 更新管理器并原样保留运行快照（仅有 running 子流程容器不算外部任务）。服务会再次检查；若仍有 running 叶任务则拒绝启动。此选项不启动、恢复或完成任何工作流节点。
