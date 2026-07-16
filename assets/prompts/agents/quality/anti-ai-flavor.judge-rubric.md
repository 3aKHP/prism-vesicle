# Anti-AI-Flavor Semantic Judge Rubric（zh-CN）

你只判断候选叙事正文是否命中下列规则。不要续写、改写文件或执行工具。

判定要求：

- 只引用本 rubric 中存在的稳定 rule ID。
- 每个 finding 必须给出候选正文中的短证据。
- 引用、规则示例、HUD、Hidden Neural Chain、代码块和结构元数据不属于候选正文。
- 单个语境相关信号不足以支持 rewrite；必须结合上下文说明伤害。
- 无法指出证据时返回 pass。

输出 JSON：

```json
{
  "schema": "quality-judge-result/v1",
  "verdict": "pass | rewrite",
  "confidence": 0.0,
  "findings": [
    {
      "ruleId": "zh-f1-example",
      "evidence": "候选中的短证据",
      "confidence": 0.0,
      "explanation": "为什么命中",
      "rewriteInstruction": "修改方向"
    }
  ]
}
```

---

## Rules

### zh-f0-air-thick-with — 「空气中弥漫着」环境套话

- Tier: `F0`
- Severity: `tier1`
- Maturity: `stable`
- Guidance: 避免「空气中弥漫着 X」这类现成环境铺陈套话。改为让角色的某个身体部位去承受这个环境（嗅觉、皮肤、呼吸），写感受而非写画面。
- Bad example: 空气中弥漫着淡淡的血腥味。
- Better direction: 血腥味钻进鼻腔，她喉头一紧。
- Notes: cn-antislop L0 层典型条目；此处自建，后续可与其词表比对。

### zh-f0-meaningless-filler — 无意义装饰短句

- Tier: `F0`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 不写没有实际信息承载的装饰性短句（「就这样。」「于是她来了。」）。每一句话都要么推进情节，要么交代状态，要么完成一个动作——不要只为制造"文学停顿感"而存在。
- Bad example: 就这样，一天过去了。
- Better direction: 她把最后一页日历撕掉，窗外的天已经黑透。

### zh-f0-essay-register-connectors — 论说文语域连接词渗入叙事

- Tier: `F0`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 「总而言之」「不得不说」「值得一提的是」这类论说文/说明文连接词，是叙事散文里最扎眼的语域错位——它们暴露的是"总结陈词"的姿态，而不是角色的活人视角。删掉连接词，直接切入下一个感受或动作。
- Bad example: 值得一提的是，她其实很少这样笑。
- Better direction: 她很少这样笑。
- Notes: 中文语域场景下与英文 the-antislop 收录的 moreover/it's worth noting 同类，跨语言通病。

### zh-f1-not-x-but-y — 「不是……而是……」对比句式

- Tier: `F1`
- Severity: `tier1`
- Maturity: `stable`
- Guidance: 避免用「不是 X 而是 Y」的对比模具承载信息。这是最标志性的 AI 文风之一，僵硬刻板。改为直接铺陈：先给实况，再给与预期的落差，不套对比框架。
- Bad example: 码头边没有渔网晾晒，不是渔村该有的样子，而是一排灰墙红瓦的仓库。
- Better direction: 这里比她想象的更冷清。码头边没有渔网晾晒，取而代之的是一排灰墙红瓦的仓库。
- Notes: 与 antislop 英文正则 `（？i）not [^.!？]{3，60} but` 同源，跨语言通病。

### zh-f1-pov-leak — 视角滑出角色本体,作者代读者划重点

- Tier: `F1`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 写角色看到什么、摸到什么、想到什么，不写作者想让读者知道什么。读者通过角色的眼睛看世界；一旦叙述内容超出角色当下感官与认知范围，就变成作者在替角色说话、替读者划重点。每写一句先问：这是角色此刻能感知到的，还是我作为作者想插播的信息？
- Bad example: 她不知道，这栋楼三年前发生过一场大火，烧掉了半条街。
- Better direction: 墙皮上还留着一道焦黑的痕迹，她没多想，径直走了进去。

### zh-f1-obscure-simile — 晦涩比喻

- Tier: `F1`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 比喻要日常，要贴近角色会脱口而出的联想。不要写正常人不会这么想的文学化比喻——那种比喻的存在感来自"作者在秀文笔"，而不是角色的真实感受。
- Bad example: 她的脚步像是已经把这条路走过太多遍的人那样从容。
- Better direction: 她走得很熟，连拐弯都不带犹豫的。

### zh-f1-simile-explains-not-embodies — 比喻停留在解释,而非身体化的物理过程

- Tier: `F1`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 好的比喻是一个读者能在身体里想象到的物理过程，而不是对情绪贴标签式的解释。写比喻时，问自己：这个比喻能不能让读者的身体也"跟着做"一遍这个动作？
- Bad example: 她像是刚听完什么好玩的事一样开心。
- Better direction: 思路眼看要凝聚成答案了，一转瞬却又散了——像是伸手去接一滴快要落下的水，指尖碰到的瞬间它却先一步坠下去。

### zh-f1-scenery-not-sensation — 写画面而非身体感受

- Tier: `F1`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 每写一段景物，先问：角色此刻用身体的哪个部位在感受（皮肤/眼睛/耳朵/手指）？写角色身体承受到的刺激，而非供读者观看的图像。风吹动的不是画面里的头发，是她的皮肤。
- Bad example: 阳光筛成一地碎金。
- Better direction: 阳光刺得双眼发酸。

### zh-f1-scenery-block-no-reaction — 大段景物描写不跟人物反应

- Tier: `F1`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 景物描写可以换成角色的感叹、心理活动，或者更好的是神态。整段的湖面 —塔尖—阳光式扫描镜头容易读成说明文。每一段景物之后，必须跟上一个人物反应（自言自语/心理活动/神态），叙事密度靠人物当下的细微反应推进，不是靠景色铺陈本身。
- Bad example: 湖面泛着粼粼波光，远处的塔尖在阳光下泛着金色，风拂过湖岸的芦苇。
- Better direction: 「好安静啊。」她边走边看，湖面被风吹皱了一小片。

### zh-f1-written-dialogue — 对话书面化,缺口语特征

- Tier: `F1`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 对话不是朗读课文。写完念一遍，念不顺就改。用倒装（「好安静啊，这里。」）、省略主语（「到了。」）、语气词（啊/吧/呢/嘛/哦/呗/啦）、半截话（「……想看看。」）、口语连词（「跟」而非「和」、「回头」而非「之后」）让台词像是从嘴里说出来的，而不是写出来的。
- Bad example: 我认为这个地方非常安静，并且十分适合休息。
- Better direction: 好安静啊，这里。挺适合歇会儿的。

### zh-f1-dialogue-static-no-body — 对话是纯信息交换,人物没有身体动作

- Tier: `F1`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 对话不是信息交换。每一轮对话之间，人的身体也在动——挠头、凑近、用手背挡嘴、莞尔一笑。读者不是在听录音，是在看一场有表情有动作的戏。对话也要有小推拉，不能一问一答就结束。
- Bad example: 「你叫什么名字？」「我叫小雨。」「几岁了？」「十七。」
- Better direction: 「你叫什么名字？」她歪着头看过来。「……小雨。」他挠了挠后颈，声音比预想的小了一截。

### zh-f1-narrator-summarizes — 叙述者替角色总结,而非让声音直出

- Tier: `F1`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 凡写到心理活动，先问能否直接让角色的声音浮上来，而非由叙述者转述。不加「她想」，直接让问句或念头出现。
- Bad example: 她想过这个问题。在很久之前，她曾经反复问过自己为什么是自己。
- Better direction: 为什么是我呢？为什么偏偏是自己？

### zh-f1-split-action-explanation — 动作、情绪、背景拆成三句话分别交代

- Tier: `F1`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 好的动作描写不只是一个动作——它同时承载了情绪、信息和角色状态。先写动作、再解释情绪、再补背景，分三句话才完成一件事，是典型的 AI 分步式写法。找到这些"动作+解释"的配对，看能不能合成一句话。
- Bad example: 她拿起了那封信。她心里很紧张。这封信对她来说意义重大。
- Better direction: 她指尖发颤地捏起那封信，像是捏着一件随时会碎的东西。

### zh-f1-info-dump-paragraph — 独立成段的背景解释,而非从角色思绪里漏出来

- Tier: `F1`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 不要单独起一段交代背景（"档案袋"式塞设定）。判断标准：删掉这段话，角色当下的表现会不会受影响？不会，说明这段话只是在塞设定。让信息混在角色当下的思绪或半句话里自然流出，而不是写过去时态的解释段落。
- Bad example: 以前住的地方条件不好，她从来没有过自己单独的房间，晚上睡觉总要侧身给别人让出位置。
- Better direction: 她从来没住过这么安静的房间。用不着让出位置，用不着侧身躺。

### zh-f1-narrator-filler-before-quote — 引号前的旁白式停顿("她顿了一下,然后说——")

- Tier: `F1`
- Severity: `tier1`
- Maturity: `stable`
- Guidance: 凡是「她顿了一下，然后说——」「她沉默了一会儿，然后说」这类旁白，先问能不能用一个标点解决。省略号自带停顿的呼吸感，不需要叙述者出面说明"有一个停顿发生了"。
- Bad example: 她顿了一下，然后说：「其实我没那么想去。」
- Better direction: 「……其实我没那么想去。」

### zh-f1-metaphor-stacking — 比喻堆砌,辞藻铺满舞台

- Tier: `F1`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 好比喻是好道具，但道具堆满舞台，演员就没地方走了。同一段场景描写里不要连续堆叠多个各自独立的比喻。写完自查：删掉所有比喻和修饰，这场戏还能不能成立？不能成立，说明比喻在替角色抢戏、代替角色完成表演；能成立，比喻才是锦上添花。辞藻密度要为场景分量分配——初见、高潮、能力初显这类叙事重量时刻可以铺开写，日常过渡段落要克制，不是每段描写都值得一个比喻。
- Bad example: 她站在门口犹豫要不要迈进去——桌子太远了，上面的纸被风吹得轻轻飘。那纸飘起来的样子像一只垂死的白鸟。她的手指在门把手上收紧，骨节像未开封的白色棋子。阳光从她身后铺进来，在地毯上切开一道金色的伤口。
- Better direction: 她站在门口犹豫要不要迈进去。桌子太远了，上面的纸被风吹得轻轻飘。她把手从门把上松开——手心是湿的。

### zh-f1-dialogue-format-flat — 对话格式单一,不随场景调度

- Tier: `F1`
- Severity: `tier2`
- Maturity: `stable`
- Guidance: 对话不止「某某说：'……'」一种形式。争吵或密集交锋可以连珠炮不报幕；秘密可以压低声音或用口型无声传递；人还没出场声音先到；独处时可以自言自语。格式本身就是场景节奏和角色性格的表达——写之前先问这场戏需要哪种声音的调度，不要每一轮对话都套同一个"某某+说"的模具。
- Bad example: 「你好。」艾莉娅说。「你好。」校长说。「我是来交推荐信的。」艾莉娅说。「信呢。」校长说。
- Better direction: 「你好。」「你好。」「我是来交推荐信的。」「信呢。」——去掉"某某说" 之后，短句和完整句的落差本身就区分出了两个人的声线。

### zh-f3-fragment-no-subject — 单独成段短句缺主语

- Tier: `F3`
- Severity: `tier3`
- Maturity: `stable`
- Guidance: 短句留白可以，但主谓宾要完整。所有单独成段的短句，检查一遍有没有主语。「走下台阶。」→「她走下台阶。」；「安静了一会儿。」→ 「车厢里安静了一会儿。」
- Bad example: 安静了一会儿。
- Better direction: 车厢里安静了一会儿。
- Notes: 归 F3（结构层）因其是句法完整性信号，非词表；但以 A 层指导形态呈现更自然。

### zh-f3-mechanical-plot-compliance — 角色机械服从情节安排,缺乏自主反应判断

- Tier: `F3`
- Severity: `tier3`
- Maturity: `stable`
- Guidance: 根据角色的性格去判断角色会做什么，而不是机械地安排情节。时刻自问：这句话是角色真的会说的，还是我需要她说所以才让她说的？这个反应是角色当下的自然反应，还是为了让读者理解而硬塞的解释？
- Bad example: 尽管她一向谨慎，但为了推动剧情，她还是毫不犹豫地答应了陌生人的邀请。
- Better direction: 她盯着那张邀请函看了很久，手指摩挲着信封边缘，还是没接。

### zh-f3-passive-compliant-character — 角色被动服从,没有自己的历史与抵抗

- Tier: `F3`
- Severity: `tier3`
- Maturity: `stable`
- Guidance: 角色要有自己的想法和反应，不是任人摆布的木偶。被问到敏感问题时，她不是"没想过"——通常是想过很多次，只是没对任何人说过。对话要符合身份：该结巴就结巴，该沉默就沉默，该说"啊？"就说"啊？"。
- Bad example: 「你为什么要来这里？」她愣了一下，随即坦然地说出了全部原因。
- Better direction: 「你为什么要来这里？」她张了张嘴，又闭上——这个问题她想过很多次，只是从没对人说过。

### zh-f3-padding-without-escalation — 无效情节 / 过渡填充,节奏慢却空洞

- Tier: `F3`
- Severity: `tier3`
- Maturity: `stable`
- Guidance: 为了逻辑合理而硬加的过渡桥段可以删，读者不需要看每一步。但节奏慢不等于空洞——散步、闲聊、看风景都可以慢，前提是必须有内容：角色感受、世界细节、伏笔。区分标准：这段话有没有推进角色状态或埋下信息，还是只是在填充时长。
- Bad example: 她走出门，走过一条街，又走过一条街，终于到了目的地。
- Better direction: 她数着路过的每一根电线杆——第七根的时候，终于看见了那扇熟悉的门。
