# 04 — 配置第一个模型供应商

[← 上一章：安装](./03-installation.md) | [手册目录](./README.md) | [English](../en/04-first-provider.md) | [下一章：Doctor 与启动 →](./05-doctor-and-launch.md)

## 本章目标

你将连接一个 OpenAI 兼容供应商，勾选 Vesicle 中可用的模型，可选配置 Tavily 与 MCP，并选择安全的权限偏好，全程无需编辑 YAML。你也可以为第一次启动选择文件夹，但它不会被保存成全局项目。

**预计耗时：** 5–10 分钟

**前置条件：** 第 03 章、供应商 Base URL 与对应的 API Key

## 开始配置

高亮 **Begin guided setup** 后按 Enter。

## 输入供应商 Base URL

输入供应商的 API Base URL，例如：

```text
https://api.deepseek.com/v1
http://127.0.0.1:11434/v1
```

如果只输入 `https://api.example.com` 这样的 HTTPS 域名，Setup 会自动补充 `/v1`。远程供应商必须使用 HTTPS；本机回环服务可以使用 HTTP。

## 输入 API Key

粘贴供应商 API Key 并按 Enter。输入内容会被遮盖。模型发现期间，密钥只保留在内存中；直到最终确认页之前都不会写入磁盘。

Setup 会使用 Bearer 认证请求 `GET <Base URL>/models`。地址与密钥可用时，下一页会列出供应商返回的模型 id。

如果自动发现失败，可以重试、修改 Base URL，或手动输入准确模型 id 后继续。因此，不支持 `/v1/models` 的兼容供应商也不会阻塞配置。

## 勾选模型

使用方向键在模型列表中移动，按 Space 切换勾选状态。按 `A` 可以添加供应商未返回的准确模型 id。至少选择一个模型后按 Enter。

下一页需要从已选模型中指定一个默认模型。模型发现接口只提供 id；Vesicle 不会根据模型名称猜测视觉、推理或上下文长度能力。

## 可选 Tavily

选择 **Skip for now** 或 **Configure Tavily**。Tavily 会启用 Vesicle 的 Web 研究工具。启用时，把 Tavily API Key 粘贴到遮盖输入框；它只会保存到用户级密钥文件。

跳过 Tavily 不影响普通模型对话。

## 可选 MCP

选择 **Skip for now** 或 **Add an MCP server**。MCP 流程会询问：

- 简短的服务器名称；
- Streamable HTTP URL；
- 无认证、Bearer Token 或自定义认证 Header；
- 需要认证时使用的遮盖 Token 输入；
- 允许获得该服务器工具的 Prism Engine。

Setup 会初始化服务器并请求工具列表。连接成功后会显示发现的工具数量。测试失败时可以返回修改或重试；只有明确选择 **Save server anyway** 才会保存连接失败的服务器。继续下一步前还可以添加更多服务器。

MCP 密钥保存在用户级 `.env` 中；`mcp.yaml` 只保存环境变量引用，不包含密钥原文。

## 选择权限偏好

首次使用建议保留 **Recommended**。它对应 Vesicle 的 MOMENTUM 模式：普通工作区操作可以继续，而 `shell_exec` 保持关闭。其他选项会增加确认次数。Setup 永远不会保存 YOLO。

## 可选的第一次启动

已有项目文件夹时，选择 **Skip project selection** 即可完成配置。

只有希望 Setup 保存后立即创建或打开一个文件夹时，才选择 **Choose a folder for the first launch**。该目录仅用于这一次启动，不会成为默认项目。以后 Vesicle 始终使用每次启动时指定的目录。

## 检查并保存

确认页会显示供应商地址、已选/默认模型、Tavily 状态、MCP 服务器数量、权限模式和可选的一次性首次启动目录，但不会显示任何密钥。

选择 **Save configuration**。Setup 会合并受支持的已有配置，并为每个发生变化的旧文件创建带时间戳的备份。如果选择了首次启动目录，验证通过后 Setup 会提供一次性启动入口。

## 完成检查

Setup 显示 **Setup complete** 时即可继续。此时没有任何项目目录被保存成全局默认值。

[下一章：运行 Doctor 并启动 Vesicle →](./05-doctor-and-launch.md)
