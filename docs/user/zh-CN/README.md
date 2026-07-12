# Prism Vesicle 用户手册

[English](../en/README.md) | [简体中文](./README.md)

本手册从最基础的概念开始讲解 Prism Vesicle。我们假设你可能从未使用过终端、配置文件、API 密钥或 AI 模型供应商。

主线环境是 Windows 11、Windows Terminal 和 PowerShell。Linux 与 WSL 用户仍可参考其中的产品概念，但新手主线不会被多平台命令分支打断。

## 如何使用本手册

请按编号顺序阅读。每章只引入完成当前任务所需的概念，给出需要执行的命令，解释正常结果，并以完成检查结束。

`00`–`06` 章组成第一条完整学习路径：认识产品、准备 Windows、安装 Vesicle、配置一个模型供应商、通过 Doctor 检查，并完成第一次对话。

## 入门路径

1. [00 — 欢迎与安全须知](./00-welcome.md)
2. [01 — Windows、文件与 PowerShell](./01-windows-basics.md)
3. [02 — 模型供应商、API 密钥、费用与隐私](./02-model-providers.md)
4. [03 — 安装 Bun 与 Prism Vesicle](./03-installation.md)
5. [04 — 配置第一个模型供应商](./04-first-provider.md)
6. [05 — 运行 Doctor 并启动 Vesicle](./05-doctor-and-launch.md)
7. [06 — 完成第一次对话](./06-first-conversation.md)

## 日常使用

8. [07 — 模型与 Prism 引擎](./07-models-and-engines.md)
9. [08 — 会话与恢复](./08-sessions-and-resume.md)

## Prism 工作流

10. [09 — 一次完整的 ETL 工作流](./09-complete-etl-workflow.md)

## 高级操作

11. [10 — 工具权限与宿主 Shell](./10-tool-permissions-and-shell.md)

## 后续学习路径

后续章节会把手册从日常使用扩展到高级操作：

- `11` — 制品与验证
- `12` — 确认门、用户问题与引擎移交
- `13` — 回退与文件检查点
- `14` — 上下文、压缩、思考强度与推理显示
- `15` — 图像与 Web 研究
- `16` — MCP 工具
- `17` — 高级供应商配置
- `18` — 故障排查与恢复
- `19` — 更新、备份、迁移与卸载

命令、配置、术语和常见问题等参考页面会与编号学习路径分开建设。

## 手册状态

Prism Vesicle 当前仍是 alpha 产品。本手册描述受支持的入门路径，但界面、命令、供应商模型和工作流细节仍可能变化。如果手册与程序表现不一致，请运行 `vesicle doctor`，记录准确的命令与输出，并报告这一差异。

[从第 00 章开始 →](./00-welcome.md)
