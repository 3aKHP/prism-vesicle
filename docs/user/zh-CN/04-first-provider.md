# 04 — 配置第一个模型供应商

[← 上一章：安装](./03-installation.md) | [手册目录](./README.md) | [English](../en/04-first-provider.md) | [下一章：Doctor 与启动 →](./05-doctor-and-launch.md)

## 本章目标

你将创建 Vesicle 的 Windows 用户配置，把它连接到一个 DeepSeek 模型，并将 API 密钥保存在项目文件夹之外。

**预计耗时：** 15 分钟

**前置条件：** 第 00–03 章、一个 DeepSeek API 密钥，以及准备使用的准确 API 模型 id

## 创建用户配置文件夹

在 PowerShell 中逐行运行这些命令：

```powershell
$configDir = Join-Path $env:APPDATA "prism-vesicle"
New-Item -ItemType Directory -Force $configDir
```

`$env:APPDATA` 是 Windows 的用户级应用数据文件夹。`$configDir` 是一个临时 PowerShell 变量，用于在当前终端会话中保存 Vesicle 配置文件夹的完整路径。

## 创建 `providers.yaml`

创建文件并用记事本打开：

```powershell
New-Item -ItemType File -Force (Join-Path $configDir "providers.yaml")
notepad (Join-Path $configDir "providers.yaml")
```

把下面的完整配置复制到记事本中：

```yaml
default:
  provider: deepseek
  model: deepseek-v4-flash

providers:
  deepseek:
    protocol: openai-chat-compatible
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY
    defaultModel: deepseek-v4-flash
    models:
      - id: deepseek-v4-flash
        capabilities:
          streaming: true
          tools: true
```

如果供应商文档给出了不同的 API 模型 id，请把所有 `deepseek-v4-flash` 都替换成该准确 id。它一共出现三次。其他行的缩进、标点和大小写应保持不变。

按 Ctrl+S 保存文件，然后关闭记事本。

`providers.yaml` 用于标识供应商和模型，但不包含 API 密钥。YAML 使用空格缩进，不要用 Tab 字符替换这些空格。

## 创建密钥 `.env` 文件

返回 PowerShell，运行：

```powershell
New-Item -ItemType File -Force (Join-Path $configDir ".env")
notepad (Join-Path $configDir ".env")
```

输入下面这一行，并把 `YOUR_API_KEY` 替换成从供应商控制台复制的真实密钥：

```dotenv
DEEPSEEK_API_KEY=YOUR_API_KEY
```

`=` 两侧不能有空格。按 Ctrl+S 保存，然后关闭记事本。

屏幕共享时不要显示该文件，不要把它粘贴到求助信息中，也不要复制到项目文件夹。如果密钥暴露，请在供应商控制台中撤销它。

## 确认文件存在

运行：

```powershell
Get-ChildItem $configDir -Force
```

列表中应同时包含：

```text
.env
providers.yaml
```

`-Force` 让 PowerShell 显示以点开头的文件名。该命令只显示文件名，不会显示密钥内容。

## 理解配置之间的关系

重要字段包括：

- `default.provider`：Vesicle 启动时选择的供应商
- `default.model`：启动时选择的模型
- `protocol`：与供应商通信时使用的 API 格式
- `baseUrl`：供应商的 API 端点
- `apiKeyEnv`：Vesicle 必须从 `.env` 中读取的密钥变量名
- `models`：该供应商允许使用的模型 id

`apiKeyEnv` 后面的名称必须与 `.env` 中 `=` 前面的名称完全一致。

## 完成检查

请确认：

- 两个文件都位于 `%APPDATA%\prism-vesicle`，而不是 `MyFirstProject` 中
- `providers.yaml` 中没有真实 API 密钥
- `.env` 包含 `DEEPSEEK_API_KEY=`，后面跟随真实密钥
- 配置的模型 id 与供应商当前 API 文档一致

[下一章：运行 Doctor 并启动 Vesicle →](./05-doctor-and-launch.md)
