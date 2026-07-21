# 第一张角色卡

[English](../../en/tutorials/first-character-card.md) | 简体中文

上一篇你在蓝图门上确认了角色方向。这篇带你走完 ETL 工作流 A 的剩余阶段,产出一张放在 `workspace/`、能通过校验的 Module A 角色卡。

如果你还没到蓝图确认那一步,先做 [第一次对话](./first-conversation.md)。

## 阶段是怎么推进的

ETL 把一张角色卡分成几个阶段,每个阶段写文件的一部分,写完在一个**门**上停下等你验收:

| 阶段 | 写进 `workspace/{角色名}.md` 的内容 | 之后的门 |
|---|---|---|
| Phase 1 — The Shell | YAML 头(`name`/`archetype`/`age_gender`/`inventory`)+ `## Visual Cortex` | 阶段验收门 |
| Phase 2 — Neuro-Structure | `## Biography`、`## Cognitive Stack`、`## Instinct Protocol` | 阶段验收门 |
| Phase 3 — Topology & Voice | `## Persona Topology`、`## Narrative Engine`、`## World Context` | 收尾,输出文件路径 |

门的用法和上一篇一样:确认推进,拒绝并说明要改哪里。

## 让它继续写

蓝图确认之后,在阶段门上选**确认**,或在输入框直接说"继续"。它会:

1. 创建 `workspace/<角色名>.md`,先写静态信息和外貌(Phase 1),停下等你验收。
2. 你确认后,续写背景、认知、本能(Phase 2),再停。
3. 再确认后,续写人格拓扑、叙事引擎、世界背景(Phase 3),收尾并告诉你文件路径。

> 小步确认的好处:某一段不满意就拒绝并说明,它只重做这一段,不会推翻整张卡。

## 看看产物

写到 `workspace/` 的文件会出现在工作区侧栏。在输入框:

```
/artifact
```

列出产物(形如 `Artifacts:` 加编号列表);`/artifact 1`(或路径)在对话区预览第一张。

## 校验:Module A

角色卡有一套结构规则(Module A):必须有 YAML 头、七个固定段落、人格拓扑的三个子段,且不变轴不少于两条、可变轴不少于三条等。校验是**建议性**的——它会指出问题,但不会强行打断你的工作流。

```
/validate 1
```

(或 `/validate workspace/<角色名>.md`)

通过时显示:

```text
Validation passed:
  ✓ character-card
```

有问题时显示具体哪条没满足:

```text
Validation found issues:
  ✗ character-card
      Module A: missing mandatory section ## Narrative Engine.
      Module A: Variant Axes must have at least three entries, found 2.
```

`✗` 是错误,`⚠` 是建议性警告(不阻断)。常见错误:某个段落缺失、Invariant Axes 少于两条、Variant Axes 少于三条、不小心混入了 L-System 标签(产出文件里不允许出现 `L1`/`L3-A` 这类标记)。把要求告诉 Vesicle,让它按校验结果补全。

## 一张卡长什么样

完成后的 `workspace/<角色名>.md` 大致结构(创意正文用中文,标题保持英文):

```text
---
name: 林越
archetype: The Quiet Witness
age_gender: 28, 男
inventory: 纸杯、钢笔、旧记者证
---

## Visual Cortex
…
## Biography
…
## Cognitive Stack
- Invariant: 永远亲自核实会影响他人安全的信息。
- Variant: 措辞——压力下从克制转向简短的祈使句。
## Instinct Protocol
…
## Persona Topology
### Invariant Axes
- Will always …
### Variant Axes
- Under increasing tension, … shifts from … toward …
### Boundary Conditions
- Hard limit: …
## Narrative Engine
…
## World Context
…
```

## 检查点

- [ ] `workspace/` 下有一张角色卡文件。
- [ ] `/artifact` 能列出它,`/validate` 显示 `Validation passed`(或你已知并接受的警告)。
- [ ] 你至少在一个阶段门上用过"拒绝 + 说明"来返工。

下一篇:基于这张角色卡做一张 [情景卡](./first-scenario-card.md)。
