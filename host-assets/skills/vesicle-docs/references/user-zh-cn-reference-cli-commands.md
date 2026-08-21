<!-- Generated from docs/user/zh-CN/reference/cli-commands.md — do not edit. -->

# 终端命令参考

[English](../../en/reference/cli-commands.md) | 简体中文

本页列出在 **Vesicle TUI 外**、直接从 PowerShell 或其它终端运行的命令。对话里的 `/help`、`/model`、`/workspace` 等斜杠命令见 [TUI 命令速查](./commands.md)。

## 启动与检查

| 命令 | 作用 | 成功时看到什么 |
|---|---|---|
| `vesicle .` | 在当前目录打开 TUI | 启动画面后出现 Chat 页;当前目录成为项目根 |
| `vesicle <目录>` | 在指定目录打开 TUI | 新进程以该目录为项目根;路径不存在则拒绝 |
| `vesicle launch [目录]` | `vesicle .` / `vesicle <目录>` 的显式命令形式 | 在目标目录启动同一套 TUI |
| `vesicle --resume .` / `-r .` | 启动时先开会话选择器 | 列出当前项目的会话,选择前不请求供应商 |
| `vesicle setup` | 打开引导式配置向导 | 完成页列出配置结果,可选择启动一个目录 |
| `vesicle doctor` | 检查 Bun、供应商、密钥、资源、Skills、MCP、权限等 | 最后一行 `Missing: none` 表示必需项齐备;外部可选服务仍可能单独报错 |
| `vesicle --version` / `-v` | 打印 Vesicle 版本 | 一行版本号 |
| `vesicle --help` / `-h` | 打印全局用法 | flags 与顶层命令摘要 |

`--dark` / `--light` 可用于普通启动、`launch`、`dev` 和 `setup`,只决定启动偏好;进入 TUI 后 `/theme` 可覆盖。`--dangerously-skip-permissions` 只对这次进程启用 YOLO,见[权限与安全](./permissions-and-security.md)。

## 非交互单回合

```bash
vesicle once <prompt>
```

它在当前目录运行一个模型回合并打印回复与 `Session: <路径>`。如果回合需要门、提问、权限或质量决策,命令会打印待处理类型后退出;它不会在非交互终端替你做选择。随后在同一项目运行 `vesicle --resume .`,选中刚打印的会话继续。

`once` 会真实调用供应商并可能写入受保护文件。它没有 `--help` 子命令;缺少 prompt 时才打印用法。只想看命令列表请用 `vesicle --help`。

## 配置管理

先用以下三条确定位置与有效性:

```bash
vesicle config path
vesicle config show providers
vesicle config validate
```

- `path` 打印当前用户级配置路径。
- `show` 支持 `providers` / `env` / `permissions` / `mcp` / `quality` / `settings` / `preferences`;查看 `.env` 时只显示 `<set>` / `<empty>`,不打印密钥值。
- `validate` 成功输出验证结果且退出码为 0;失败不会改文件。

写操作:

```text
vesicle config set <file> <key> <value>
vesicle config unset <file> <key>
vesicle config add-provider --json '<entry>'
vesicle config add-model <provider-id> --json '<entry>'
vesicle config remove-model <provider-id> <model-id>
vesicle config remove-provider <provider-id>
vesicle config add-mcp --json '<entry>'
vesicle config remove-mcp <server-id>
vesicle config env-set-empty <KEY>
vesicle config env-set-proxy <URL>
vesicle config env-remove <KEY>
```

成功的写操作在 stdout 输出一条 JSON 结果;错误写到 stderr,并在验证失败时保持原文件不变。所有命令都拒绝把 API key 作为参数;用 `env-set-empty` 建空槽位后,仍需在用户级 `.env` 中人工填写密钥。完整字段与例子见[配置文件](./configuration.md)。

## Harness 与资产

```text
vesicle assets status
vesicle assets verify <已解压-Pack-目录>
vesicle assets install <已解压-Pack-目录>
vesicle assets use <pack-id>@<version>
vesicle assets rollback
vesicle assets materialize <assets/path> [--global]
vesicle assets init [--global]
```

这些命令管理创作基线与本地覆盖。普通用户第一次启动不需要运行它们;只有拿到一个新的完整 Harness Pack,或明确要定制 prompt/Agent 时再用。操作顺序和回退见 [Harness Packs](../advanced/harness-packs.md)。

## Skills

```text
vesicle skills list
vesicle skills inspect <name>
vesicle skills enable <name>
vesicle skills disable <name>
vesicle skills create <name> [--scope user|project] [--force]
vesicle skills validate <skill-directory>
vesicle skills install <path-or-url> [--ref <ref>] [--path <root>] [--all] [--include-worktree]
vesicle skills update <name>
vesicle skills rollback <name>
vesicle skills uninstall <name>
vesicle skills copy-template <skill-name> <resource-path> <dest-path>
```

先 `list`,再对目标 `inspect`;安装外部 Skill 前先检查来源。`--include-worktree` 只会把本地 Git 目录中 **已跟踪文件**的未提交修改纳入快照;untracked 与 ignored 文件仍会排除,因此只有在你检查过并明确要保存这些已跟踪改动时才使用。`update` 或 `uninstall` 出错时不会把当前快照当成成功状态;已安装 Skill 可用 `rollback` 回到上一个快照。启用、禁用、安装、升级、回退或卸载只影响**新解析的会话目录**,当前会话冻结的 Skill 集不会热替换。详细范围、会话冻结和 `skillify` 流程见 [Skills](../advanced/skills.md)。`skills validate <目录> --draft --json [--quiet-success]` 与 `skills publish-draft <草稿目录> --target project|installed --json` 是 `skillify` 的结构化内部接口,普通用户不需手工调用。

## Prompt 与诊断

| 命令 | 用途 |
|---|---|
| `vesicle prompt shape --engine <id>` | 打印 prompt 的组合结构、来源和长度,不打印完整内容 |
| `vesicle prompt dump --engine <id>` | 打印模型真正看到的完整系统 prompt;可能包含本机自定义指令,分享前检查隐私 |
| `vesicle debug markdown-runtime` | 检查 TUI 的 Markdown worker 与原生语法运行时 |
| `vesicle debug tui-bootstrap` | 只做 TUI 启动引导诊断 |
| `vesicle dev` | 从源码/开发包直接启动 TUI;普通安装用户应使用 `vesicle .` |

`vesicle quality benchmark` 是开发者专用的真实供应商评测入口,不是打开用户侧 Quality Guard 的命令。普通用户在 TUI 中使用 `/quality`。

## 出错后怎么做

1. 原样保留命令、stderr 和退出码;不要贴 `.env` 内容。
2. 运行 `vesicle doctor` 与 `vesicle config validate`。
3. 确认终端当前目录就是目标项目;配置命令写用户级配置,项目偏好和资产选择则与当前项目有关。
4. 进入[故障排查](./troubleshooting.md)按症状处理。
