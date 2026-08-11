<!-- Generated from docs/user/zh-CN/advanced/skills.md — do not edit. -->

# Skills

Skill 是按需加载的过程性上下文与捆绑资源，采用开放的 [Agent Skills](https://agentskills.io/specification) `SKILL.md` 格式。Skill 不是 Engine、Agent Profile、MCP 服务器或权限授予。它不会添加工具、可写根目录、Shell 权限或提供程序功能。

## 发现范围与优先级

Vesicle 从五个范围发现 Skill，优先级从高到低：

| 范围 | 位置 | 说明 |
|------|------|------|
| `project` | `<项目根>/.agents/skills/<名称>/` | 项目级约定，无需额外信任门控 |
| `user` | `<用户配置>/skills/<名称>/` | 个人创作 |
| `installed` | Skill Store 快照 | 通过 `vesicle skills install` 安装 |
| `harness` | 经验证的 Harness `assets/skills/` | 随 Harness 基线分发 |
| `host` | 包拥有的 `host-assets/skills/` | 随 Vesicle 包分发的第一方 Skill |

同名冲突时，高优先级范围胜出，低优先级条目报告为 shadowed，不合并内容。

## CLI 命令

```text
vesicle skills list              # 列出所有范围的 Skill
vesicle skills inspect <名称>    # 查看元数据和资源清单
vesicle skills validate <目录>   # 验证 SKILL.md 格式
vesicle skills create <名称>     # 脚手架新 Skill
vesicle skills enable <名称>     # 启用
vesicle skills disable <名称>    # 禁用
vesicle skills install <路径或URL>
vesicle skills update <名称>
vesicle skills rollback <名称>
vesicle skills uninstall <名称>
vesicle skills copy-template <skill> <资源路径> <目标路径>
```

## `/skill` TUI 命令

- `/skill` — 打开选择器，显示可用 Skill 及其范围。
- `/skill <名称> [任务]` — 激活并调用。
- `/skill <名称> --context-only` — 仅加载上下文，不发送提供程序请求。

## 启用与禁用

- `user` 和 `host` 范围共用 `<用户配置>/skills/.disabled` 文件。
- `project` 范围使用 `<项目根>/.vesicle/disabled-skills`。
- `installed` 范围使用 Store 索引的 `enabled` 标志。
- `harness` 范围不可禁用。

禁用仅影响新解析的会话目录；已冻结的会话目录不变。

## 第一方 `vesicle-docs` Skill

每个 Vesicle 安装包自带 `vesicle-docs`（范围 `host`），包含版本匹配的公共文档：README、用户手册（中/英）、开发者合约和配置示例。它没有脚本、没有进程权限，仅通过 `read_skill_resource` 提供只读文本参考。

当用户询问 Vesicle 的安装、配置、命令、故障排除或架构时，模型可自动激活此 Skill 获取准确信息。

## 第一方 `skillify` Skill

每个 Vesicle 安装包自带 `skillify`（范围 `host`）。当你要求 Vesicle 把当前对话中经过验证的重复性工作流捕获、保存或转化为可复用的 Skill 时，模型激活 `skillify`。它会用普通的受保护文件工具在 `tmp/skillify/<名称>/` 下编写草稿，校验完整的 bundle，然后在你选择目标后以仅创建（create-only）方式发布到项目（`.agents/skills/<名称>/`）或已安装的 Skill Store。

发布是仅创建的：不覆盖、不升级。草稿始终保留在 `tmp/skillify/` 下。已发布的 Skill 仅在新会话中可发现——当前会话目录不会改变。校验和发布通过结构化 `run_skill_script` 执行,不需要开启 `shellExec`;POSIX 使用 `sh`,`.ps1` 脚本优先使用 PowerShell 7（Windows 上可回退到 Windows PowerShell 5.1，其他平台仅用 `pwsh`）。缺少对应解释器时会明确失败并保留草稿。

## 第一方 `novel-outline-v3` Skill

每个 Vesicle 安装包自带 `novel-outline-v3`（范围 `host`），提供分层长篇小说纲要工作流（卷纲 → 章纲 → 场景）。它教授正文为先的方法论：读齐全部素材 → 维护两本全局档案（角色成长、世界观状态）→ 定卷纲 → 逐章定纲（先定张力总值再分场景）→ 闭合校验 → 回写档案 → 标待确认。

它没有脚本、没有进程权限，仅通过 `read_skill_resource` 提供只读文本参考（纲要模板、档案格式、张力模型）。与 Harness 的张力预算系统互补。

当用户要求「明确前三章」「写某卷纲要」「把大纲细化到场景级」「分配张力」或「列举伏笔收放」时，模型可自动激活此 Skill。

## Stage 排除

Stage Engine 不解析 Skill 目录，不支持 `activate_skill`、`read_skill_resource` 或 `run_skill_script`。

## 会话冻结

Skill 目录在会话首次解析时冻结。恢复会话时按名称和内容哈希重新解析；内容已变更的 Skill 被丢弃并报告诊断，不会静默替换。

## 能力与权限

Skill 不能添加工具、更改权限模式、扩展可写根目录或覆盖确认门控。Skill 请求的操作使用用户已选择的能力和权限模式执行。
