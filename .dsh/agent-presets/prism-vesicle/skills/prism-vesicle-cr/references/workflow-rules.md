# Prism Vesicle 工作流规则（蒸馏）

权威：`AGENTS.md`、`CLAUDE.md`、`docs/dev/WORKFLOW.md`、`CONTRIBUTING.md`。
以下为评审与开发必须遵守的要点。

## 硬规则

- 仅在用户明确要求时 commit / push / merge / tag / 开 PR。
- 一个分支/PR 一个主要意图；不 push `main`；不 force-push `develop`。
- 行为、配置、工具面、运行时契约变化时，同一变更内同步文档与 changelog。
- 永不提交 secrets、生成会话状态、本地运行时工件（`.vesicle/`、项目根 `.env`、`node_modules` 生成物等）。

## 分支模型

| 分支 | 用途 |
|---|---|
| `main` | 稳定里程碑快照与发布基线 |
| `develop` | 快速内部开发活跃主干 |
| `feature/fix/docs/test/...` | 短生命工作分支（`<type>/v<target>-<topic>`） |

- Rapid Development Exception：小/中低风险变更可在用户明确要求 commit/push 时直推
  `develop`（文档更新、提示词/资产文案、聚焦 TUI 修复、测试与本地验证改进、低爆炸半径小修复、窄重构）。
- 高风险变更必须走短分支 + PR + 独立 CR：provider 协议/流式/适配器、模型可见工具契约/路径守卫/写语义、
  会话 schema/回放/恢复/迁移、prompt 契约/stop gates/验证器契约/engine 剖面、大重构或跨模块变更、
  面向 `main`/tag/发布就绪的变更。

## 验证矩阵（取能证明变更的最小集）

| 变更类型 | 最低验证 |
|---|---|
| 仅文档 | 定向文档 grep；便宜时 `bun run typecheck` |
| 小代码 | `bun run lint`、`bun run typecheck` + 聚焦测试 |
| provider/session/tool/gate/TUI 运行时 | `bun run lint`、`bun run typecheck`、相关测试、`bun run doctor` |
| 发布或 `main` 快照 | 全量 + `bun audit`、`bun run pack:check`、`bun run pack:smoke`、可行时真实 provider smoke |

环境：Bun（WSL2 zsh）；Biome 管 lint（formatter 关闭，保持周边风格）；strict TS。

## 测试价值纪律

- 测试保护用户可见行为、安全/持久化边界、外部契约或未被恰当层级覆盖的可信回归；oracle 独立于实现。
- 不因代码变了就加测试；chore/文档/机械改名默认不加。
- 条件性/不可用覆盖必须如实报 skipped/unavailable，不能提前返回并计为通过。
- 测试数量不是质量目标；低价值测试可删可并，只要有意义覆盖保留或改进。

## 文档扫尾

行为变更收尾前跑定向过时术语扫描，例如：

```bash
rg "write_file|tool_calls|session|VESICLE_|workspace|provider|OpenTUI" README*.md STATUS.md CHANGELOG.md CONTRIBUTING*.md docs assets
```

`README.md`/`CONTRIBUTING.md`/`CODE_SIGNING_POLICY.md`/`PRIVACY.md` 有 `.zh-CN.md` 对等文件；
用户手册简体中文为规范，改动页面需镜像到 `docs/user/en/` 同相对路径。

## PR Body 形状

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

## 发布（评审相关）

- 发布授权 = push 一个注释版 `v<version>` tag（commit 必须在远端 `main` 历史、版本匹配 `package.json`）。
- 发布前需 opt-in 真实 provider acceptance（`BUN_E2E_REAL_PROVIDER=1 bun run test:acceptance:provider`）。
- 不移动/删除已推送 tag；注册表已接受版本后只能前进式修复。
