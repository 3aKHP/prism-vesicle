# Prism Vesicle 用户手册

[English](../en/README.md) | 简体中文

Prism Vesicle 是一个在终端里运行 Prism Engine 创作工作流的宿主程序:连接你自己的模型 API,把源材料加工成结构化的角色卡、情景卡和长篇叙事。

## 从这里开始:你是怎么拿到 Vesicle 的?

| 我拿到的是… | 适合谁 | 入门页 |
|---|---|---|
| Windows 安装器(`PrismVesicleSetup-<version>-windows-x64.exe`) | 第一次用终端程序,想要向导带着走 | [Windows 安装器](./start/windows-installer.md) |
| npm 包(`prism-vesicle`) | 已经在用 Bun 的开发者 | [npm 安装](./start/npm.md) |
| Windows 单文件版(`prism-vesicle-windows-x64-<version>.exe` + 资源包) | 不想运行安装器、需要免安装或自行校验 | [Windows 便携版](./start/windows-portable.md) |
| Linux 单文件版(`prism-vesicle-linux-x64-<version>` + 资源包) | Linux / WSL 用户 | [Linux 便携版](./start/linux-portable.md) |

> `.deb` 等其它 Linux 包尚未发布;发布后会在上表补一行。

不确定选哪个?没有历史包袱的 Windows 用户直接用安装器最省事。

## 之后的路径(四个入门页殊途同归)

无论从哪个入口进来,终点都一样:`vesicle doctor` 检查通过,并在你的项目目录里打开了 Vesicle 界面。到达终点后从同一条教程继续:

1. [第一次对话](./tutorials/first-conversation.md)
2. [第一张角色卡](./tutorials/first-character-card.md)
3. …(完整目录见[教程区](./tutorials/README.md))

## 参考

命令速查、配置文件、权限与安全模型、校验和与签名、更新与卸载、故障排查等内容见[参考区](./reference/README.md)。

## 高级与实验特性

宿主 Shell、Output Quality Guard、SubAgents、Stage 等进阶能力见[高级区](./advanced/README.md)。

## 手册状态

Prism Vesicle 处于 alpha 阶段,界面与命令可能变化。手册与程序不一致时,以 `vesicle doctor` 的输出为准,并欢迎报告差异。
