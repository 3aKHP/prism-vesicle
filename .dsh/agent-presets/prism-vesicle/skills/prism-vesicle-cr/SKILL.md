---
name: prism-vesicle-cr
description: >-
  Prism Vesicle 两档独立 CR 工作流：Tier 1 独立评审子代理（默认，任何非平凡 PR）与
  Tier 2 Deep CR（高风险跨域 diff 的五镜头 workflow），把 .claude/ 中已跑熟的流程
  固化到 DSH 的 subagent 与 workflow 工具上。附带仓库文档地图、工作流规则与评审红线。
---

# Prism Vesicle 独立 CR 工作流（DSH 版）

本技能把项目在 Claude Code 中成熟的 CR 工作流固化到 DSH 工具面。权威规则始终以仓库
`docs/dev/WORKFLOW.md`、`AGENTS.md`、`CLAUDE.md` 为准；本技能只提供导航与 DSH 工具映射。

## 何时用哪一档

| 场景 | 档位 | 说明 |
|---|---|---|
| 任何非平凡 PR / 变更的独立 CR | **Tier 1** | 默认。一个独立评审子代理单遍审查。 |
| 高风险变更（见下方触发条件） | **Tier 2** | 五镜头 finder + 独立 scorer + 综合。重预算，仅触发时用。 |
| 文档/机械改动、极低风险 | 可不做或 Tier 1 | 按 `docs/dev/WORKFLOW.md` 判定。 |

Tier 2 触发条件（`scripts/check/deep-cr-trigger.sh <base>`，只读、输出 JSON）：

`trigger = CATEGORY_MATCH && (CROSS_BOUNDARY || SIZE_FLOOR || RELEASE_BRANCH)`

- CATEGORY_MATCH：变更触及高风险域（`src/providers`、`src/core/tools`、`src/core/session`、
  `src/core/checkpoints`、`src/core/prompt`、`assets/prompts`、`assets/engines`、
  `src/core/gate`、`src/core/validators`、`src/core/engine`）；
- CROSS_BOUNDARY：触及 2 个及以上上述域；
- SIZE_FLOOR：≥8 个变更文件，或 ≥300 净 diff 行；
- RELEASE_BRANCH：分支是 `release/*`/`main`，或 base 是 `main`（或 `v*` tag）。

`trigger:false` 时停在 Tier 1，不要烧 Tier 2 预算。

## 独立性铁律

独立评审者**不得参与实现对话**：

- 用 `subagent`（spawn，fresh 上下文，自包含 prompt）——不要用 `subagent_fork`
  （fork 继承父会话前缀，等于让实现者自己评审自己）。
- 你的实现会话不能充当"独立"评审；需要评审时另开子代理。
- 评审代理只读：不编辑代码、不 commit、不改分支。

## 工具映射（Claude Code → DSH）

| Claude Code 资产 | DSH 等价物 |
|---|---|
| `.claude/agents/vesicle-cr-reviewer.md`（Tier 1） | `subagent` spawn + `references/tier1-reviewer-prompt.md` 的提示词 |
| `.claude/workflows/deep-cr.js` + `/deep-cr` 命令（Tier 2） | `workflow` 工具 + `references/tier2-deep-cr-script.js`（按 `references/tier2-deep-cr.md` 改编） |
| `scripts/check/deep-cr-trigger.sh` | 直接经 `bash` 工具运行（只读） |
| `ReportFindings` 渲染 | 由主代理按 Blocking / Should-fix / Nits / Verified 呈现 |

## 流程

### Tier 1（独立评审子代理）

1. 确认 scope：`branch`（当前分支）、`base`（通常 `develop`）；必要时
   `git merge-base HEAD <base>` 校验，失败则 `git fetch origin <base>` 后重试。
2. 用 `subagent`（后台）spawn 一个 fresh 评审代理，prompt 取
   `references/tier1-reviewer-prompt.md`，填入 branch/base/变更摘要。
3. 评审结果按 Blocking / Should-fix / Nits / Verified 分类呈现给用户，按
   `docs/dev/WORKFLOW.md` "Handling CR Results" 处理。

### Tier 2（Deep CR）

1. 先跑触发门：`bash` 执行 `scripts/check/deep-cr-trigger.sh <base>`。
   - `trigger:false` → 停止，建议 Tier 1；用户明确要求才继续。
2. `trigger:true` → 调用 `workflow` 工具，脚本按 `references/tier2-deep-cr.md`
   与 `references/tier2-deep-cr-script.js` 编写（五镜头 finder → 逐条独立 scorer
   → ≥80 置信过滤 → 综合分类），`args` 传 `{ branch, base }`。
3. 把返回的 buckets 按 Blocking → Should-fix → Nits → Verified 顺序呈现，
   附 scope、统计与未验证项，然后按 "Handling CR Results" 处理。

## 引用

- `references/docs-map.md` — 仓库文档地图与权威归属
- `references/workflow-rules.md` — 分支/提交/验证矩阵/文档扫尾规则
- `references/guardrails.md` — 高风险边界与评审聚焦点（评审引用依据）
- `references/tier1-reviewer-prompt.md` — Tier 1 评审子代理自包含提示词
- `references/tier2-deep-cr.md` — Tier 2 Deep CR 编排指南（workflow 工具）
- `references/tier2-deep-cr-script.js` — 可改编的 Deep CR workflow 脚本体

## 注意事项

- 评审必须读实际 diff 与周边代码，不能只凭摘要。
- 引用契约时给出具体文档与章节（如 `docs/dev/STYLE.md` "Make partial success explicit"），
  以及 `file:line`。
- 契约会变：每次评审先读权威文档，不要凭记忆。
- 本技能不授予任何能力：只读、只编排；所有 git 操作保持只读。
