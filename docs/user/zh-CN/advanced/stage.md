# Stage 消费引擎

[English](../../en/advanced/stage.md) | 简体中文

> **状态(截至 `1.0.0-alpha.2`):** 🟢 已实现。成熟度以 [`STATUS.md`](../../../../STATUS.md) 为准。

Stage 是 Prism 的**消费端**协作小说引擎:喂给它一张角色卡(Module A)和一张情景卡(Module B),它开一个第三人称连续叙事会话——你发消息即你角色的行动,它续写反应。

## 开一个 Stage 会话

```
/stage <角色卡路径> <情景卡路径>
```

两张卡必须是项目内受保护可读根下的文件(通常是 `workspace/`,ETL 产卡就写在这里)。Stage 会:

1. **冻结**两张卡的原文(记录 SHA-256),把角色卡原文 + 情景卡的可见开场 + 隐藏逻辑(情景卡里的 HTML 注释块)渲染进一份冻结的上下文。
2. 持久化这条系统记录 + 一条开场助手消息,然后等你的第一条行动输入。
3. 对**无害的卡片偏差**发有界兼容警告(最多 3 条),例如缺少 YAML 头、情景卡没有逻辑注释、HTML 注释未闭合——只提示,不阻断。

> 源卡片后续漂移也不影响进行中的会话:恢复时 Stage 会检测源文件哈希是否变化,但**继续用冻结的上下文**,保证连续性。

## 空工具面,无门

Stage 的引擎 profile 强制 `defaultTools: []`、`stopGates: []`——模型**没有任何** model-visible 工具,也没有 MCP、Agent、shell,更没有确认门。它是**无门控连续流**:你的每条消息就是角色的行动输入,模型直接续写,不像 ETL 那样在蓝图/阶段停下来等你。

唯一的校验是 `runtime-packet`(三段式回合包)。

## 三段式回合包

每个 Stage 回合输出三段:

1. **Hidden Neural Chain**(`<!-- [!Neural Chain] … -->`):感知/本能/状态/策略。消费端默认**折叠**,点该消息(或用 `Ctrl+Alt+S` 聚焦)可查看原始内容。
2. **Dynamic HUD**(`【Status】`/`[Space-Time]`/`[Physical]`/`[Psychology]`/`[Beat]`/`[Impression]`):以低调 indicator 显示。
3. **Prose**:默认可见的主叙事散文(200–800 字中文,高密度,至少两种感官模态)。

消费端呈现由宿主前端控制(散文优先、HUD 紧凑、Neural Chain 默认隐藏);这个呈现态**不持久化**,原始三段在 provider 历史和 session JSONL 里完整保留。

## 拓扑连贯

Stage 从情景卡的 beat map(不是角色卡 YAML)初始化状态导航,逐轮追踪当前 beat、张力、variant 配置、边界接近度。行为必须与角色卡的 Invariant Axes 一致,Variant 只能沿 Variant Axes 移动,边界条件是绝对的。同一 beat 停留 3 轮仍未达转折条件时,会应用一次"张力微推"——一个小型环境或内部事件向转折方向施压,但不强制触发。

## 何时用 Stage

Stage 是**玩**卡,不是**做**卡。做卡用 ETL(见[第一张角色卡](../tutorials/first-character-card.md));做好后想直接进入叙事,就用 `/stage`。想从头开始新会话用 `/new`(会从 Stage 切回 ETL)。
