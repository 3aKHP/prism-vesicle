# 仓库运维支撑操作

权威：`CONTRIBUTING.md`（Local Development）、`docs/dev/AUDIT_DRIFT.md`、
`docs/dev/ASSETS.md`、`docs/dev/QUALITY_BENCHMARK.md`、`STATUS.md`（Verification）。
这些是各档工作流中会被调用的支撑操作。

## 1. 首次 checkout bootstrap

```bash
bun install
bun run hooks:install      # 配置 core.hooksPath=.githooks
git lfs install            # 本仓库用 Git LFS 跟踪二进制（.gitattributes）；缺 git-lfs 时 pre-push 会拒绝
bun run doctor
bun run lint
bun run typecheck
bun test
bun run dev
```

钩子行为：pre-commit 跑 `docs:check:staged`（Markdown wrap 咨询性检查，不阻断提交）；
pre-push 跑 `bun run lint`（阻断）+ git-lfs pre-push。

## 2. Audit drift fix-forward SOP（`docs/dev/AUDIT_DRIFT.md`）

依赖审计数据库单调增长，新 advisory 会让未改 lockfile 的 CI 变红——这是 drift，不是
变更作者的错，重跑无法恢复。

**识别 drift（三个条件都满足）**：
- 失败 run 的 diff 不触及 `bun.lock` / `package.json`；
- 同一 commit（或同一 lockfile）之前通过同一 gate；
- 命名的 advisory（GHSA/CVE）晚于 lockfile 最后写入时间。

变更依赖的 PR 上 audit 红**不是** drift，属于该 PR 自己的责任。

**标准响应（fix-forward）**：
1. 分诊：severity、直接/传递依赖、依赖链、Vesicle 是否实际执行受影响代码
   （shipped production vs build/dev-only）。记录真实风险评估。
2. 开**专用** `chore(deps): patch <package> audit finding` PR；绝不并入功能 PR，
   绝不让在途功能 PR 吸收它。
3. 传递依赖 → `package.json` `overrides` 钉住修复版并重新生成 `bun.lock`；
   直接依赖 → 常规版本升级。
4. commit message 必须写：GHSA/CVE id、依赖链、可达性/风险评估、验证清单。
5. 验证：`bun audit` 绿 + `bun run lint`、`bun run typecheck`、`bun test`、
   `bun run doctor`、`bun run pack:check`、`bun run pack:smoke`（含 consumer
   `npm audit` gate）。
6. 先落 `develop`；在途 PR 随后 rebase/重跑。一次 drift 修复解锁整条流水线。

**豁免路径**（仅当无修复版或修复版破坏性过大）：分诊后 `bun audit --ignore=<CVE>`，
在 commit message 与 `CHANGELOG.md` 记录 CVE、理由、owner、明确的过期/复查日期；
到期前重新分诊（采用补丁 / 续期新理由 / 撤销）。consumer `npm audit` 无 ignore 机制，
豁免需改 `scripts/smoke/smoke-npm-package.ts` 解析 `npm audit --json` 过滤白名单 id，
且同 PR 提出并论证。

## 3. Provider acceptance lanes

opt-in，默认不进 `bun test`；缺选择器/剖面/凭据时**如实 skip 并说明原因**，绝不计为通过。

```bash
BUN_E2E_REAL_PROVIDER=1 bun run test:acceptance:provider            # 连通性 + 严格 ETL gate
bun run test:acceptance:responses                                   # 官方 openai + codex-beta + mimo + deepseek 各剖面
bun run test:acceptance:responses:openai                            # 官方 OpenAI Responses（HTTP/SSE、非流式、standalone compact、WebSocket）
bun run test:acceptance:responses:codex-beta                        # Codex V2 beta 指纹
bun run test:acceptance:responses:mimo / :deepseek                  # 第三方剖面
bun run test:acceptance:mcp                                         # 真实 MCP server（需要 mcp.yaml 配置）
```

用途：发布前必跑并记录；Responses/DeepSeek/Codex 相关变更按对应 lane 跑。

## 4. 文档同步与 wrap 检查

- 手册镜像：`docs/user/zh-CN/` 为规范，改动页面必须镜像到 `docs/user/en/` 同相对路径。
- 根文档对等：`README.md`/`CONTRIBUTING.md`/`CODE_SIGNING_POLICY.md`/`PRIVACY.md`
  共享含义变化时同步 `.zh-CN.md`。
- `docs/dev/` 单语言英文；新文件用 `UPPER_SNAKE_CASE.md`（README 除外）；
  新规则放进归属文档，不另建文件。
- wrap 与同步检查：
  ```bash
  bun run docs:check:staged       # 暂存 Markdown 自然换行检查（pre-commit 已挂）
  bun run skills:docs:sync        # 同步 bundled skill 引用副本
  bun run skills:docs:check       # --check 模式，CI 用
  ```
- 行为变更收尾前跑定向过时术语扫描，例如：
  ```bash
  rg "write_file|tool_calls|session|VESICLE_|workspace|provider|OpenTUI" README*.md STATUS.md CHANGELOG.md CONTRIBUTING*.md docs assets
  ```

## 5. Harness / 资产 bump（`docs/dev/ASSETS.md`）

低频、高风险：从 Neural Narratology 发布版拉取 → 清单/哈希全量验证 → 一次性替换。

- `assets/` 必须与 `harness-manifest.json` 清单和哈希**精确一致**；不手改、不加
  Vesicle 注记、不混入实验。
- 更新流程：选定发布版 → 更新 manifest（唯一事实源）→ 验证：
  ```bash
  vesicle assets status
  vesicle prompt shape --engine etl
  bun run build:assets
  bun run pack:check
  ```
  另跑完整确定性测试 + `vesicle doctor`；必要时更新契约/STATUS/CHANGELOG。
- 覆盖层无删除 tombstone；禁用打包引擎/资产需未来显式 manifest 策略，不靠魔术文件名。
- 变更触及 Skill 引用副本时跑 `skills:docs:sync`。

## 6. Quality benchmark（`docs/dev/QUALITY_BENCHMARK.md`）

开发者测量命令，不能改变 Runtime 质量策略，也不能启用 semantic rewrite。

- 每次运行冻结 plan（`quality-judge-benchmark-plan/v1`）：矩阵、定价、硬上限、统计、
  早停阈值；缺 `--allow-live` 拒绝调用 provider（明确承认可产生费用）。
- 语料 JSONL：labeled calibration（`name`）与 blinded held-out（`caseId`）；仅接受
  `targetType: "narrative-prose"`。
- 运行/恢复：JSONL append-only；resume 校验 run plan 哈希，跳过已完成组合；换 plan/
  语料/矩阵必须换输出路径。
- 决策边界：成功 bench **不是** 生产 held-out、Host Policy 工件或语义阻断的授权；
  生产提升需单独治理的规则/模型范围、预算、盲评、保全审查、独立 Policy 审查与
  Runtime 集成证据。
