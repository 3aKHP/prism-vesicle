# 03 — 安装 Bun 与 Prism Vesicle

[← 上一章：模型供应商](./02-model-providers.md) | [手册目录](./README.md) | [English](../en/03-installation.md) | [下一章：供应商配置 →](./04-first-provider.md)

## 本章目标

你将安装 Bun、初始化教程项目、在项目中安装 Prism Vesicle，并验证软件包内置的 ETL 引擎资产能够正常读取。

**预计耗时：** 15 分钟

**前置条件：** 第 00–02 章、互联网连接和一个普通 PowerShell 窗口

## 返回项目文件夹

打开使用 PowerShell 的 Windows Terminal，然后运行：

```powershell
Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"
```

## 检查是否已经安装 Bun

运行：

```powershell
bun --version
```

如果 PowerShell 输出 `1.3.14` 或更高版本，请直接继续“初始化项目”。

如果 PowerShell 提示无法识别 `bun`，请使用 [bun.sh](https://bun.sh/docs/installation) 当前提供的 Windows 官方安装命令：

```powershell
powershell -c "irm bun.sh/install.ps1|iex"
```

该命令会下载并运行 Bun 官方安装脚本。完成后，彻底关闭 Windows Terminal，重新打开它，返回项目文件夹并检查版本：

```powershell
Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"
bun --version
```

如果仍然无法识别该命令，请重启一次 Windows 后再试。`bun --version` 成功前不要继续。

## 初始化项目

运行：

```powershell
bun init -y
```

该命令会创建 `package.json` 等小型项目管理文件。入门阶段不需要编辑它们。

## 安装 Prism Vesicle

运行：

```powershell
bun add prism-vesicle
```

Bun 会把 Prism Vesicle 及其运行时依赖下载到项目中。第一次安装可能需要几分钟。

成功时通常会看到安装完成摘要，并且末尾没有错误信息。文件夹中会出现 `node_modules`、`package.json` 和 `bun.lock`；它们都是正常的程序文件。

## 验证内置引擎资产

运行：

```powershell
bunx vesicle prompt shape --engine etl
```

开头几行应类似：

```text
Engine: etl (Prism ETL Engine)
Protocol: v10.0-tempered-voice
System prompt length: ...
```

准确的提示长度和工具清单可能随版本变化。只要命令能够识别 ETL 引擎并且没有报错退出，就表示成功。

接下来查看这些资产来自哪里：

```powershell
bunx vesicle assets status
```

按照本章的普通安装方式，`Bundled` 应当显示 47 个文件，`Host` 应当显示 12 个文件，`Active baseline` 应当标识内置的 `prism-engine-v10@10.0.1-alpha.1`。Vesicle 还可以从 `%APPDATA%\prism-vesicle\assets\` 读取用户级全局覆盖，并从当前项目内的 `assets\` 读取稀疏覆盖；现在不需要创建任何覆盖或 Harness 锁。

## 可选：选择离线 Harness Pack

普通安装已经运行完整 V10。高级用户可以先把另一个独立发布的 Harness Pack 解压到本地目录，再为项目选择它。验证与安装本身不会激活该 Pack：

```powershell
bunx vesicle assets verify "C:\Downloads\prism-vesicle-harness-v10"
bunx vesicle assets install "C:\Downloads\prism-vesicle-harness-v10"
bunx vesicle assets use "<pack-id>@<version>"
bunx vesicle assets status
```

`use` 会在当前项目写入 `.vesicle\assets.lock.json`。Vesicle 每次启动项目或恢复会话时，都会重新验证这一固定版本。若会话记录的 Harness 身份不同，Vesicle 会阻止恢复，而不会静默切换。

如需让项目恢复使用内置 V10 基线，请运行：

```powershell
bunx vesicle assets rollback
```

第一版离线流程要求输入已经解压的 Release 目录；它不会下载、发现、解压或自动更新 Harness Pack。

旧版 V9-only Vesicle 创建的会话没有 Harness 身份，无法在内置 V10 下恢复。升级后请新建会话。

## 安装失败时

- 确认同一个终端中的 `bun --version` 可以运行。
- 确认 `Get-Location` 以 `Documents\PrismVesicle\MyFirstProject` 结尾。
- 如果下载无法开始，检查互联网连接、VPN、代理或安全软件。
- 临时网络错误后可以再次运行 `bun add prism-vesicle`。
- 如果需要求助，在关闭终端前复制完整错误文字。

## 完成检查

运行：

```powershell
bun --version
bunx vesicle prompt shape --engine etl
```

Bun 版本至少为 `1.3.14`，并且 Vesicle 输出 `Engine: etl` 时即可继续。

[下一章：配置第一个模型供应商 →](./04-first-provider.md)
