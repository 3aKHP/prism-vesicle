# 命令速查

[English](../../en/reference/commands.md) | 简体中文

在输入框以 `/` 开头触发命令;敲 `/` 弹出候选菜单(↑↓ 选择、Tab/Enter 补全、Esc 取消)。命令的参数语法由命令自身定义。

## 会话与上下文

| 命令 | 作用 |
|---|---|
| `/help` | 列出全部命令 |
| `/new` | 开一个全新会话 |
| `/resume` | 列出本项目历史会话以恢复;`/resume <n\|id>` 直接恢复 |
| `/rewind`(别名 `/checkpoint`) | 回退到本次会话的某一步,可选还原文件 |
| `/compact [说明]` | 把当前会话压成摘要再继续,省上下文 |
| `/context` | 查看当前上下文用量与上下文窗口占用 |

## 模型与引擎

| 命令 | 作用 |
|---|---|
| `/model [provider] [model]` | 切换供应商/模型;不带参数开选择器 |
| `/engine [id] [--summary [说明]]` | 查看或切换 Prism 引擎;`--summary` 切换前先压缩 |
| `/stage <角色卡路径> <情景卡路径>` | 用两张卡开一个 Stage 叙事会话 |
| `/effort off\|low\|medium\|high\|xhigh\|max\|auto` | 控制模型的思考强度;`auto` 恢复供应商默认 |
| `/reasoning hidden\|collapsed\|expanded` | 控制推理过程的显示(别名 off/preview/on) |

## 制品

| 命令 | 作用 |
|---|---|
| `/artifact [n\|path]` | 列出或预览生成的制品 |
| `/validate <n\|path>` | 按编号或路径校验一个制品 |

## 权限与质量

| 命令 | 作用 |
|---|---|
| `/permissions [MANUAL\|INERTIA\|MOMENTUM\|YOLO]` | 查看或设置工具批准模式 |
| `/quality [off\|observe\|rewrite …]` | 配置实验性 Semantic Judge(默认关) |
| `/agents [handle\|stop <handle>\|retry]` | 查看/中断/重试 SubAgent |

## 输入框按键

| 按键 | 作用 |
|---|---|
| Enter | 空闲时发送；Agent Loop 运行时将普通消息和延迟命令加入队列 |
| Ctrl+Enter | 换行 |
| Up(回合运行且输入框为空) | 取回最新一条队列输入进行编辑 |
| Esc | 中断当前供应商请求或工具操作，并立即处理下一条队列输入 |
| 双击 Esc(输入框空,800ms 内) | 打开回退选择器 |
| 双击 Esc(输入框有内容) | 存草稿并清空,不发送 |
| Alt+V | 粘贴剪贴板图片(仅视觉模型接收) |
| Ctrl+Q | 退出 Vesicle |

当前完整工具轮次结束后，队列消息会在下一次供应商请求前加入当前对话。如果 Agent Loop 没有经过下一个工具边界便已结束，下一条队列输入会被立即处理。Slash 命令各自声明忙碌时的行为：`/help`、`/context`、`/reasoning`、只读设置形式，以及 `/agents` 查看或停止会立即执行；`/artifact` 和 `/validate` 等待当前工具轮次；配置变更、选择器、会话命令、`/compact` 和 `/agents retry` 等待 Agent Loop。选择器打开时会暂停剩余队列，切换或重置会话时会清空队列。
