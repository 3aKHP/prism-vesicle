# Prism Vesicle 文档地图（评审/开发导航）

权威路由见仓库 `AGENTS.md` 与 `docs/dev/README.md`。以下是评审与开发最常引用的
契约及其职责；每条规则的详细内容以仓库文件为准，本页只做导航。

| 文件 | 职责（权威） |
|---|---|
| `AGENTS.md` / `CLAUDE.md` | AI 协作入口与协调权威；必读启动文件 |
| `STATUS.md` | 当前实现清单、工具面、已知限制、验证命令 |
| `CHANGELOG.md` | 用户可见变更；行为/配置/契约变更前必读 |
| `CONTRIBUTING.md` | Conventional Commits、公共仓库边界、文档风格、PR 清单 |
| `docs/dev/README.md` | 开发者文档索引、`docs/dev/` 与 `dev/docs/` 边界、维护规则 |
| `docs/dev/STYLE.md` | 源码结构、God Structures 禁令、模块边界、类型/错误、注释、测试设计 |
| `docs/dev/ARCHITECTURE.md` | 分层、依赖方向、跨切边界、契约归属路由 |
| `docs/dev/WORKFLOW.md` | 分支模型、Rapid Development Exception、验证矩阵、CR、发布 |
| `docs/dev/TOOLS.md` | 工具能力、路径守卫、权限、进程、门、提问、Web/MCP 契约 |
| `docs/dev/SESSIONS.md` | 会话持久化、投影、checkpoint、rewind、压缩、恢复 |
| `docs/dev/PROVIDERS.md` | Provider 适配器、协议映射、传输、配置 |
| `docs/dev/OPENAI_RESPONSES_CONFORMANCE.md` | Responses/Codex 应用层剖面与证据契约 |
| `docs/dev/SUBAGENTS.md` | 子代理生命周期与交付契约 |
| `docs/dev/SKILLS.md` | Skill 格式、发现、存储、路径安全、能力边界 |
| `docs/dev/USER_AGENCY_AND_RISK_DISCLOSURE.md` | 用户代理权、风险披露、确认、可强制边界 |
| `docs/dev/ASSETS.md` | 捆绑 Harness 清单、host 扩展层、更新规则 |
| `docs/dev/QUALITY_GUARD.md` | 输出质量门（检测、Semantic Judge、重写生命周期） |
| `docs/dev/TUI.md` | 终端布局、输入、命令、重绘、侧问交互 |
| `docs/dev/STAGE.md` | Stage 引导、三段 packet、prose-first 契约 |
| `docs/dev/SETUP.md` | Windows 安装器、引导、配置事务 |
| `docs/user/zh-CN/` | 用户手册（简体中文为规范），`docs/user/en/` 镜像 |

## 两个易混淆路径

| 路径 | 角色 |
|---|---|
| `docs/dev/` | 已跟踪、公开的当前贡献者/运行时契约 |
| `dev/docs/` | gitignored 机器本地工作台；永远从属于源码、`STATUS.md` 与 `docs/dev/`；`dev/docs/README.md` 有本地路由，`dev/docs/REFERENCE_PROJECTS.md` 是本地参考项目索引 |

## 刻意不存在的文档

`docs/dev/` 下**没有** `PROMPTS.md`、`GATES.md`、`VALIDATORS.md`、`ENGINE.md`：
门行为归 `TOOLS.md`，prompt 组合归 `ASSETS.md` + `src/core/prompt/loader.ts`（engine
profile 的 `systemPrompt` 列表是唯一事实源），engine 剖面在 `assets/engines/*.profile.yaml`，
验证器归 `QUALITY_GUARD.md`。评审不要发明这些文件名作为引用。
