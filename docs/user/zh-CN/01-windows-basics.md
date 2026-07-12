# 01 — Windows、文件与 PowerShell

[← 上一章：欢迎](./00-welcome.md) | [手册目录](./README.md) | [English](../en/01-windows-basics.md) | [下一章：模型供应商 →](./02-model-providers.md)

## 本章目标

你将打开 PowerShell，了解 Vesicle 所需的少量文件与文件夹概念，并创建后续入门章节使用的项目文件夹。

**预计耗时：** 15 分钟

**前置条件：** 第 00 章

## 文件、文件夹与路径

文件用于保存内容，例如文档或配置。文件夹用于组织文件和其他文件夹。路径用于告诉 Windows 某个文件或文件夹位于哪里。

例如：

```text
C:\Users\YourName\Documents\PrismVesicle\MyFirstProject
```

教程中不需要输入你的 Windows 账户名。PowerShell 提供的 `$HOME` 会自动指向你的用户文件夹。

Vesicle 使用两个不同的位置：

- **项目文件夹**保存某个项目的工作内容，包括生成的制品和本地会话数据。
- `%APPDATA%\prism-vesicle` 下的**用户配置文件夹**保存由多个 Vesicle 项目共享的供应商设置与密钥。

把这两个位置分开，可以防止 API 密钥被复制进项目文件夹。

## 打开 Windows Terminal

1. 打开 Windows 开始菜单。
2. 输入 `Terminal`。
3. 打开 **Windows Terminal**。
4. 确认标签标题显示 PowerShell，并且没有显示 Administrator 或“管理员”。

如果系统没有 Windows Terminal，普通 PowerShell 窗口也能完成教程。推荐在 Windows Terminal 中使用 PowerShell 7，因为它能提供更清晰的现代终端体验。

## 执行第一条命令

输入或粘贴：

```powershell
Get-Location
```

按 Enter。PowerShell 会输出当前文件夹，每个用户看到的准确路径都可能不同。

命令是交给终端执行的指令。PowerShell 等待你输入命令，在按下 Enter 后执行它，显示结果，然后继续等待下一条命令。

## 创建教程项目文件夹

逐行粘贴并执行这些命令：

```powershell
New-Item -ItemType Directory -Force "$HOME\Documents\PrismVesicle\MyFirstProject"
Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"
Get-Location
```

最后一条命令应输出一个以下列内容结尾的路径：

```text
Documents\PrismVesicle\MyFirstProject
```

`New-Item` 创建文件夹，`Set-Location` 让终端进入该文件夹。当前文件夹很重要，因为 Vesicle 会相对于启动位置保存项目会话和生成文件。

## 查看文件夹内容

运行：

```powershell
Get-ChildItem
```

此时文件夹应当为空，因此 PowerShell 可能不会输出任何内容。这是正常的成功结果。

也可以在文件资源管理器中打开当前文件夹：

```powershell
explorer .
```

其中的点表示“当前文件夹”。

## 基本终端操作

- 按 Enter 执行当前命令。
- 使用上、下方向键调出之前执行过的命令。
- 按 Tab 补全一部分文件名或文件夹名。
- 按 Ctrl+C 停止仍在运行的命令。
- 如果终端程序占用了普通复制粘贴快捷键，可以在 Windows Terminal 中使用 Ctrl+Shift+C 和 Ctrl+Shift+V。

关闭终端不会删除文件。以后打开新终端时，使用 `Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"` 返回教程项目。

## 完成检查

执行以下两条命令：

```powershell
Get-Location
Get-ChildItem
```

当前路径以 `Documents\PrismVesicle\MyFirstProject` 结尾时即可继续。文件夹仍然可能是空的。

[下一章：模型供应商、API 密钥、费用与隐私 →](./02-model-providers.md)
