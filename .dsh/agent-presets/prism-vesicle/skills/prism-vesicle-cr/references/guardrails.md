# Prism Vesicle 评审红线与聚焦点

评审引用依据（蒸馏自 `AGENTS.md`、`CLAUDE.md`、`docs/dev/STYLE.md`、
`docs/dev/ARCHITECTURE.md`、`docs/dev/TOOLS.md`、`docs/dev/WORKFLOW.md`）。
引用时给出具体文档与章节，以及 `file:line`。

## 高优先级边界（CLAUDE.md "High-Risk Boundaries"）

- secrets 不得存入 `providers.yaml`（apiKeyEnv 只放环境变量名；密钥在旁 `.env`）。
- 不依赖项目根 `.env`。
- provider 适配器不得读写文件、运行宿主工具、变更会话、知晓 Prism 阶段。
- Prism prompt 不得硬编码进 TypeScript 源码（`assets/` 运行时文件）。
- 模型可见文件系统访问必须在 `core/tools` 路径守卫之后；绝对路径与 `..` 逃逸被拒。
- 写入工具限于批准根：`source_materials/`、`workspace/`、`test_runs/`、`novels/`、`reports/`（`tmp/` 为草稿根，可写但不可 rewind）。
- 不 commit/push，除非用户明确要求。

## STYLE 红线

- **Prohibited God Structures**（阻断级）：god file / god function / god class /
  mega-controller / service locator / 通用 manager。评审要区分"大小/行数"证据与
  "混合所有权、跨域知识、变更耦合"判定。
- **Make partial success explicit**：请求的持久工作被跳过/吞掉/降级/静默 no-op 时返回成功
  即违规；`catch` 块里返回成功是典型味道，引用该规则。
- 依赖方向：`cli → tui/setup/core/config`；providers 只依赖共享类型与配置；`core/tools` 与
  `mcp` 可共享工具契约但互不依赖 providers/TUI；`skills` 不 import 资产解析器/provider 运行时/Harness/TUI。
- 外部输入保持 `unknown` 直到边界解析验证；cancellation 是独立结果。
- 领域常量复用，不维护平行数组/枚举/路径规则。

## TOOLS 契约要点

- 只读根：`assets/`、`source_materials/`、`workspace/`、`novels/`、`reports/`、`test_runs/`、`tmp/`。
- `list_directory` 是唯一模型可见目录查询；`stat_path` 允许的缺失路径返回结构化 `not_found`。
- 权限模式只改审批摩擦，不扩大能力面；未知工具 fail-closed 进 mutate 类；MCP 工具一律 mutate 类。
- `request_confirmation`/`request_engine_switch`/`ask_user_question` 是交互请求，不在权限运行时内；
  门只在 engine profile `stopGates` 声明时可用。
- `shell_exec`/`run_skill_script` 是宿主用户权限、**非 OS 沙箱**、非 rewind-safe；`skill_exec` 独立权限类。
- 模型不得声称写入成功，除非对应工具结果报告成功。

## CR 聚焦点（docs/dev/WORKFLOW.md "Independent CR"）

1. **Tool safety**：路径守卫、允许根、写语义、工具结果处理。
2. **Provider protocol**：OpenAI 兼容消息形状、tool_calls 循环、流式、错误路径。
3. **Session semantics**：历史复用、JSONL 持久化、回放/调试有用性、resume/迁移。
4. **Prompt honesty**：每个 success 形状返回路径都要审计（`ok: true` 或成功结果对象）。
5. **TUI behavior**：输入、退出、复制、布局稳定。
6. **Tests**：真实失败模式是否有 oracle 独立的回归覆盖。
7. **Docs**：README / STATUS / CHANGELOG / STYLE 与行为一致。

## 输出词汇

- **Blocking**：合并前必须修。
- **Should-fix**：除非有记录在案的延期理由，否则修。
- **Nits**：便宜且与本地风格一致时修。
- **Verified claims**：保留在 PR body 或合并备注。

评审只报告发现，不编辑代码；基于实际 diff + 周边代码，不凭摘要。
