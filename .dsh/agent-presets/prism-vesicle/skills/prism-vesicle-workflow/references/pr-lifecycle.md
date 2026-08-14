# PR 生命周期五档（Develop 直推 / Quick / Standard / Huge / Hot-Fix）

权威：`docs/dev/WORKFLOW.md`（§ Change Grading Workflow 为六档定义、分支模型、
Rapid Development Exception、Iteration Loop、Independent CR、Hotfix）。
以下每档给出触发条件、步骤与出口条件（DSH 执行清单）。

## 0. 对齐 scope（所有档通用第一步）

先陈述：改什么、涉及哪些文件、风险、验证方式。据此与用户确认档位，再动手。

## 1. Develop 直推（direct-to-develop）

- **触发**：chore/docs 限定、小范围低风险；用户明确要求 commit/push 到 `develop`。
- **步骤**：
  1. 确认变更落入 Rapid Development Exception 允许面（文档、prompt/asset 文案、
     聚焦 TUI 修复、测试/本地验证改进、低爆炸半径小修复、窄重构）；本档再收紧为
     chore/docs 限定——超出即升档。
  2. 小步提交（Conventional Commits），一次提交一个意图。
  3. 最小验证：`bun run lint` + `bun run typecheck`（docs 类可只做定向 grep）。
  4. 用户确认后直推 `develop`；不 push `main`。
- **出口**：提交已推送，工作树干净，无未同步文档。

## 2. Quick PR

- **触发**：中小型、低风险变更；不启用独立 CR。
- **步骤**：
  1. 从 `develop` 建短分支：`<type>/v<target>-<topic>`。
  2. 实现 + 验证（按验证矩阵）。
  3. 开 PR（body 用 PR 形状：Summary / Test Plan / Notes），base 为 `develop`。
  4. **Bot Review 一轮**：处理其发现；无阻塞项后即可向人类申请合并。
  5. 等人类合并（合并动作永远由人/用户执行，代理不自行合并）。
- **出口**：Bot Review 一轮通过，人类批准合并。

## 3. Standard PR

- **触发**：中规模变更；或命中高风险面但未到 Huge 门槛（单域、文件/行数未超阈值）。
- **步骤**：
  1. 从 `develop` 建短分支；实现 + 验证。
  2. 开 PR 后启动**双轨 CR**（并行）：
     - **独立 CR SubAgent**：加载 `prism-vesicle-cr` 技能执行 Tier 1——用 `subagent`
       （spawn，fresh 上下文）投递 `tier1-reviewer-prompt.md`，branch/base 填实际值。
     - **Bot Review**：GitHub PR 侧自动审查一轮。
  3. 汇总两轨发现，按 Blocking / Should-fix / Nits / Verified 处理：
     - Blocking：修复后重跑相关验证与受影响的 CR 项。
     - Should-fix：修复，或记录在案的延期理由。
  4. **无 Should-Fix 后**向人类申请合并。
- **出口**：双轨无 Blocking/未决 Should-fix，人类批准合并。

## 4. Huge PR

- **触发**：大规模跨模块高风险改动（跨 2+ 高风险域，或 ≥8 文件 / ≥300 净 diff 行，
  或 release 分支/面向 `main`）。
- **步骤**：
  1. **开工前撰写主题文档**：描述变更目标、成功标准、涉及子系统、风险与失败模式、
     拆分方案（若需）。默认放 `dev/docs/working/`（机器本地，UPPER_SNAKE_CASE.md）；
     若用户要求公开评审则放仓库内合适位置并走文档流程。
  2. **拆分 PR**：一个 PR 一个主要意图；把 Huge 拆成多个可独立评审的 PR。
  3. 每个拆分 PR 走 **Standard 档**流程（含 Tier 1 CR + Bot Review）。
  4. 整体（或代表性合并集）执行 **Deep-CR**：加载 `prism-vesicle-cr` 技能 Tier 2——
     先跑 `scripts/check/deep-cr-trigger.sh <base>` 确认触发，再按其
     `tier2-deep-cr.md` / `tier2-deep-cr-script.js` 编排 `workflow` 工具
     （五镜头 finder → 独立 scorer → ≥80 过滤 → 综合分类）。
  5. 处理 Deep-CR 输出（Blocking 修复；Should-fix 修复或记录延期），然后申请合并。
- **出口**：主题文档就位、拆分完成、各 PR 双轨通过、整体 Deep-CR 无未决 Blocking/
  Should-fix，人类批准合并。

## 5. Hot-Fix

- **触发**：`main` 或已打 tag 的里程碑出现阻断回归（provider 请求失败、会话丢历史、
  工具假写、路径守卫不安全、TUI 无法退出/输入）。
- **步骤**：
  1. 从 `main` 分支（不经过 `develop`）。
  2. 打最小、最具体的失败路径 patch；可行时补回归测试。
  3. 更新 `CHANGELOG.md` 与相关文档。
  4. 本地验证（按回归风险取矩阵）。
  5. PR 回 `main`；合并后**前向合并/cherry-pick 到 `develop`**。
- **出口**：`main` 已修复，`develop` 已同步。

## PR Body 形状（Quick/Standard/Huge/Hot-Fix 通用）

```markdown
## Summary

- ...

## Test Plan

- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun run doctor`

## Notes / Follow-ups

- ...
```

## 常见升档信号（命中即升档）

- 变更触及 `src/providers`、`src/core/tools`、`src/core/session`、`src/core/checkpoints`、
  `src/core/prompt`、`assets/prompts`、`assets/engines`、`src/core/gate`、
  `src/core/validators`、`src/core/engine` 之一 → 至少 Standard。
- 其中 2+ 域 / ≥8 文件 / ≥300 净 diff 行 / release 或 `main` 目标 → Huge。
