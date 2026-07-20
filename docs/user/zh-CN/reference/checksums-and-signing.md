# 校验和与签名

[English](../../en/reference/checksums-and-signing.md) | 简体中文

下载 Vesicle 后,核对文件能确认它没被篡改、且确实来自本项目。两件事要分清:**校验和**确认字节无误,**签名**确认发布者身份。

## 校验和:确认文件字节

每个 GitHub Release 附带一份 `SHA256SUMS.txt`。下载后在同目录核对。

Windows(PowerShell):

```powershell
Get-FileHash .\prism-vesicle-windows-x64-<version>.exe -Algorithm SHA256
Get-FileHash .\prism-vesicle-assets-<version>.zip -Algorithm SHA256
```

Linux / WSL:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

把算出的哈希和 `SHA256SUMS.txt` 里对应文件名那一行比对;一致即文件字节与发布时相同。

## 签名:确认发布者

Windows 可执行文件可用 Authenticode 签名。**校验和不等于签名**——哈希只能发现下载后的改动,不能证明是谁发布的。

**当前状态(`1.0.0-alpha.2`)**:Windows 可执行文件与安装器**有意未签名**。本项目的 SignPath Foundation 申请(2026-07-15 提交)尚在审批中。这一例外只针对知情的小范围测试群体,最迟在 `1.0.0-beta.1` 前必须接入签名。因此 alpha 阶段:

- 只从[官方 GitHub Releases](https://github.com/3aKHP/prism-vesicle/releases)下载;
- 务必按上面方法核对 `SHA256SUMS.txt`;
- **不要**为了绕过提示而全局关闭 Windows 安全功能。

完整政策见 [Code Signing Policy](../../../CODE_SIGNING_POLICY.md)。

## 签名启用后如何验证

当某个 Release 的说明标注其 Windows 文件已签名时,这样验证:

1. 右键可执行文件 → **属性** → **数字签名**,查看签名者,点 **详细信息** 确认 Windows 报告签名有效。
2. 或用 PowerShell:

```powershell
Get-AuthenticodeSignature .\PrismVesicleSetup-<version>-windows-x64.exe | Format-List Status,StatusMessage,SignerCertificate,TimeStamperCertificate
```

期望结果:`Status: Valid`,且签名者为可信的 SignPath Foundation 证书链,带时间戳。

> 有效签名能识别发布者、发现签名后的改动,但**不能**保证软件无缺陷,也不能保证 Microsoft SmartScreen 对新版本不弹信誉警告。

## 怀疑文件有问题

若签名无效、签名者异常、或在官方发布流程之外发现"已签名"的本项目文件:不要运行或转发;到 [GitHub Issues](https://github.com/3aKHP/prism-vesicle/issues) 开一个 issue,只附 Release 链接、文件名、SHA-256、签名状态和证书截图——**不要**附可执行文件、密钥或个人数据。处置流程见 [Code Signing Policy](../../../CODE_SIGNING_POLICY.md)。
