# 03 — 安装 Prism Vesicle

[← 上一章：模型供应商](./02-model-providers.md) | [手册目录](./README.md) | [English](../en/03-installation.md) | [下一章：引导式供应商配置 →](./04-first-provider.md)

## 本章目标

你将为当前 Windows 账户安装 Prism Vesicle，并打开交互式 Setup。该路径不需要安装 Bun、不需要输入 PowerShell 命令，也不需要编辑配置文件。

**预计耗时：** 5 分钟

**前置条件：** 第 00–02 章、Windows 10/11 x64，以及用于下载安装包的互联网连接

## 下载安装器

打开官方 [Prism Vesicle Releases 页面](https://github.com/3aKHP/prism-vesicle/releases)，进入对应的预发布版本，下载名称类似下面的文件：

```text
PrismVesicleSetup-1.0.0-alpha.2-windows-x64.exe
```

不要使用聊天、邮件或无关镜像转发的安装器。Release 还会提供 `SHA256SUMS.txt`，需要时可用于核对下载文件的校验值。

除非对应 Release 的说明明确写明已签名，否则历史 Windows 制品均应视为未签名。对于声明已签名的 Release，请按照[代码签名政策](../../../CODE_SIGNING_POLICY.zh-CN.md)检查 Windows 签名和签名者。仅有校验和并不等于存在 Authenticode 签名。

## 运行安装器

双击下载的安装器。Prism Vesicle 只会安装到当前 Windows 账户的 `%LOCALAPPDATA%\Programs\Prism Vesicle`，正常情况下不会申请管理员权限。

除非有明确需要，否则保留默认安装目录。继续完成安装页面，并在最后一页保留 **Configure and launch Prism Vesicle** 选项。

安装器会增加以下开始菜单入口：

- **Configure Prism Vesicle**：随时重新打开引导式 Setup。
- **Prism Vesicle Doctor**：检查已有配置。
- **Uninstall Prism Vesicle**：删除程序文件，但保留用户配置与项目。

安装器还会注册原生 `vesicle.exe` 命令和资源管理器目录操作 **Open in Prism Vesicle**。安装后请打开一个新终端，再测试该命令。

如果已经安装 Prism Vesicle，再次打开安装器时会先显示 **重新安装 / 升级**、**修复** 和 **卸载**。重新安装会替换运行时并可再次打开引导式 Setup；修复会恢复程序文件、PATH、快捷方式和资源管理器集成，但不会重新打开引导式 Setup；卸载会启动现有卸载程序。正常生命周期下，这三种操作都会保留用户配置与项目目录。

[隐私政策](../../../PRIVACY.zh-CN.md)说明了卸载后哪些数据仍保留在计算机上、如何删除这些本地数据，以及配置的供应商或可选服务会在什么情况下接收数据。

## 打开引导式 Setup

点击 **Finish**。随后会打开标题为 `Prism Vesicle Setup` 的终端窗口，并高亮显示 **Begin guided setup**。你不需要输入任何命令。

使用方向键移动，按 Space 勾选，按 Enter 继续，选择可见的 **Back** 选项或按 Escape 返回上一页。密钥输入页只显示圆点，不会显示 API Key 原文。终端窗口较小时，Setup 会切换到经过裁剪的紧凑布局，而不会让各行相互重叠。

## 安装失败时

- 确认安装器来自官方 GitHub 预发布。
- 如果 Windows 提示下载不完整，请重新下载。
- 如果安全软件隔离了文件，请记录安全软件名称、安装器版本和完整警告，再提交问题；不要全局关闭安全软件。
- 如果不小心关闭了 Setup，请从开始菜单打开 **Configure Prism Vesicle**。

## 高级安装方式

GitHub 预发布仍会保留便携 Windows 可执行文件与运行时资产 ZIP。npm 与源码安装也继续面向开发者和高级用户开放，详见根目录 [README](../../../README.zh-CN.md)。它们不是新手主线。

## 完成检查

看到 `Prism Vesicle Setup` 欢迎页后，即可继续下一章。

[下一章：配置第一个模型供应商 →](./04-first-provider.md)
