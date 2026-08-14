# Tier 2 Deep CR 编排指南（DSH workflow 工具版）

权威：`docs/dev/WORKFLOW.md` "Two-Tier Code Review"。本页说明如何在 DSH 上用
`workflow` 工具复刻项目的 `.claude/workflows/deep-cr.js`（五镜头 finder →
逐条独立 scorer → ≥80 置信过滤 → 综合分类）。完整脚本体见
`tier2-deep-cr-script.js`。

## 前置：触发门（只读，先跑）

```bash
scripts/check/deep-cr-trigger.sh <base>     # base 默认 develop
```

输出 `{"trigger":bool,"reasons":[...]}`，永不改状态：

- `trigger:false` → **停止**，改走 Tier 1；除非用户明确要求，否则不要烧 Tier 2 预算。
- `trigger:true` → 继续。
- 脚本缺失时按 `docs/dev/WORKFLOW.md` 的规则手工判定（CATEGORY_MATCH && (CROSS_BOUNDARY
  || SIZE_FLOOR || RELEASE_BRANCH)），规则与 `scripts/check/deep-cr-trigger.sh` 保持同步。

## 调用 workflow 工具

`meta`（工具参数）:

```js
{
  name: 'deep-cr',
  description: 'Tier 2 deep code review: 5 lens finders each run git diff, then an independent scorer re-verifies every candidate against its cited contract and file:line before scoring 0-100; survivors at confidence >= 80 are classified into Blocking / Should-fix / Nits / Verified.',
  whenToUse: 'High-risk cross-module / boundary-spanning / release-bound diffs per docs/dev/WORKFLOW.md; for ordinary PRs use Tier 1 instead.',
  phases: [
    { title: 'Find', detail: 'one finder agent per lens; each runs its own git diff' },
    { title: 'Score', detail: 'one independent scorer agent per candidate finding; verifies the cited doc + file:line, then scores 0-100' },
    { title: 'Synthesis', detail: 'one synthesis pass classifies >= 80 survivors into Blocking / Should-fix / Nits / Verified' },
  ],
}
```

`args`：`{ branch: "<branch>", base: "<base>" }`（base 缺省 `develop`）。

`script`：取 `tier2-deep-cr-script.js` 全文（该文件是纯 JS 脚本体，不含 `export const
meta`；meta 按上面传入工具参数）。

## DSH 与 Claude Code 版本的差异（改编时注意）

| Claude Code 版 | DSH 版 |
|---|---|
| `agentType: 'deep-cr-finder'`、`effort: 'medium'/'low'` | **不支持**，删除。只允许 `label` / `phase` / `schema` / `provider` / `model` |
| `model: 'sonnet'/'haiku'` 固定 | 可选 `provider`/`model` 覆盖；缺省继承本会话路由。想复刻"finder/synthesis 强、scorer 快"时给 scorer 传便宜的 `model` |
| `setTimeout` 确定性重试 | workflow 脚本**无 timers**：脚本里不能 sleep。`tier2-deep-cr-script.js` 已去掉重试延时，保留单次立即重试 |
| schema 带 `minimum/maximum` | **不支持数值边界**。`confidence` 用 `type: 'number'`，rubric 靠 prompt 约束 |
| `args` 可能是字符串或对象 | `args` 直接是解析后的对象 |
| finder 的 git 只读靠 Bash(git diff:*) 限制 | 靠 prompt 声明只读 + 主会话沙箱策略；finders 各自用 bash 工具跑只读 git |

## 结果处理

`workflow` 返回 `{ scope, stats, buckets, synthesisNotes, coverage }`。主代理：

1. 按 **Blocking → Should-fix → Nits → Verified** 顺序呈现（buckets 内条目带
   `file`/`line`/`title`/`rationale`/`fix`/`lens`）。
2. 附 scope（branch vs base）、统计（candidatesRaw / survivorsAbove80 / scorerNoVote）、
   `coverage.notCheckedByLens` 中未验证项。
3. 按 `docs/dev/WORKFLOW.md` "Handling CR Results" 给建议：Blocking 合并前修；
   Should-fix 除非有记录在案的延期；Nits 便宜就修；Verified 进合并备注。
4. 本流程只读：不编辑代码、不 commit。

## 注意

- 每个 `agent()` 都是 fresh 子代理：finder/scorer 天然不共享实现会话，独立性由编排保证。
- 空 buckets 是合法结果（诚实空数组优于凑数 nit）。
- 重预算：仅在触发门为真时使用。
