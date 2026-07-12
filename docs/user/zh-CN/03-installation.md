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
Protocol: v9.0-state-space
System prompt length: ...
```

准确的提示长度和工具清单可能随版本变化。只要命令能够识别 ETL 引擎并且没有报错退出，就表示成功。

接下来查看这些资产来自哪里：

```powershell
bunx vesicle assets status
```

按照本章的普通安装方式，`Bundled` 应当显示文件数量，并且 effective manifest 应当可用。Vesicle 还可以从 `%APPDATA%\prism-vesicle\assets\` 读取用户级全局覆盖，并从当前项目内的 `assets\` 读取稀疏覆盖；现在不需要创建任何覆盖。

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
