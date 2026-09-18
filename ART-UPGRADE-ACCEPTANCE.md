# 原画与多系统改版验收

## 已验证

- TypeScript 类型检查通过；生产构建通过（保留现有 Vite 大包提示）。
- 自动化测试 34/34 通过，覆盖旧流程兼容、版本/幂等、正式输出、图片 ID、人工门禁、跨子流程绑定、重试失效、资源多选与快照隔离。
- 隔离浏览器库验证正式图集显示图片链接；效果制作节点显示同一图片及来源 nodeKey、attempt、流程版本；木屋与集装箱测试资源同时显示，并可独立取消/重新选择。
- 流程草案 schema 校验通过：41 个节点；内存中启动校验通过，默认远/中/近 1/3/3，未生成的绑定输入不阻止建立待执行实例。未持久化任何真实生产实例。
- 与第 5 版比较：globalConstraints 完全相同；所有原节点、原填写值、原输入属性和人工门禁保留。

## 发布记录

已发布：`agame-scene-assets-baseline` 第 6 版，2026-09-18T12:07:30Z。28 份文档及完整定义均已通过真实 MCP 回读；5 个已有实例在维护重启和发布前后完整 JSON 相同。

完整待发布定义与 28 份文档保存于 `.validation/art-upgrade-verified.json`，原文档 hash 已预读，新增文档 expectedHash=null。

发布工具：`node --import tsx scripts/publish-art-upgrade.ts`。通过真实 MCP 发现新版接口、读取最新流程、核对全部文档 hash，逐项写文档并保存定义，再回读核验。旧实例 JSON 前后必须完全一致。此脚本不重启服务，不建立/执行/应用任何实例。

实际发布状态以 `.validation/art-upgrade-publication.json` 中的 savedRevision、verifiedAt 和 beforeRunsHash/afterRunsHash 为准；没有这些记录时不能声称已发布。旧服务不支持新接口时脚本拒绝写入，避免字段被静默丢弃。

## 生产边界

测试图片和木屋/集装箱条目只在独立验收库中，明确为测试，不代表真实 HDA 已实现。此次不生成原画、不制作 HDA、不修改 HIP、不操作 UE、不修改原 Skill。真实系统的登记和完整图集生成在用户正式执行新版实例时完成。
