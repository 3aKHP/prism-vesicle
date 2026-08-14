---
name: prism-vesicle-workflow
description: >-
  Prism Vesicle 变更分级工作流体系：Develop 直推、Quick PR、Standard PR、Huge PR、
  Hot-Fix、Release 六档的判定与执行步骤，含与独立 CR 技能（prism-vesicle-cr）的衔接、
  发布 checklist 与仓库运维支撑操作（bootstrap、audit-drift SOP、provider acceptance、
  文档同步、Harness bump、quality benchmark）。
---

# Prism Vesicle 变更分级工作流（DSH 版）

本技能把项目贡献流程固化为**六档分级工作流**。权威定义在仓库
`docs/dev/WORKFLOW.md` § Change Grading Workflow（任何 Agent 环境均可执行）；
本技能是其 DSH 可执行实现，并引用 `prism-vesicle-cr` 技能执行其中的独立 CR 环节。
预设自身源在仓库 `.dsh/agent-presets/`，本机生效副本由 `.dsh/install.sh` 同步。

## 通用铁律（每一档都适用）

- 仅在用户明确要求时 commit / push / merge / tag / 开 PR。
- Conventional Commits：`type(scope): summary`（feat/fix/docs/refactor/test/chore）。
- 验证取最小集：仅文档 → 定向 grep +（便宜时）typecheck；小代码 → lint+typecheck+聚焦测试；
  运行时域 → 再加 doctor；发布 → 全量 + pack 检查（见 `references/repo-ops.md`）。
- 同步文档在同一变更内：README / STATUS / CHANGELOG / docs/dev/* / zh-CN↔en 镜像。
- 永不提交 secrets、`.vesicle/`、生成物与本地运行时状态。
- 独立 CR 必须由**未参与实现对话**的会话执行（spawn，非 fork）；实现会话不能自评。

## 分级决策树

拿到一次变更请求后，先判定档位，再执行对应流程（细节见 `references/pr-lifecycle.md`）：

| 档位 | 适用 | 关键动作 | CR 要求 |
|---|---|---|---|
| **Develop 直推** | chore/docs 限定、小范围低风险 | 直接提交 `develop`（需用户明确要求 push） | 无 |
| **Quick PR** | 中小型低风险 | 短分支 → PR → Bot Review 一轮 → 向人类申请合并 | 无独立 CR |
| **Standard PR** | 中规模 | 短分支 → PR → **独立 CR SubAgent + Bot Review 双轨** → 无 Should-Fix → 申请合并 | Tier 1（`prism-vesicle-cr`） |
| **Huge PR** | 大规模跨模块高风险 | **开工前撰写主题文档** → 必要时拆分为多个 PR → 每 PR 走 Standard 档 → 整体 **Deep-CR** | Tier 2（`prism-vesicle-cr`） |
| **Hot-Fix** | `main`/里程碑回归阻断 | 从 `main` 分支 → 最小 patch → PR 回 `main` → 前向合并 `develop` | 按风险走 Tier 1 |
| **Release** | 发布 | release 分支 → 全量验证 + acceptance → PR 到 `main` → 独立 CR → annotated tag → push → 只读验证 | 独立 CR + 小规模 Windows 验收 |

判定参考 `docs/dev/WORKFLOW.md` "Rapid Development Exception" 的高风险清单：provider
协议/流式/适配器、模型可见工具契约/路径守卫/写语义、会话 schema/回放/恢复/迁移、
prompt 契约/stop gates/验证器/engine 剖面、大重构/跨模块、面向 `main`/tag/发布的变更
——命中即升档（至少 Standard；跨多域或 ≥8 文件或 ≥300 净 diff 行 → Huge）。

## 与 prism-vesicle-cr 的衔接

Standard 档：加载 `prism-vesicle-cr` 技能，执行 **Tier 1**（spawn 独立评审子代理，
prompt 用其 `tier1-reviewer-prompt.md`）。
Huge 档：执行 **Tier 2**（先跑 `scripts/check/deep-cr-trigger.sh <base>` 触发门，
再按其 `tier2-deep-cr-script.js` 编排 `workflow` 工具）。
两档都按 Blocking / Should-fix / Nits / Verified 词汇处理结果：Blocking 合并前修；
Should-fix 除非有记录在案的延期理由；Nits 便宜就修；Verified 进合并备注。

## 引用

- `references/pr-lifecycle.md` — Develop 直推 / Quick PR / Standard PR / Huge PR / Hot-Fix 五档详细步骤与出口条件
- `references/release.md` — Release 完整 checklist、CLI 只读验证、audit 衔接
- `references/repo-ops.md` — 支撑操作：首次 bootstrap、audit-drift fix-forward SOP、provider acceptance lanes、文档同步与 wrap、Harness bump、quality benchmark

## 注意事项

- 六档是流程骨架，不是僵化清单：档位判定最终由用户确认，技能负责把判定后的步骤跑对。
- Bot Review 指 GitHub PR 侧自动审查（一轮）；项目文档未定义具体 Bot 配置，以仓库实际
  启用的审查机制为准。
- 若要把本预设里验证过的流程沉淀为仓库 Skill（`.agents/skills/`），参考项目自带的
  `skillify` 技能（`tmp/skillify/` 草稿 → validate → publish-draft），发布前需用户确认目标。
- 本技能不授予任何能力：只读、只编排。
