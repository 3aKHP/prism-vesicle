# Windows 安装器入门

[English](../../en/start/windows-installer.md) | 简体中文

面向第一次用终端程序的创作者。跟着走完大约 15 分钟,你会:装好 Vesicle → 在向导里连上一个模型服务 → 在自己的项目文件夹里打开它。

前置条件只有两个:Windows 10/11(x64)、以及一个模型服务的 API key。还没有 key 的话,先去服务商那里申请一个再回来。

## 下载安装器

从 GitHub 的 Releases 页面下载 `PrismVesicleSetup-<version>-windows-x64.exe`。

> 只从官方 Release 页面下载。想校验文件或了解签名状态,见[参考:校验和与签名](../reference/checksums-and-signing.md)。

## 运行安装器

三个事实,各一句:

- 安装到你的用户目录(`%LOCALAPPDATA%\Programs\Prism Vesicle`),**不需要管理员权限**。
- 升级或重装不会动你的配置和项目(配置在 `%APPDATA%\prism-vesicle\`,与程序目录分开)。
- 再次运行同一个安装器会弹出维护选项:Reinstall / Repair / Uninstall。维护细节见[参考:更新·卸载·迁移](../reference/update-uninstall-migrate.md)。

安装最后一页保持勾选 **Configure and launch Prism Vesicle**,它会自动打开配置向导。开始菜单的 **Prism Vesicle** 组里有三个入口:**Configure Prism Vesicle**(重开向导)、**Prism Vesicle Doctor**(检查环境)、**Uninstall Prism Vesicle**(卸载)。

## 走完 Setup 向导

向导全程用三个键:方向键移动、Enter 继续、Esc 返回上一屏(Ctrl+Q 退出)。按顺序走完:

1. **Welcome** —— 选 Begin guided setup。
2. **Base URL** —— 填你服务商的 OpenAI 兼容 Base URL(例如 `https://api.example.com/v1`)。少写了 `/v1` 没关系,向导会自动补上。
3. **API key** —— 粘贴 key(字段是掩码的,不会明文显示)。粘贴后向导会**当场**向服务商请求模型列表,这一步还不会保存 key。
4. **选择模型** —— 用 Space 勾选你想用的模型;按 `A` 可以手动补一个精确的 model id(发现失败时也能从这里继续)。至少选一个。
5. **默认模型** —— 在已选模型里挑一个作为默认。
6. **Tavily(可选)** —— Web 研究工具。新手选 **Skip for now**,以后随时能回来配。
7. **MCP(可选)** —— 外部工具服务器。新手同样选 **Skip for now**。
8. **权限预设** —— 三选一:**Recommended**(默认,读取和常规改动直接进行、shell 保持关闭)/ **More cautious**(改动先问)/ **Ask every time**(每一步都问)。保持 Recommended 即可。
9. **首次启动目录(可选)** —— 可选一个文件夹让向导结束时顺手打开一次;不选也行,之后随时在任意项目目录 `vesicle .` 启动。Vesicle 不会记住某个"全局项目目录"。
10. **复核并保存** —— 这页显示摘要,**不显示任何密钥**。保存时若已有配置文件,会先做带时间戳的备份。
11. **完成** —— 若第 9 步选了目录,这里可 "Launch this folder once" 直接打开;否则退出向导。

> 向导的模型发现只支持 OpenAI 兼容的 `/v1/models`。如果你用的是 Anthropic 或 Gemini 原生接口,这里发现不到模型——请跳过向导,按 [npm](./npm.md) 或 [Windows 便携版](./windows-portable.md) 页的方式手动编辑 `providers.yaml`,并在参考区的[配置文件](../reference/configuration.md)里查对应写法。

## 检查一下:Doctor

开始菜单打开 **Prism Vesicle Doctor**。正常输出里你要确认两行——`API key: available` 和 `Missing: none`:

```text
Prism Vesicle Doctor
Provider: example-openai
Base URL: https://api.example.com/v1
Model: gpt-4o-mini
API key: available
…
Missing: none
```

任何一行不对,就用开始菜单的 **Configure Prism Vesicle** 重开向导修正;更多情形见[参考:故障排查](../reference/troubleshooting.md)。

## 打开你的第一个项目

两条路,各两行:

- 资源管理器里右键你的项目文件夹 → **Open in Prism Vesicle**(Windows 11 可能藏在"显示更多选项"里;在文件夹空白处右键也有)。
- 或 PowerShell:`Set-Location` 到项目文件夹,再 `vesicle .`:

```powershell
Set-Location C:\path\to\my-project
vesicle .
```

记住一件事:**从哪个文件夹启动 Vesicle,你的会话和产物就存在哪个文件夹里**。退出按 Ctrl+Q。

## 出问题了?

- 安装被安全软件拦截 —— 暂时允许,或改用 [Windows 便携版](./windows-portable.md);务必只从官方 Release 下载。
- 向导被关掉了 —— 开始菜单 **Configure Prism Vesicle** 重开,之前填的不会丢。
- doctor 报 `Missing: …` —— 开始菜单 **Configure Prism Vesicle** 按提示修正。
- 终端里敲 `vesicle` 提示找不到命令 —— **开一个新终端**。安装器把 `vesicle` 加进了你的用户 PATH,但已经开着的旧终端不会刷新。

## 下一步

→ [第一次对话](../tutorials/first-conversation.md)
