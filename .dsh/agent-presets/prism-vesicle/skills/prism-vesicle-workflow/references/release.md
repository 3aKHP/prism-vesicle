# Release 工作流（完整 checklist）

权威：`docs/dev/WORKFLOW.md` §Release Lifecycle、§CI/CD State Machine、§Failure And
Retry Rules；`CODE_SIGNING_POLICY.md`；`docs/dev/AUDIT_DRIFT.md` §Release Rule。
发布是低频高风险操作：每一步都可验证，任何一步失败都停下来修，不绕过。

## 前置事实

- 发布授权 = push 一个**注释版** `v<version>` tag，其 commit 必须在远端 `main` 历史、
  版本必须与 `package.json` 一致。tag 一旦推送即不可变发布意图：不删除、不移动、
  不重建；注册表已接受版本后只能前进式修复（新 prerelease 版本）。
- 当前（无签名供应商时）Windows 工件为**明确披露的未签名**：Release notes 前置中英
  双语警告（链接 Code Signing Policy、`SHA256SUMS.txt`、不要全局关闭 Windows 安全）。
- 任何 audit gate 红色或豁免过期时**禁止**创建 release tag（AUDIT_DRIFT.md §Release
  Rule）。

## 流程

1. **冻结**：`package.json` 版本、`CHANGELOG.md`、release notes、支持的用户可见范围
   固定到 `release/v<version>-<topic>` 分支。
2. **本地全量验证**：`bun run lint`、`bun run typecheck`、`bun test`、`bun run doctor`、
   `bun audit`、`bun run pack:check`、`bun run pack:smoke`；可行时真实 provider smoke。
3. **Opt-in acceptance**（发布前必跑并记录）：`BUN_E2E_REAL_PROVIDER=1 bun run
   test:acceptance:provider`（严格 ETL gate，偏差即失败；缺凭据如实 skip）。
4. **PR 到 `main`**：release 分支开 PR；PR CI 执行同一 reusable release build，产出
   短生命周期 Linux/Windows/assets-ZIP/installer 工件供人类测试。
5. **独立 CR**：按 `prism-vesicle-cr` 执行（release 分支命中 Tier 2 触发条件中的
   RELEASE_BRANCH——按主题文档与拆分享受 Standard/Huge 档处理）。
6. **Windows 小规模验收**（发布时）：真实 Windows 环境走安装/升级/运行烟测。
7. **合并 + 本地同步**：合并评审过的 release PR 到 `main`；本地 `git pull --ff-only
   origin main`，确认 HEAD 是接受提交。
8. **打 tag 并推送**（完整命令序列）：

   ```bash
   git switch main
   git pull --ff-only origin main
   test "$(git branch --show-current)" = "main"
   test "$(bun -e 'console.log((await Bun.file("package.json").json()).version)')" = "<version>"
   git tag -a "v<version>" -m "Prism Vesicle v<version>"
   git push origin "v<version>"
   ```

   此 push 即发布授权。tag 工作流会拒绝轻量 tag、tag/版本不匹配、tag 不在远端
   `main` 历史；随后重跑全部 gate、上传工件、建 GitHub Release + checksums、npm
   Trusted Publishing 发布。
9. **只读验证**（不依赖浏览器）：

   ```bash
   gh run list --workflow release.yml --limit 5
   gh run watch <run-id> --exit-status
   gh release view "v<version>" --json tagName,isPrerelease,assets
   npm view "prism-vesicle@<version>" version dist-tags bin --json
   ```

10. **消费者烟测**：从公开 registry 重跑 global-prefix 与 local-lockfile npm 安装，
    确认版本/dist-tag/bin launcher/provenance/clean audit/交互 TUI 启动。
11. **前向同步**：发布提交（`main`）按正常评审分支流同步回 `develop`。

## 失败与重试规则

- PR CI 失败：无公开副作用，修 release 分支让更新后的 PR 提交重跑。
- audit-gate 失败（lockfile 未变的漂移）：不可重跑恢复，走 `references/repo-ops.md`
  的 audit-drift fix-forward SOP（专用 PR），而不是 rerun。
- tag push 后瞬时失败：`gh run list --workflow release.yml` 找到 run，
  `gh run rerun <run-id> --failed`；npm 对已存在版本跳过，GitHub Release 对同一 tag 更新。
- 绝不删除/移动 tag 重试；发布字节或元数据错误时用新 prerelease 版本前进修复。

## 签名就绪（未来启用时）

- 每次生产签名请求经签名供应商人工检查批准；签名并验证便携 PE → installer 暂存 →
  生成的签名卸载器 → 最终 installer。
- 失败或未批准的签名请求**必须阻断**受影响 Windows 工件的发布，绝不静默回退到未签名文件。
