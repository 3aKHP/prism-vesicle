# 参与贡献

[English](./CONTRIBUTING.md) | [简体中文](./CONTRIBUTING.zh-CN.md)

Prism Vesicle 的内部开发仍处于快速迭代阶段，但公开 alpha 版本的发布工作应遵循 [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md) 中的发布分支和 PR 流程。

## 分支与提交风格

日常快速开发期间，`develop` 是活动主干。用户明确要求提交或推送时，小型和中型低风险变更可以直接进入 `develop`。供应商、工具、会话、提示、验证器、引擎配置、大型重构、发布或需要重点审查的高风险工作应使用短期分支和 PR。不要直接推送到 `main`。

提交信息使用 Conventional Commits：

```text
type(scope): summary
```

常用类型：

- `feat`：用户可见的新能力
- `fix`：行为修正
- `docs`：仅文档变更
- `refactor`：不改变行为的内部重构
- `test`：测试覆盖
- `chore`：仓库维护

## 公共仓库边界

不要提交本地运行时状态或密钥：

- 用户级 `.env`
- `.vesicle/`
- 本地提示实验
- 生成的测试工作区
- 供应商 API 密钥、token 或私有 Base URL

用户级密钥文件的格式请参考 [`docs/examples/provider.env.example`](./docs/examples/provider.env.example)。

## 本地开发

```bash
bun install
bun run doctor
bun run typecheck
bun test
bun run dev
```

TUI 从以下位置读取供应商设置：

- Windows 上的用户级供应商注册表 `%APPDATA%\prism-vesicle\providers.yaml`，或其他平台上的 `$XDG_CONFIG_HOME/prism-vesicle/providers.yaml` / `~/.config/prism-vesicle/providers.yaml`
- `providers.yaml` 同目录 `.env` 中的供应商专用环境变量；进程环境变量仅作为后备值
- 可选的供应商级 `userAgent`；未设置时，Vesicle 会根据软件包版本和当前 Bun 运行时版本生成品牌标识
- 同目录 `mcp.yaml` 或 `VESICLE_MCP_FILE` 指定的可选 Streamable HTTP MCP 服务器设置；MCP 请求头密钥仍应存放在用户级 `.env` 中，而不是 `mcp.yaml` 中
- 同目录 `permissions.yaml` 或 `VESICLE_PERMISSIONS_FILE` 指定的可选宿主工具批准设置；该文件不包含密钥，也不得把 YOLO 持久化为默认模式

运行时资产使用独立的只读命名空间：`<project>/assets/` 覆盖 `providers.yaml` 同目录下的用户全局 `assets/`，之后只使用一个完整基线。该基线要么是项目固定并经过验证的托管 Harness Pack，要么是软件包或独立发行版附带的默认资产。排查解析问题时使用 `vesicle assets status`，并优先使用稀疏的 `assets materialize` 覆盖，而不是完整快照。

旧的项目根目录 `.env` 应迁移到用户级配置目录，并在本地删除或重命名。

## 文档风格

Markdown 正文使用自然换行。每个段落或列表项在源文件中保持为一行，由编辑器或渲染器完成视觉折行；不要为了适配固定列宽而手动插入换行。

仅在 Markdown 结构或语义确实需要时显式换行，包括标题、块之间的空行、列表、表格、块引用和代码块。示例、命令输出、诗歌或其他依赖行边界的内容应保留其有意安排的行结构。

根目录文档的职责应保持分离：

- `README.md` 是项目入口，负责安装、首次运行、简明能力概览和文档导航。
- `STATUS.md` 是当前实现清单的权威来源，包括工具接口、验证器、验证方式和已知限制。
- `CHANGELOG.md` 记录值得关注的已发布和未发布变更。
- `CONTRIBUTING.md` 负责贡献者配置、仓库边界和文档约定。
- `docs/dev/STYLE.md` 和 `docs/dev/WORKFLOW.md` 分别负责架构与开发工作流。

详细清单应链接到对应的权威文档，而不是在多个根目录文件中重复维护。

### 文档语言

`README.md` 和 `CONTRIBUTING.md` 是根目录文档的英文规范原文。对应的简体中文版本使用 `.zh-CN.md` 后缀；只要共享语义发生变化，就应在同一次变更中同步更新两种语言。

用户手册使用语言目录扩展：`docs/user/en/` 是规范原文，`docs/user/zh-CN/` 使用相同的相对文件名、章节编号、导航和命令，并保持共享语义同步。`docs/user/README.md` 是语言入口页。

命令、路径、配置键、代码和产品标识在不同语言中保持不变。翻译说明文字时应以清晰自然为目标，不必机械复刻英文句式。

`STATUS.md`、`CHANGELOG.md`、`AGENTS.md`、`CLAUDE.md`、`LICENSE` 和 `docs/dev/` 保持单语。没有重新讨论本规则前，不要为它们创建翻译副本。

## Pull Request 检查清单

- 说明行为发生了什么变化，以及它为何属于当前里程碑。
- 在 PR 描述中列出验证命令。
- 用户可见行为、运行时契约或架构边界变化时，同步更新 `README.md`、`STATUS.md`、`CHANGELOG.md` 或 `docs/dev/STYLE.md`。
- 不要把生成的 `.vesicle/` 会话提交到 Git。
- 新增或编辑的 Markdown 正文应使用自然换行。

## 文档扫描

工具名称、供应商行为、会话语义、配置变量或制品根目录变化时，应在完成工作前搜索文档中的陈旧术语：

```bash
rg "tool|session|provider|workspace|VESICLE_|M0|OpenTUI" README*.md STATUS.md CHANGELOG.md CONTRIBUTING*.md docs assets
```
