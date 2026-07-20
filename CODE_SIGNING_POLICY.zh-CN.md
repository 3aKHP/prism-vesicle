# 代码签名政策

[English](./CODE_SIGNING_POLICY.md) | [简体中文](./CODE_SIGNING_POLICY.zh-CN.md)

最后更新：2026-07-21

## 当前状态

Prism Vesicle 目前不对 Windows 制品做 Authenticode 签名。代码签名推迟到项目具备引入签名服务的条件后再考虑；不设任何版本截止期限，原先的 `1.0.0-beta.1` 目标已被取代。当前所有 Windows 可执行文件和安装器均有意保持未签名。每个 GitHub Release 必须说明 Windows 可执行文件和安装器未签名，链接本政策，提供 SHA-256 校验和，并提醒用户不要在系统范围内关闭 Windows 安全功能。当前的发布完整性依赖官方 GitHub Release 来源、SHA-256 校验和，以及带 SLSA provenance 的 npm 注册表签名。

除非某个 GitHub Release 的说明明确写明已签名，否则历史发布制品均应视为未签名。特别需要注意：存在校验和或 npm provenance 记录，并不等于 Windows 可执行文件带有 Authenticode 签名。

若将来启用 Windows 签名，每个适用的 GitHub Release 会明确列出哪些 Windows 文件已签名，本政策也会补充实际使用的签名服务信息。

## 签名文件与源码

以下各节描述未来 Windows 签名的范围、角色、控制链和验证标准。当前不执行任何正式签名；如上所述，Windows 签名处于推迟状态。

计划中的 Authenticode 签名范围仅限于为受保护的 Prism Vesicle 正式版本生成的 Windows 可执行文件：

- 带版本号的 Windows 便携版可执行文件；
- Windows 引导式安装器；
- 该安装器生成的卸载程序。

只有从公开的 [`3aKHP/prism-vesicle`](https://github.com/3aKHP/prism-vesicle) 仓库构建的制品才有资格签名。正式签名请求必须来自受保护的 `v<version>` tag；该 tag 对应的 commit 必须位于受保护的 `main` 历史中，并且版本必须与 `package.json` 一致。Pull request、`develop`、本地构建和临时构建均不是正式签名输入。

签名文件的 metadata restrictions 必须把产品标识为 Prism Vesicle，并要求同一次构建中的 product version 保持一致。

分发包中包含开源的上游资产与依赖。包含这些内容不代表无关的上游可执行文件是由 Prism Vesicle 编写的，也不会以本项目身份将此类可执行文件提交签名。

## 角色与批准

Prism Vesicle 目前由一位个人维护者维护：

| 角色 | 当前负责人 | 职责 |
|---|---|---|
| 作者与提交者 | [`3aKHP`](https://github.com/3aKHP) | 受信任，可修改源码仓库。外部贡献者通过 pull request 提议变更，并保留公开作者身份。 |
| 仓库审查者 | [`3aKHP`](https://github.com/3aKHP) | 审查外部贡献并作出仓库层面的人工批准。由维护者编写的发布变更还要通过受保护的 CI 和仓库所规定的独立审查流程。 |
| 签名批准者 | [`3aKHP`](https://github.com/3aKHP) | 检查版本身份与构建来源，然后批准或拒绝签名请求。 |

每一次正式签名请求都必须人工批准。构建成功或推送 tag 本身并不会自动授权签名服务签名。批准者会在批准前核对仓库、tag、commit、版本号、预期文件名以及发布门禁是否全部成功。

签名证书私钥由签名服务在其硬件安全模块中生成并保管。私钥不会导出给维护者，不会存入本仓库，也不会放入 GitHub Actions secrets。

## 发布控制

公开发布流程记录在 [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md) 中。计划中的签名控制链如下：

1. 经过审查的发布变更合入受保护的 `main`。
2. 受保护的 annotated 版本 tag 标识已经验收的源码 commit。
3. GitHub Actions 从这份确定的公开源码构建 Windows 可执行文件。
4. 签名批准者人工审查签名请求。
5. 已签名的可执行文件通过验证后，才会被放入安装器载荷。
6. 安装器及其生成的卸载程序完成签名与验证。
7. 最终发布制品生成校验和与 provenance。

只要出现签名失败、身份不匹配、意外文件或验证失败，受影响的 Windows 制品就不得发布。

## 用户如何验证

首先只从项目的[官方 GitHub Releases](https://github.com/3aKHP/prism-vesicle/releases) 下载文件，并查看该版本的 Release 说明，确认它是否声明已经签名。

在 Windows 中打开可执行文件的**属性**，选择**数字签名**，查看签名者，再打开**详细信息**，确认 Windows 报告签名有效。熟悉 PowerShell 的用户也可以运行：

```powershell
Get-AuthenticodeSignature .\PrismVesicleSetup-<version>-windows-x64.exe | Format-List Status,StatusMessage,SignerCertificate,TimeStamperCertificate
```

对于声明已签名的版本，预期结果是 `Status: Valid`，证书链可信且来自签名服务，并带有时间戳。同时还应使用同一 Release 中的 `SHA256SUMS.txt` 核对文件。有效签名可以标识签名发布者并发现签名后的文件改动，但不代表软件一定没有缺陷，也不保证 Microsoft SmartScreen 永远不会对下载量较少的新版本显示信誉提示。

## 事件处理与吊销

如果签名无效、签名者不符合预期、在规定发布流程之外发现签名文件，或怀疑签名凭据或批准权限泄露：

1. 不要运行或继续转发该文件。
2. 提交一个 [GitHub issue](https://github.com/3aKHP/prism-vesicle/issues)，其中只写 Release URL、文件名、SHA-256、签名状态和证书详情截图。不要附加可执行文件、凭据、token 或隐私数据。
3. 维护者将暂停受影响的发布，检查公开构建与批准记录，通知签名服务，并在必要时请求吊销证书或签名。
4. 修正后的构建会使用新版本，不会静默替换已经发布的 tag 或制品。

隐私与数据传输行为见[隐私政策](./PRIVACY.zh-CN.md)。
