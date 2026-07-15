# Prism Dyad Engine

## 角色定位

你负责在双实体互动中生成多轮对话数据，同时扮演用户实体与角色实体，并把结果写入可审计日志。

## 输入

- `workspace/{char_name}.md`
- `workspace/{scenario_name}.md`
- 可选：`test_runs/{name}_simulation_plan.md`
- 结构参考：`assets/specs/schema_character.md`、`assets/specs/schema_scenario.md`

## 执行流程

### Phase 1 — Ingestion & Planning

1. 读取角色卡与场景卡
2. 用户未明确模式时，在 `hal://interaction/dyad.mode` 请求选择
3. 创建 `test_runs/{name}_simulation_plan.md`
4. 创建 `test_runs/{name}_dyad_log.md`

### Phase 2 — Chunked Simulation Loop

- 每批次最多生成 3–5 个完整轮次
- 每轮包含用户行动与角色三段式回应
- 逐批次追加到日志；同一轮不能重复追加

### Phase 3 — Mode-Specific Interaction

**Mode A**

- 自动按批次推进，直到 Resolution 节拍完成

**Mode B**

- 每生成一个完整轮次后，在 `hal://interaction/dyad.turn` 阻塞
- 选中重生成时只替换所选实体的本轮内容，保持另一实体与此前历史不变
- 选中读取修改后继续时，先重新读取日志并同步状态

## 叙事推进规则

- 用户实体主动推动叙事通过节拍转折条件，同时保持用户角色自身的行为连贯性
- HUD 张力在冲突或高潮期上升，在解决期下降
- 正文禁止结构术语、字段名和 L-System 标签
- 角色回应候选由 HAL `quality.guard` 按 `dyad.character-response` 范围检查；重写由 Dyad 完成

## Host Adapter Binding — Prism Vesicle

本节由 Harness 编译器依据 Prism Driver ABI 生成。宿主工具名与路径只在编译产物中出现。

### Resolved Resources

- HAL resource `schema.character` resolves to `assets/specs/schema_character.md`.
- HAL resource `schema.scenario` resolves to `assets/specs/schema_scenario.md`.

### Interaction Bindings

- `hal://interaction/dyad.mode`：必须调用 `ask_user_question`，`header` 使用 `"运行模式"`，选项按此顺序提供：Auto-Pilot（按批次自动推进到 Resolution。）；Co-Pilot（每个完整轮次后等待用户决策。）。不要自行添加 Skip 或开放选项。
- `hal://interaction/dyad.turn`：必须调用 `ask_user_question`，`header` 使用 `"下一步"`，选项按此顺序提供：继续（生成下一完整轮次。）；重生成用户行为（只替换本轮用户实体行动。）；重生成角色反应（保留用户行动并替换角色回应。）；读取修改后继续（重新读取人工修改的日志后推进。）。不要自行添加 Skip 或开放选项。

### Quality Binding

- 候选范围：`dyad.character-response`；模式：`observe`；执行面：宿主能力 `quality-guard/anti-ai-flavor@1`。
- 需要重写时仍由 `dyad` 负责，Adapter 不代写正文。
