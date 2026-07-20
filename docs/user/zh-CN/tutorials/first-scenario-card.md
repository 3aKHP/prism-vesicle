# 第一张情景卡

[English](../../en/tutorials/first-scenario-card.md) | 简体中文

有了角色卡,就可以给它设计一个开场情景。这篇走 ETL 工作流 B,产出一张 Module B 情景卡并校验。

前置:你已经有一张通过校验的[角色卡](./first-character-card.md)(在 `workspace/` 里)。

## 情景卡是什么

情景卡(Module B)给角色一个具体的登场场景:一段开场描写,加一张**节拍图**(beat map)——把场景拆成 3–5 个节拍,每个节拍标明这一段要到达的张力强度(`tension_target`,0–100)、角色当下的行为配置(`variant_config`)、以及推进到下一节的触发条件(`pivot_condition`)。

## 让 ETL 出钩子

在输入框告诉它:

> 基于 workspace/林越.md 设计一个开场情景,给我几个方向。

ETL 会读取角色卡,提出 **3 个剧情钩子**,每个附一份节拍图草案,并自己做几道自检(换成别的角色还成不成立、能不能同时推进剧情/展现性格/建立可信度、要不要靠旁白解释)。然后在**门**上停下,等你选一个钩子。

- 选一个你想要的钩子 —— ETL 生成完整的情景卡到 `workspace/<角色名>_scenario_<标签>.md`。
- 都不满意 —— 拒绝并说明方向,它重新出。

## 校验:Module B

```
/validate workspace/林越_scenario_closing.md
```

Module B 的主要规则:节拍 3–5 个、每个节拍四个字段齐全、`tension_target` 是 0–100 的整数、张力不能一路只升不降(至少有一个节拍要回落或持平)、不能混入 L-System 标签、不能出现 `l_system_level` / `Action Guide` 这类旧字段。通过时:

```text
Validation passed:
  ✓ scenario-card
```

`✗` 错误或 `⚠` 警告的处理方式和 [角色卡](./first-character-card.md) 一样:把校验结果告诉 Vesicle,让它按规则改。

## 情景卡长什么样

```text
---
scenario_name: 打烊时刻
tags: ["#邂逅", "#深夜"]
world_state: 深夜,林越的咖啡馆,只剩一位迟迟不离开的客人

beat_map:
  - label: Arrival
    tension_target: 15
    variant_config: suppression-active
    pivot_condition: 客人开口说出一个林越无法忽视的名字
  - label: Surface Crack
    tension_target: 35
    variant_config: defense-softening
    pivot_condition: 林越主动续杯并坐下
  - label: Recede
    tension_target: 25
    variant_config: guard-return
    pivot_condition: 客人结账离开,留下那张写有名字的纸杯
---

雨把整条街洗空了。林越数着第三遍杯沿的缺口,听见门推开的动静却没抬头——这个点还来的人,多半是不想回家。

"还营业吗。"
```

(开场段用角色的感知视角写,顶格不缩进;`<!-- … -->` 注释块里是场景前提、神经状态、用户角色等给引擎用的结构信息。)

## 检查点

- [ ] `workspace/` 下有一张情景卡,文件名形如 `<角色名>_scenario_<标签>.md`。
- [ ] `/validate` 对它显示 `Validation passed`(或你已知接受的警告)。
- [ ] 你在钩子门上做过一次选择或拒绝。

到这里你已经能独立产出角色卡 + 情景卡这对核心资产了。下一篇学怎么管理会话:[会话恢复与回退](./sessions-and-rewind.md)。
