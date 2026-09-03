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

推荐先 `list`,再 `inspect <名称>` 查看实际生效范围、资源与来源。成功的 `list` 会标出 scope、disabled 与 shadowed 状态;`inspect` 已安装 Skill 时还会显示来源、解析后的 commit 和 bundle hash。

### 创建自己的 Skill

```bash
vesicle skills create my-workflow --scope project
```

`--scope project` 写到当前项目的 `.agents/skills/`;省略时默认写用户级 Skill 目录,对所有项目可见。成功输出创建路径和下一条 `validate` 命令。目标已存在时默认拒绝;`--force` 会先把旧目录备份后再创建,输出备份路径。不要在未检查旧内容时使用 `--force`。

### 从目录或 GitHub 安装

```text
vesicle skills install <本地目录或GitHub-URL>
vesicle skills install <GitHub-URL> --ref <tag或commit> --path <仓库内Skill目录>
vesicle skills install <GitHub-URL> --ref <tag或commit> --all
```

- 单 Skill 根目录直接安装;仓库里有多个 Skill 时用 `--path` 选一个,或明确用 `--all` 安装全部发现项。
- `--ref` 把 GitHub 来源解析并记录到不可变 commit;依赖稳定版本时应显式给 tag/commit。
- 本地 Git 工作树默认拒绝未提交改动;只有你已经检查并明确要把 **Git 已跟踪文件**的未提交修改纳入快照时才用 `--include-worktree`。未跟踪文件与 ignored 文件始终不会进入快照;需要它们时应先审查并提交。
- 成功时每项显示 `Installed <name> <version> [<source kind>] ...`,最后显示安装数量。安装后用 `vesicle skills inspect <name>` 核对来源,并开新会话。

生命周期命令成功时分别显示 `Updated old -> new`、`Rolled back ... to <version>` 或 `Uninstalled ...`。更新后行为不对时先 `rollback`;卸载只移除 installed Store 项,不会删除项目/用户/Harness/host 的同名 Skill。没有上一快照、来源不可更新或目标不存在会明确失败,不要把 stderr 当成功。

`copy-template` 只把 Skill 中一个资源复制到当前项目的受批准内容根:`source_materials/`、`workspace/`、`novels/`、`reports/` 或 `test_runs/`;绝对路径、`..` 与 `tmp/` 目标会拒绝。成功显示 `Copied <skill>/<resource> -> <path>`。

完整终端语法与失败处理见[终端命令参考](../reference/cli-commands.md)。第一次让模型查文档或委派任务,按 [Skills 与 SubAgents 教程](../tutorials/skills-and-subagents.md)操作。

## `/skill` TUI 命令

- `/skill` — 打开选择器，显示可用 Skill 及其范围。
- `/skill <名称> [任务]` — 激活并调用。
- `/skill <名称> --context-only` — 仅加载上下文，不发送提供程序请求。
- `/skill refresh` — 把本会话的 Skill 目录按当前安装内容重新冻结。正文变更的 Skill 需要再 `/skill <名称>` 激活一次才能回到会话里；没有变化时什么都不做。

## 激活后的只读 `skills/` 挂载

激活一个 Skill 后，它捆绑的文件同时以只读逻辑根 `skills/<名称>/<Skill 相对路径>` 挂载进普通文件工具：模型可以用 `grep_files` 直接检索（例如在 `vesicle-docs` 里按关键词定位文档页），再用 `read_file` 按行区间精读命中位置，`list_directory` 与 `stat_path` 用于浏览，`view_image` 可查看捆绑图片。

挂载面与激活状态一致：激活即挂载，压缩丢失或回退卸载；只解析会话目录中的胜者副本。列表与检索遵循加载时冻结的资源清单；单文件读取与 `read_skill_resource` 同源同护栏（含 256 KiB 文本上限）。`skills/` 是只读根——写入、移动、复制目标与删除一律拒绝。`read_skill_resource` 本身不变，仍是带来源事件的读取路径。

## 启用与禁用

- `user` 和 `host` 范围共用 `<用户配置>/skills/.disabled` 文件。
- `project` 范围使用 `<项目根>/.vesicle/disabled-skills`。
- `installed` 范围使用 Store 索引的 `enabled` 标志。
- `harness` 范围不可禁用。

禁用仅影响新解析的会话目录；已冻结的会话目录不变。

## 第一方 `vesicle-docs` Skill

每个 Vesicle 安装包自带 `vesicle-docs`（范围 `host`），包含版本匹配的公共文档：README、用户手册（中/英）、开发者合约和配置示例。它没有脚本、没有进程权限，捆绑参考可经 `read_skill_resource` 读取，激活后也可经只读 `skills/` 挂载用 `grep_files` 检索。

当用户询问 Vesicle 的安装、配置、命令、故障排除或架构时，模型可自动激活此 Skill 获取准确信息。

## 第一方 `skillify` Skill

每个 Vesicle 安装包自带 `skillify`（范围 `host`）。当你要求 Vesicle 把当前对话中经过验证的重复性工作流捕获、保存或转化为可复用的 Skill 时，模型激活 `skillify`。它会用普通的受保护文件工具在 `tmp/skillify/<名称>/` 下编写草稿，校验完整的 bundle，然后在你选择目标后以仅创建（create-only）方式发布到项目（`.agents/skills/<名称>/`）或已安装的 Skill Store。

发布是仅创建的：不覆盖、不升级。草稿始终保留在 `tmp/skillify/` 下。已发布的 Skill 仅在新会话中可发现——当前会话目录不会改变。校验和发布通过结构化 `run_skill_script` 执行,不需要开启 `shellExec`;POSIX 使用 `sh`,`.ps1` 脚本优先使用 PowerShell 7（Windows 上可回退到 Windows PowerShell 5.1，其他平台仅用 `pwsh`）。缺少对应解释器时会明确失败并保留草稿。

## 第一方 `novel-outline-v3` Skill

每个 Vesicle 安装包自带 `novel-outline-v3`（范围 `host`），提供分层长篇小说纲要工作流（卷纲 → 章纲 → 场景）。它教授正文为先的方法论：读齐全部素材 → 维护两本全局档案（角色成长、世界观状态）→ 定卷纲 → 逐章定纲（先定张力总值再分场景）→ 闭合校验 → 回写档案 → 标待确认。

它没有脚本、没有进程权限，捆绑参考可经 `read_skill_resource` 读取，激活后也可经只读 `skills/` 挂载检索（纲要模板、档案格式、张力模型）。与 Harness 的张力预算系统互补。

当用户要求「明确前三章」「写某卷纲要」「把大纲细化到场景级」「分配张力」或「列举伏笔收放」时，模型可自动激活此 Skill。

## 第一方 `update-config` Skill

每个 Vesicle 安装包自带 `update-config`（范围 `host`）。当你要求查看或修改供应商、权限、偏好、质量或设置配置时，模型激活该 Skill，通过经过校验的原子 `vesicle config` CLI 命令引导修改，而不是手改 YAML。完整命令面见 [`vesicle config` 命令参考](../reference/configuration.md#vesicle-config-命令参考)。

密钥值被结构性排除：`show` 把 `.env` 脱敏为 `<set>`/`<empty>` 标记，任何操作都不接受密钥作为参数；API 密钥仍需手动编辑用户级 `.env`。脚本通过两个薄 `.sh`/`.ps1` 包装经结构化 `run_skill_script` 执行（独立 `skill_exec` 审批类），无需开启 `shellExec`。

## Stage 排除

Stage Engine 不解析 Skill 目录，不支持 `activate_skill`、`read_skill_resource` 或 `run_skill_script`。

## 会话冻结

Skill 目录在会话首次解析时冻结。恢复会话时按名称和内容哈希重新解析；内容已变更的 Skill 被丢弃并报告诊断，不会静默替换。如果宿主版本更新等原因让某个 Skill 的内容变了、但会话本身没有触发迁移审查，恢复时会看到一条漂移提示：运行 `/skill refresh` 即可按当前内容重新冻结，报告里标记为已变更的 Skill 再激活一次即可恢复使用。

## 能力与权限

Skill 不能添加工具、更改权限模式、扩展可写根目录或覆盖确认门控。Skill 请求的操作使用用户已选择的能力和权限模式执行。
