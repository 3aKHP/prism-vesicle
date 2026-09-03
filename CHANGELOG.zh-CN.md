# 变更日志

本文件记录本项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/),本项目遵循 [Semantic Versioning](https://semver.org/)。

本文件是 `CHANGELOG.md` 的简体中文伴生文件;英文版为唯一真源,两者按版本段落一一配对,语义以英文版为准。维护规则:修改 `CHANGELOG.md` 的同一变更必须同步更新本文件对应段落。

## [Unreleased]

### 新增

- **已激活的 Skill 现在作为只读 `skills/` 逻辑根挂载在普通文件工具之后(来自 #268 第 2 项)。** `activate_skill` 之后,Skill 的捆绑文件可以通过 `skills/<name>/<skill-relative path>` 从 `stat_path`、`list_directory`、`grep_files`、`read_file` 与 `view_image` 访问 —— 模型可以用它已用于项目文件的同一个 `grep_files` 检索捆绑文档(例如 `vesicle-docs`),再用 `read_file` 读取命中行。挂载沿用 `assets/` 命名空间设计(由解析器支撑,永远不是项目目录),跟踪激活状态,始终解析目录胜出者,并保留共享的 256 KiB Skill 文本上限;所有写形态的访问都拒绝 `skills/` 路径,`read_skill_resource` 不变。完整契约见 `docs/dev/TOOLS.md` § Read-only `skills/` mount。
- **后台 shell 完成事件现在会自动唤醒空闲的父会话(issue #284)。** 此前后台任务完成后必须等你的下一条消息,模型才能看到结果;工具描述中的“免轮询”承诺只在回合进行期间成立。一个镜像后台 SubAgent 设计的完成调度器对终止性任务事件做去抖与合并,当父会话空闲 —— 回合已结束、无待处理的门/问题/权限 —— 时开启一个续接回合,把合并后的信封交给模型。繁忙会话、未解决的交互与会话恢复会安全推迟,状态清空后投递一次;投递的供应商回合失败或被中断时暂停,并在你的下一条消息后重试;宿主停机期间发生的完成事件在会话恢复时投递。每次投递都是正常的供应商回合,并相应消耗 token。
- **仓库现在带有 issue 与 pull request 模板**(`.github/`)。常规 PR 预填 WORKFLOW 的 PR 正文形状 —— 标明适用 Change Grading Workflow 等级的 `Grade` 行、权威的 `Closes` 关闭声明,以及验证清单加一条目标测试说明。发布 PR 有专门的发布准备清单模板,经 `gh pr create --template .github/PULL_REQUEST_TEMPLATE/release.md` 打开(GitHub 不提供 PR 模板选择器)。issue 提供结构化的双语缺陷/功能表单,外加一个备忘 issue 模板,把仓库的备忘 issue 体裁固定为形状权威;空白 issue 已禁用。`docs/dev/WORKFLOW.md` § Release Lifecycle 现在把面向发布的文档戳记(README 频道措辞与 Status 徽章、进阶用户手册成熟度戳记、`STATUS.md` 快照头)列为发布冻结的一部分(issue #278)。
- **GitHub Release 正文现在从配对的双语 CHANGELOG 确定性组装(来自 #268 第 10 项;交付 #265 延后的脚本化条目)。** `CHANGELOG.md` 新增结构配对的简体中文伴生文件 `CHANGELOG.zh-CN.md` —— 英文版保持唯一真源,`bun run changelog:check` 钉住配对(版本标题逐字一致、逐版本子节/条目计数一致),经契约测试与 pre-commit 钩子强制执行。发 tag 时,新的 `scripts/release/compose-notes.ts` 组装发布正文:该版本的 CHANGELOG 英文段与中文伴生段在双语标题下交错、瘦身后的常驻披露(带政策链接的两行双语签名状态、一句 MCP 延后指引;供应商原生搜索段落永久移出发布正文 —— 它描述配置,归宿本就在用户手册)、仅 prerelease 与频道首个 stable 携带的 dist-tag 指引,以及末行的 Full Changelog 链接,其比较基确定为紧邻的上一个任意渠道已发布 tag。该规则取代 GitHub 的 `generate_release_notes` —— 后者在仓库首个非预发布版本上跳过全部 prerelease 基线并回退最早 tag,把整段 v0.1.0…v1.0.0 历史倾倒进已发布的 1.0.0 正文;最初草拟的「上一个 stable,无则最新 prerelease」推导在本地 dry run 中被发现会复现同一回退,落地前即修正,哨兵测试钉住 `v1.0.0 → v1.0.0-rc.1`。

### 变更

- **折叠的提示文本现在可以经 Tab 切换的正文区域滚动,备注通过输入激活(来自 #268 第 4 项)。** 门摘要(通常数十行 —— ETL 门会内联蓝图)、权限命令/JSON 详情与问题文本此前被头部截断成几行,没有任何办法读到其余部分;现在 `Tab`/`Shift+Tab` 在选项键位映射与阅读区域之间切换提示,阅读区域内 `↑/↓` 逐行滚动、`Home`/`End` 跳转,折叠正文显示一行强调色提示(`▸ 43 lines folded · Tab to read`),阅读时变为明亮的位置行(`▾ lines 5-8 of 30`),正文旁边的栏列在正文区域持有键盘时以品牌色点亮。`Enter` 在阅读区域内永不提交。原先的“Tab note”开关被停止门与 Engine 切换提示上的“输入即备注”取代:在聚焦的确认选项上输入或粘贴会直接展开其备注输入(Reject 保留常驻输入;Esc 语义不变)—— 该开关在小组测试中难以被发现。权限提示只在 Reject 上保留备注:其 Allow 路径端到端从未接受过备注,因此在上面输入会被吞掉而不是武装一个不可见的缓冲 —— 而 Reject 的备注编辑器现在只要 Reject 聚焦就会渲染,修复了该行从不出现的既有缺陷(其渲染条件键在一个没有任何代码路径会设置的反馈模式上),因此输入的拒绝理由会在屏幕上回显,而不是在无人看见的情况下发给供应商。问题文本换行到 3 行预算,而不是硬性单行截断。质量/模型/Skill 选择器保留其窗口化选择,不新增区域。
- **决策提示不再遮挡 Workspace 页或困住页面切换(来自 #268 第 3 项)。** 回合中的交互提示(权限批准、停止门、问题、质量决策)此前在两页共用底部横条 —— 覆盖 Workspace 工作台下半部分、夺取其键盘,甚至扣住 `Ctrl+O` 直到被应答。现在 `Ctrl+O` 的优先级高于一切底部表面模态,你可以在任何提示或选择器打开时在 Chat 与 Workspace 之间切换;在 Workspace 页上,四种决策提示折叠为输入框上方的一行待决条(例如 `◆ Permission pending · Ctrl+O to answer`),树/查看器/编辑器行与三区 `F6` 焦点模型保持不变。完整面板在 Chat 页渲染,你在那里应答它;在那之前输入框接受草拟,但 Enter 既不发送也不排队(草稿保留),因为待决决策拥有该回合。你自己打开的选择器与确认框仍在两页显示完整面板。
- **新会话现在在诞生时显式创建模型可写的项目根(issue #291,来自 #268 第 1 项)。** `source_materials/`、`workspace/`、`novels/`、`reports/`、`test_runs/` 与 `tmp/` 现在预先创建,而不是在首次写入时惰性出现,因此新项目首次读取 `<project_state>` 得到 `empty` 而不是一整面 `absent`,会话存在后 Workspace 显示标准文件夹。创建是尽力而为:被占用或不可读的路径(例如名为 `workspace` 的普通文件)只产生一条转录警告,项目状态继续诚实地把该根报告为 `inaccessible`。只读 `assets` 根被排除;恢复的会话不会重建你删除的根,写工具的惰性 mkdir 兜底不变。
- **终端标题的空闲与需要输入标记现在与工作脉冲共享方块家族(issue #290,来自 #268 第 7 项)。** 静态状态标记从 `·`(U+00B7)与 `!`(U+0021)—— 在标签条尺寸下相对工作帧太轻 —— 换成空闲 `■`(U+25A0)与需要输入 `▣`(U+25A3),与 `◰`/`◳`/`◲`/`◱` 脉冲拥有相同的方块轮廓与相同的单列步进,三种状态读起来是一个家族。工作帧集合、800ms 节奏、`VESICLE_REDUCED_MOTION=1` 静止帧与无写入覆盖不变。该方案经人工观察探针选定(`scripts/probe/terminal-title-marker-probe.ts`)。
- **OpenTUI fork 运行时推进到 `0.5.10-zv5`**(自 `0.5.3-zv6`;fork 基线在 v0.5.9 重新并入 upstream,现在携带 upstream v0.5.10;下文裸 `#N` 仍指宿主 issue,upstream 变更带 `upstream #N` 限定符)。自 v0.5.9 基线:字节精确的布局重写(upstream #1428)与拖拽选择的含端点语义(upstream #1393)—— 跨单元格拖拽包含结束单元格,因此主题文本的选择预期带有一个尾随空格。自 v0.5.10:兼容的顶层 markdown 可渲染对象在流完成时保持挂载,而不是在完成 UI 渲染期间被销毁重建(upstream #1469);输出在背压下拒绝最终自动帧时会重试该帧,而不是保留显示上一帧(upstream #1457);图像流式开销降低,原生回滚图像在固定页脚上方保留(upstream #1467、#1470);fork 构建的 linux/win32 平台包附带剥离的原生库与分离的发布符号(upstream #1437)。在升级后的运行时上验证:完整本地套件 2429 项测试(2419 通过、10 项平台跳过、0 失败)且无预期变更,外加 npm 包消费者冒烟(全局/本地安装、audit、PTY TUI 启动;继 #273 之后,issue #294)。
- **Markdown 删除线现在要求双波浪号 —— 单独的 `~text~` 按字面文本渲染(issue #294,来自 #268 第 5 项)。** 小组测试指出 `~大概这样~` 这样的文本会悄悄变暗并隐藏波浪号:原生 markdown 解析器把任何单波浪号区间都当作删除线,遵循 GFM 的实现行为(规范的 Example 491 与 GitHub 接受一到两个波浪号)。Vesicle 现在采用 fork 的严格双波浪号风格,与 pandoc/remark-gfm 的解读及同类 Agent 先例一致(claude-code#19251、copilot-cli#1936):`~~text~~` 照常删除并隐藏定界符,而 `~text~` 的每个字符作为纯文本保持可见 —— 无论在正文、表格单元格还是流式期间。`H~2~O` → `H₂O` 下标显示变换仍在解析器之前运行,因此下标不受影响,纯文本渲染器保持单波浪号区间字面不变。已知残留:包裹双波浪号区间的单独单波浪号区间(`~a ~~b~~ c~`)仍照旧变暗 —— 收紧它需要 fork 侧源码过滤,仍是已记录的限制。fork 的原生查询保持字节一致;严格变体作为单独的查询资产交付,新的契约测试钉住捕获矩阵以防 fork 静默回归。

### 修复

- **重生成、回溯或候选切换到迁移前的回合不再误报 Harness identity 漂移(issue #298)。** 迁移记录的身份重绑定此前只从被选内容分支读取,因此任何在它之前截断的 fork 头 —— 重生成任何迁移前回合(报告中的场景是迁移后立即 `Ctrl+R`)、回溯越过迁移、或切换到更早记录的候选 —— 都会复活迁移前基线,令 bootstrap 身份断言失败,直到发送一条无关新消息才恢复。迁移后的有效身份与冻结的 Skill 目录快照现在是与 engine/provider 偏好同层的会话级 Host 状态,按物理 JSONL 顺序投影,因此每个分支都观察到迁移后基线。`assertSessionHarnessIdentity`、畸形迁移记录的失败关闭处理,以及无迁移记录会话的真实漂移语义不变。
- **确认的 Harness 迁移现在会重新冻结会话的 Skill 目录,内容已变化的捆绑 Skill 可以重新激活,不再永久失效(issue #298)。** 在捆绑 Skill 内容变化之前冻结的会话(例如 `skills/` 只读挂载改造之前的 `vesicle-docs`)永远无法重新激活它:持久化快照从不匹配新的正文 hash,且不存在任何重新冻结路径。迁移预检现在解析完整的当前目录 —— 报告带重新激活指引的已变化 Skill、已消失的 Skill 与新增的 Skill —— 确认迁移时把该快照与身份重绑定一起持久化在同一条 `session-migration` 记录内,原子完成。激活存活规则升级为名字加内容 hash:冻结目录不再提供所记录 hash 的激活视为未激活(绝不静默换上新正文),`/skill <名字>` 重新激活不再被去重压制,旧的激活记录保留在历史中作为审计痕迹。
- **后台 shell 完成事件不再被记录或投递为普通用户输入(issue #284,投递形态)。** 完成包 —— 命令加 stdout/stderr 尾部,全部是不可信的进程数据 —— 此前作为 `role:"user"` 记录持久化,并作为裸用户文本送上线路,赋予进程输出用户指令的权重。它现在作为 `background-process-results` 系统记录持久化,投影回完全相同的供应商可见消息,其内容是一个显式的宿主通知信封:一句否认用户输入语义的框架句、一个 XML 包装器,以及携带任务 id、发起工具调用 id、状态、退出码、命令与有界输出尾部的逐任务转义块。投递在崩溃重放之间也变为恰好一次:`notified` 标志只在记录持久化后翻转,覆盖按任务 id 匹配,重放或重新增长的批次永远不会追加或发送已记录完成事件的第二份副本。物化完成事件后紧接着的第一轮失败现在仍会标记失败回合,使恢复/重发不出现连续用户消息。此变更之前记录的会话保留遗留记录且投影不变。
- **权限批准的工具调用不再让转录缺失命令卡(issue #268 第 8 项)。** 权限门把受门控的调用挡在可执行批次之外,因此其 `tool_call` 事件从未触发:批准后转录只显示 `Permission pending: shell_exec.` 行加一条裸 `⎿ exit 0 · …` 脚注,没有 `●` 命令卡。批准执行路径现在为每个解决分支(允许、拒绝、能力消失)发出标准 `tool_call` 事件,使卡片与结果行像非权限回合一样精确配对;拒绝也获得同样的配对。待决通知行还带一行有界的命令摘要(复用卡片头渲染),因此批准框关闭后转录仍可自我描述。无持久记录变更。
- **`/compact` 不再对历史包含持久图像附件的会话失败(issue #281,P1)。** 所有压缩摘要请求现在都在供应商序列化之前把内容寻址的图像引用物化进内存中的请求副本 —— 手动 `/compact`、可选开启的自动压缩、模型切换压缩、`/rewind` 起点摘要,以及可选的远端 Responses 压缩请求。缺失或损坏的附件以显式附件错误保持失败关闭,会话头不变;持久 JSONL 转录继续只存引用形式的附件,从不存 base64。
- **OpenAI Responses 请求不再静默丢弃工具结果图像。** `function_call_output` Item 不能携带媒体,因此附加到工具结果的已接受 MCP/工具图像现在被保留,并在完整工具批次之后作为一条合成的用户输入 Item 冲洗,镜像 OpenAI 兼容 chat 序列化器;未物化的引用仍由标准序列化防护保持失败关闭。
- **发布 close-issues 工作流现在会把它携带的 PR 的关闭声明桥接进 `main`。** 面向 `develop` 的 PR 正文中的关闭关键字不再依赖发布 PR 重复它们:发布合并时,工作流从发布提交范围恢复组成 PR(原生合并与 squash 合并两种形态),以 GitHub 原生内联关键字语义扫描其正文加发布 PR 正文,并为每个仍打开的 issue 关闭并附一条链接发起 PR 与发布 PR 的评论。Rebase 合并的组成 PR 在提交历史中不留下 PR 引用,仍然无法桥接。

## [1.0.0] - 2026-08-31

### 稳定频道与已知限制

- **`1.0.0` 是首个稳定版,发布到 npm 的 `latest` dist-tag:** 发布完成后 `npm install -g prism-vesicle` 即可安装。更早的预发布构建仍可通过 `next` dist-tag 与显式版本号获取。
- **在更早捆绑 Harness 基线下记录的会话不会丢失;它们显式迁移**,走与之前相同的两阶段审查;不会有任何静默重绑定。SubAgent 子会话保持其失败关闭的身份检查。
- **Windows 产物保持有意不签名。** 从官方 GitHub Release 对照 `SHA256SUMS.txt` 校验下载,遵循公开的 Code Signing Policy,不要在系统范围内关闭 Windows 安全功能。

### 变更

- **预发布线的全部四个实验面毕业为已发布。** 可选开启的 MCP 工具输出持久化(`mcpOutputPersistence`,含 `mcpOutputAutoTruncate` 子开关)按设计保持可选;品牌化的 Windows PE、安装器、卸载器与 Explorer 资产按既定 Code Signing Policy 披露保持未签名;宿主状态终端标签标题与持久会话标题在 1.0.0-rc.2 于已安装 Windows 构建上的封闭小组测试之后毕业(工作标记锚点稳定性与标题生命周期)。

### 修复

- **Windows Terminal 工作标题不再水平抖动(Issue #263)。** 工作状态标签标记现在在同块象限方块 `◰`/`◳`/`◲`/`◱`(U+25F0–F3,顺时针)中轮换,它们在 Windows Terminal 标签条中跨帧保持像素稳定的步进,而先前的 `◇`/`◈`/`◆` 菱形脉冲会让后面的标题文本可见地移动。帧集合经针对真实 Windows Terminal 渲染的人工观察探针选定(`scripts/probe/terminal-title-jitter-probe.ts`)。800ms 节奏、空闲 `·` 与需要输入 `!` 标记、`VESICLE_REDUCED_MOTION=1` 静止帧(现为 `◰`)以及 `VESICLE_DISABLE_TERMINAL_TITLE=1` 无写入契约不变。

## [1.0.0-rc.1] - 2026-08-30

### RC 频道与已知限制

- **本发布候选发布到 npm 的 `next` dist-tag;`latest` 继续跟踪 Beta 线。** `npm install -g prism-vesicle` 仍安装 `1.0.0-beta.2`;请用 `npm install -g prism-vesicle@next` 或固定 `1.0.0-rc.1` 显式安装候选。频道策略将在稳定 `1.0.0` 时重新审视。
- **在更早捆绑 Harness 基线下记录的会话不会丢失;它们显式迁移。** 升级后的首次恢复会呈现迁移审查;不会有任何静默重绑定。SubAgent 子会话在此版本中不级联迁移,并保持其失败关闭的身份检查。
- **Windows 产物保持有意不签名。** 从官方 GitHub Release 对照 `SHA256SUMS.txt` 校验下载,遵循公开的 Code Signing Policy,不要在系统范围内关闭 Windows 安全功能。
- **Windows Terminal 工作标题的字形抖动仍是已知后续项。** 工作状态标题在 Windows Terminal 上可能水平抖动;修复由 Issue #263 跟踪并有意推迟到下一个正式发布。

### 新增

- **终端标签标题。** 交互式 TUI 会话经 OpenTUI 渲染器投射宿主状态:`·` 空闲、工作时同宽的 `◇`/`◈`/`◆`/`◈` 菱形脉冲、需要用户输入时 `!`。持久标题直接显示;无标题会话使用净化后的项目基名回退。Setup 使用 `Prism Vesicle Setup`;`VESICLE_REDUCED_MOTION=1` 把工作状态冻结在 `◇`,`VESICLE_DISABLE_TERMINAL_TITLE=1` 保证不写入,`VESICLE_TERMINAL_TITLE=auto|on|off` 控制 TTY 准入。关机、挂起/恢复与外部编辑器返回会清除或重投射标题。

- **持久会话标题。** 经用户级 `settings.yaml`(`sessionTitle: auto|off`),首个完整的普通回合可以通过一个隔离的供应商请求异步生成净化标题。仅宿主可见的标题、重试状态、认领与辅助用量记录不进入模型历史;`/title`、`/title rename <text>` 与 `/title regenerate` 管理标题生命周期。

- **确定性 Windows 品牌资源(A Lane,#251)。** 原生 Windows 构建现在带有多尺寸的规范 Prism Vesicle 图标与版本元数据;Inno Setup 及其向导使用同一 SVG 派生的图标家族,包括生成的卸载器与 Windows 集成表面。WSL 交叉构建仍以显式的非发布文件名提供,因为 Bun 无法在交叉编译时写入 Windows PE 资源。

### 变更

- **捆绑 Harness 推进到公开的 `prism-engine-v10@10.3.3` Pack。** 完整验证的 73 文件清单现在匹配 Neural Narratology Release `harness-20260830-3`,由已接受的 upstream 合并 `d3e17e77f1f875c033ab33e281726b2356c18bd3` 以 `sourceState: clean` 构建。运行时与 Stage HUD 指南现在只允许各自模板要求的回合计数器加张力标量,Dyad State Navigator 成为独立小节。Driver 操作、Engine 与 Agent 清单、所需能力、绑定、Adapter `1.2.0` 与 `protocolVersion` 不变。在 `10.3.2` 下记录的会话经既有的显式迁移流程恢复。

### 修复

- **Windows 本地构建在产生损坏的独立 Worker 路径之前拒绝 UNC 工作区。** 从 `\\wsl.localhost` 或其它 UNC 检出运行原生 Windows Bun 会把次级编译入口重定位到 Bun 正常虚拟根之外,而运行时仍指向 `B:/~BUN/root/tree-sitter-worker.js`。`build:exe windows` 与安装器构建现在在编译之前以可操作的盘符工作区要求失败;正常的原生 Windows CI 与显式的非发布 WSL 交叉构建不变。

- **会话标题生成保持项目与配置所有权稳定。** 辅助请求现在从显式的宿主环境输入解析 `settings.yaml`,而不是重读可变的进程全局测试状态,活动取消所有权按项目根加会话 id 作为键。在另一个项目中重置同名会话不再能中止错误的请求,过期的已取消请求也不能分离替换它的控制器。

- **内置命令参数补全现在覆盖近期的命令面。** `/websearch`、`/title`、`/init`、`/workspace` 与 `/skill --context-only` 续接现在经共享的 ↑/↓/Tab/Enter 弹出窗口暴露其有限或有护栏的运行时候选。每个内置命令显式声明是否拥有补全,防止新命令静默遗漏该契约。

- **Windows 系统表面现在使用全尺寸的规范 ICO。** 安装器把 `prism-vesicle.ico` 放在 `vesicle.exe` 旁边,并让 Apps & Features、开始菜单与 Explorer 集成指向该多尺寸文件,防止 Windows 设置把低分辨率的可执行文件帧放大成模糊图标。

- **Windows 资产覆盖层与受护栏路径诊断现在匹配跨平台契约。** 当 Windows 把被尝试的子查找报告为 `ENOENT` 而不是 POSIX `ENOTDIR` 时,项目或用户资产文件现在仍会遮蔽较低层的后代,因此直接读取与合并列表不会不一致。模型可见文件工具也在既有的项目边界防护之前,经平台路径 API 对有根 Windows 路径与根相对路径分类。
- **并发的 Skill 状态写入保持跨进程互斥,不再需要发布后的 SQLite 提交。** 报告的 Windows 锁失败被追溯到跨 `await` 变得不可达的测试持有者;Bun 随后执行其文档化的垃圾回收关闭并释放了 SQLite 事务。Skill Store 索引更新与文件系统范围的启用/禁用更新现在共享一个异步的 10 秒 SQLite 互斥所有者,它在整个临界区内保持其 `Database` 存活,并总是以 `ROLLBACK` 加显式关闭释放;这把禁用状态此前同步的 5 秒等待替换为共享的 10 秒预算。SQLite 不承载 Skill 数据,因此成功的原子 `index.json` 或 `.disabled` 更新不再可能被随后的 `COMMIT` 误报为失败,锁竞争也不再以同步睡眠阻塞 TUI 事件循环。

## [1.0.0-beta.2] - 2026-08-24

### 预发布频道与已知限制

- **npm 的 `latest` dist-tag 有意推进到本 Beta。** Beta 阶段中,`npm install -g prism-vesicle` 安装 `1.0.0-beta.2`;请固定显式的旧版本以继续停留在 Alpha 构建。频道策略将在 RC 或稳定 `1.0.0` 发布前重新考虑。
- **在 `1.0.0-beta.1` 下记录的会话不会丢失;它们显式迁移。** 升级后的首次恢复呈现下述迁移审查;不会有任何静默重绑定。SubAgent 子会话在此版本中不级联迁移,并保持其失败关闭的身份检查。
- **Windows 产物保持有意不签名。** 从官方 GitHub Release 对照 `SHA256SUMS.txt` 校验下载,遵循公开的 Code Signing Policy,不要在系统范围内关闭 Windows 安全功能。

### 新增

- **会话跨捆绑 Harness 升级显式迁移。** 恢复在不同已验证 Harness 基线下记录的会话(包括无身份的前 V10 会话)不再死锁在失败关闭的身份检查上。先运行离线预检报告 —— 新基线下的恢复演练、经会话自身序列化器的供应商请求体往返、逐协议工具调用配对校验器,以及上下文预算启发式;从不发送供应商请求。迁移本身在两阶段红色面板确认后进行:确认会把迁移前转录归档到 `.vesicle/sessions/archive/`,并追加一条持久的 `session-migration` 记录,重绑定会话的有效身份,同时每条历史记录保持其记录时的身份。之后的恢复重新显示持久迁移通知,而不是静默切换运行时契约。阻断性发现(新基线下未知 Engine、无法解决的暂停门、序列化器或不变量失败)拒绝迁移且会话保持原样。待处理的质量重试跨身份漂移保持失败关闭,SubAgent 子会话不被迁移(#239)。

### 修复

- **捆绑 Harness 补全了宿主提示已经声明的组合变更面。** `prism-engine-v10` 基线移至 `10.3.0-alpha.2`:六个非 Stage Engine 与三个工作流 Agent(Scene Writer、Continuity Editor、Chapter Reviewer)的模型可见工具面现在真正获得 `delete_file`、`move_file`、`move_directory` 与 `delete_directory`;此前基础提示承诺这些工具,却没有一个 Engine profile 声明它们(#238)。这些工具保持既有的 `mutate` 权限类别,因此 INERTIA 与 MANUAL 模式在任何删除或移动前仍会询问。新基线记录新的 Harness 身份;在 `10.3.0-alpha.1` 下记录的会话经上述显式迁移流程恢复(#239)。

- **恢复的会话把合成进程结果保持在发出它的回合旁边。** 当 Vesicle 在已批准的宿主进程启动之后、其完成被记录之前停止时,恢复会合成一个结果不确定失败的工具结果,使该调用不会被重放。该合成物此前被追加到投射历史的末尾,因此崩溃后继续聊天的会话重投射成 Anthropic 与 OpenAI Chat 协议都拒绝的形态(assistant `tool_use`/`tool_calls` 后跟非工具消息)。合成物现在直接拼接在其声明的 assistant 回合之后,匹配被中断工具合成已遵循的相邻性契约;此类会话的历史再次干净地序列化,会话迁移预检不再把它们困在阻断性不变量发现上(#242)。

- **恢复的 Gemini 会话再次重放思考签名。** Gemini 的供应商原生部件 —— 思考文本与携带其 `thoughtSignature` 的函数调用 —— 随每个回合持久化,却在会话重载时被静默丢弃,因为持久化过滤器的已知类型列表早于 Gemini 块类型。思考签名重放因此只在单次运行内有效;恢复的会话退化为纯文本加重建的工具调用,而这正是 Gemini 严格函数调用校验拒绝的形态。重载路径(历史投射、质量恢复与失败关闭的压缩检查点解析器)现在共享一个接受 Gemini 部分类型的严格块形态防护,因此恢复的会话与其延续的实时回合字节一致地序列化(#243)。

- **启动恢复不再在 Harness 迁移后丢失 Chat 渲染表面。** 当 `-r` 恢复在较旧 Harness 下记录的会话时,迁移审查临时替换空会话 Hero,然后重新进入恢复。转录滚动框在该过渡期间可能被销毁并作为空白可渲染对象复用,使恢复的元数据与后续供应商回复只在状态中可见。Chat 转录现在拥有一个持续挂载的滚动框,并在不分离它的情况下更改 Hero 布局,因此迁移后的历史与后续消息保持可渲染。

### 变更

- **仓库落地页头部现在使用紧凑的透明品牌标记。** 英文与中文 README 页面把居中的方形 Hero 替换为标题旁右对齐的小标记,并以块引用引出项目定位。完整的深色与浅色背景发光标记仍是大格式品牌资产;新的衍生品在两个中性文档主题上都保留了囊泡、棱镜、入射光束与克制的光谱,且没有容器底块。

## [1.0.0-beta.1] - 2026-08-20

### 预发布频道与已知限制

- **npm 的 `latest` dist-tag 有意推进到本 Beta。** Beta 阶段中,`npm install -g prism-vesicle` 安装 `1.0.0-beta.1`;请固定显式的旧版本以继续停留在 Alpha 构建。频道策略将在 RC 或稳定 `1.0.0` 发布前重新考虑。
- **供应商原生搜索保持显式且受供应商范围限制。** `/websearch on` 将搜索查询发送到所选供应商,没有逐次工具批准。它只在模型声明 `capabilities.builtinWebSearch` 且活动协议/Profile 准许时受支持:Gemini `generateContent`、OpenAI Responses `openai-public` 与 `deepseek-subset-2026-08-19`。引用是可选的供应商行为。`deepseek-subset-2026-07-31` 上的既有 DeepSeek 配置不会自动改写,在刻意更改 Profile 前保持搜索禁用。OpenAI、DeepSeek、Gemini 图像续写/搜索与 Tavily 路径有 2026-08-20 的 dogfood 证据;可选开启的真实端点套件在凭据或端点缺失时报告不可用,绝不计为通过。
- **Windows 产物保持有意不签名。** 从官方 GitHub Release 对照 `SHA256SUMS.txt` 校验下载,遵循公开的 Code Signing Policy,不要在系统范围内关闭 Windows 安全功能。
- **MCP 非图像富结果仍延后。** resource、audio、URL/link 与未知的 MCP 结果类型被省略,不自动抓取也不注入提示;Issue #177 跟踪该项独立工作。

### 新增

- **Gemini `generateContent` 上的内置 Web 搜索。** 最后一片 #225 切片在 `/websearch` 激活时声明 Gemini 独立的 `{googleSearch:{}}` 条目;它与函数声明共存而不是替换它们。缓冲与流式的 `groundingMetadata` 现在把已执行的 `webSearchQueries` / `webSupportQueries` 联合与可选的 Web URI/标题引用规范化为 `WebSearchReport`。Gemini grounding 永不重放进后续请求,因为该协议没有对应的重放 Item。可选开启的真实供应商车道钉住 Google Search + 函数声明的组合请求,并要求非空的查询审计报告。

- **OpenAI Responses 协议上的内置 Web 搜索(`openai-public` + 新的带日期 `deepseek-subset-2026-08-19`)。** 统一供应商原生 Web 搜索的第二片(#225)。当 `/websearch` 开关(或 `webSearchDefault`)生效时,这些 Profile 声明裸 `{type: "web_search"}` 工具 —— OpenAI 与 DeepSeek 共享的线路子集 —— 准入 `web_search_call` 输出 Item 与三个 `response.web_search_call.*` 流事件,并把它们规范化进会话的 `WebSearchReport`:以执行的查询作为审计底线(DeepSeek 的 `ws_call_id=…` 传输伪影被过滤),可选的 `url_citation` 批注作为引用,四字段调用记录作为重放载体。可移植重放只在准许搜索的 Profile 下于后续回合重发调用 Item;codex 指纹 Profile 与冻结的 MiMo/DeepSeek 子集保持失败关闭(那里的搜索 Item 或事件是畸形响应,声明永不发送)。带日期的 `deepseek-subset-2026-08-19` 复制 `2026-07-31` 的全部约束,加上官方端点上观察到的两个准入事实:DeepSeek 的搜索模式向明文推理 Item 附加一个不透明的 `encrypted_content` 令牌(仅在此处容忍),引导 Setup 的 DeepSeek 预设现在写入较新的 Profile,而既有配置保持原样直到被更改。两个目标的真实端点验收于 2026-08-20 通过(DeepSeek 搜索 + 重放;OpenAI 搜索 + 重放;引用是可选的模型行为)。

- **内置 Web 搜索地基:`/websearch`、模型能力与会话记录。** 统一供应商原生 Web 搜索的第一片(#225)。模型条目获得 `capabilities.builtinWebSearch`(支持)与顶层 `webSearchDefault`(会话默认,省略时关闭;该偏好绝不会启用没有该能力的模型)。新的 `/websearch [on|off]` 命令显示状态并按会话切换(像 `/theme` 一样进程范围:`/new` 或恢复会话会回到模型默认),并带启用披露(每次 `/websearch on` 都显示):搜索在供应商侧执行、查询随请求离开、不适用逐次批准。服务器侧搜索 grounding 现在是消息/响应上一等公民的规范化 `WebSearchReport`(永远不是工具调用;权限模式不治理它),并持久化进 assistant 会话记录,带宽容的恢复投射。开关开启期间,宿主 `web_search`(Tavily)工具从工具面移除以避免两条竞争的搜索路径,而没有 `TAVILY_API_KEY` 时整个 Tavily 工具家族被隐藏,而不是作为保证失败的调用提供。`PRIVACY.md` 与双语用户手册记录了查询披露与两个新配置字段。

### 修复

- **带图像与并行调用的 Gemini 原生工具结果不再以 HTTP 400 失败。** `generateContent` 历史序列化器可能把 `functionResponse`、图像通知与图像 `inlineData` 放进同一个 `user` Content,而一次发布审查的改动可能把并行工具响应拆分进不同的 Content。Gemini/Vertex 拒绝这两种重放形态:工具返回图像时普通 MCP 工作流损坏,并行函数调用回合失败,因为其响应批次不再为每个 `functionCall` 包含一个 `functionResponse`。`user` Content 现在严格地要么只含 `functionResponse`、要么只含普通多模态;来自一个模型回合的连续响应保留在一个批次中,工具结果图像作为后续独立的 `user` Content 重放,工具回合之后的普通用户消息序列化为自己的 Content。既有会话无需迁移即可经新形态重放。由序列化器回归覆盖,并针对 Gemini `generateContent` 端点以真实供应商流式验收验证。

- **Markdown 反斜杠转义不再按字面渲染。** `\~`、`\*` 与其它 CommonMark 转义此前在 Chat 与 Workspace 的 Markdown 预览中显示可见的反斜杠和转义样式。缺陷在 upstream(OpenTUI 高亮查询;已作为 anomalyco/opentui#1369 报告并有 PR #1370),并在本发布采用的自维护 OpenTUI fork 运行时的解析器 worker 中原生修复,因此每个分发渠道在 tree-sitter markdown 表面上都把 `\X` 渲染为 `X`(Chat 消息、Workspace Markdown 预览、旁路提问)。纯文本模式与产物卡预览经本发布的伴随预处理改动解码转义。渲染帧组件测试与 `vesicle debug markdown-runtime` 的 `escape` 探针在每个分发边界守护该行为。

- **Markdown 预处理遵循反斜杠转义。** 被转义的定界符不再触发布式扩展:CommonMark 引用习惯 `\[1\]` 与 `\(1\)` 不再渲染成假的 LaTeX 显示数学(`⟦ 1 ⟧`),而 `\~5~`、`\^2^`、`\==m==`、`\![img](…)`、`\[^1]`、`\:rocket:`、`\<kbd>…\</kbd>` 都原样传给渲染器。未转义的数学(`$x^2$`、`\[x^2\]`)与原生写法(`H~2~O`、`x\\~5~`)不变。纯文本渲染路径(`VESICLE_MARKDOWN_RENDERER=plain` 与产物预览)防护其标记剥离,并把剩余转义作为最后一步解码:`\~` 显示为 `~`,`\*x\*` 保留星号而不是丢失,`\#`/`\>`/`\-` 行标记正常显示,`\\` 解码为单个反斜杠。两个相邻的修正随之落地:行内代码区间的内容在纯文本路径中现在是字面的(`` `**b**` `` 保留星号;代码区间从来没有转义语义),产物预览不再在围栏块内部剥离标记 —— 围栏代码在那里现在原样阅读,与纯文本渲染器一致。

### 新增

- **`vesicle config add-mcp`。** 从 JSON 条目向 `mcp.yaml` 添加 MCP 服务器,无需手工编辑 YAML。该命令永不接受机密值:`auth: bearer` 或 `auth: custom-header` 会在 `mcp.yaml` 写入 `${ENV_VAR}` 引用并创建对应的空 `.env` 槽位由用户填写;显式 `headers` 条目必须使用精确的 `${NAME}` 引用(回退/默认形式被拒绝)。条目可声明完整的当前服务器形状(`enabled`、`timeoutSeconds`、`protocolVersion`、`toolPrefix`、`negotiation`、`supportedProtocolVersions`、`includeTools`、`excludeTools`、`enabledEngines`),名称被净化成唯一 id,显式重复的 id 被拒绝。既有文件按保留行的方式编辑(注释、顺序与未触碰的服务器行存活),添加服务器会把顶层 `enabled: false` 翻转为 `true`,且精确输出在原子写入前被重新解析。
- **`vesicle config remove-mcp`。** 经保留行的块编辑移除一个 MCP 服务器,保留周围的注释、顺序、未触碰的服务器行与 `${ENV}` 头引用。移除最后一个已配置的服务器会整体删除 `mcp.yaml`(与“MCP 未配置”相同的运行时状态),并保留兄弟 `.env` 槽位不动。输出在原子写入前被重新解析,未知 id 或缺失的 `${ENV}` 引用会失败且不更改文件。

### 变更

- **供应商/模型注册表 CLI 编辑保留来源上下文(#232)。** `vesicle config add-model`、`add-provider`、供应商/默认 `set`、`remove-model` 与 `remove-provider` 现在对 `providers.yaml` 执行经过验证的原子保留行编辑:注释、空行、顺序与无关字段存活,同时输出被规范化为 LF。有歧义的重复顶层小节、默认字段、供应商字段与 `models:` 块被拒绝,因此命令不可能在编辑了被遮蔽的值之后报告成功。引导 Setup 保留其既有的整注册表合并与规范化语义。

- **TUI 编辑器运行时迁移到自维护的 OpenTUI fork。** Vesicle 现在运行于 `@3akhp/opentui-core@0.5.3-zv6` 与 `@3akhp/opentui-solid@0.5.3-zv6`(upstream v0.5.3 基础加 Vesicle 补丁队列;来源见 fork 的 GitHub Release `v0.5.3-zv6`)。该 fork 原生携带 Markdown 与表格选择颜色,完全退役 0.4.3 依赖补丁,并在能解析 fork 构建原生库的平台(Linux 与 Windows)上修复两个长期的 Workspace 编辑器缺陷:编辑软换行行的中间不再留下陈旧的换行分段(#89),跨宽 CJK 字形的垂直光标移动总是落在合法的字符边界上(#99)。macOS 终端在 upstream darwin 原生库之上解析该 fork 的 JavaScript 修复,在那两个原生缺陷上保持现状直到 upstream 提供等价修复(已在 fork 发布说明中披露,不是平台收窄)。`vesicle debug markdown-runtime` 额外经 fork 自己的加载器强制原生库加载,并用 `source` 字段报告解析到的资产,区分已安装包的资产表报告与只能证明强制加载的渠道(npm 捆绑安装、编译二进制)。

### 修复

- **公开手册再次从初学者任务出发覆盖完整的 beta.1 用户面。** 双语任务路线与可执行演练现在覆盖供应商原生对比 Tavily 搜索、视觉附件、每个捆绑 Engine、`vesicle-docs`、SubAgent、Harness Pack、终端命令、自动压缩与质量决策恢复,并带先决条件、成功反馈与失败路径。Windows 优先教程不再以仅 Bash 的 heredoc 开头,中文 README 不再错误声称草稿区 `tmp/` 的更改是回退安全的。

- **发布审查的后续关闭搜索边界与持久性缺口。** 供应商原生内置搜索现在要求准许的协议/Profile 与一个声明工具面包含 `web_search` 的 Engine;Stage 与无工具的 `/btw` 旁路通道永不接收它,SubAgent 继承父级的有效搜索策略,而不同时暴露 Tavily `web_search`。被拒绝的 `/websearch` 更改不再报告成功。规范化的搜索审计数据现在在子会话、质量决策/重写恢复与可移植压缩检查点中存活。关闭 DeepSeek 搜索会把已搜索的原生批次降级为其可移植 assistant 投影,而不是重放与搜索耦合的推理状态。Gemini 把并行函数响应保留在一个响应批次中,并在后续独立的 Content 中发出任何工具结果图像。

- **发布 Issue 的关闭被限制为显式发布意图。** `main` 关闭工作流现在只对已合并的 `release/*` PR 运行,只读取 PR 正文中独立的关闭关键字行,忽略提交历史与评审文本中的 `Should-fix #N`,并使用 Node 24 的 `actions/github-script` 运行时。

## [1.0.0-alpha.10] - 2026-08-14

### 新增

- **任意深度的候选树:`/branch` 与 `Ctrl+B`。** 候选切换不再限于最后一回合。新的 `/branch` 命令(两页上都可以 `Ctrl+B`)打开候选树面板,渲染每个深度上的每个分支 —— 包括非活动候选内部的分支 —— 带树形导航(`↑/↓` 移动、`←/→` 折叠/展开)、行内摘录、逐候选的文件状态提示(`files` / `no file state` / `files degraded`)与延续计数。在候选上按 `Enter` 打开带只读文件预览(变更文件、`+/-` 行数、污染与缺失捆绑警告)的确认步骤,然后同时切换对话与磁盘;在分支行上按 `r` 重生成该回合。切换经共享的候选切换内核执行:文件先于选择标记移动,标记按目标叶子所属的回合为其分支点建档,因此行内 `< n/m >` 切换器在切换到的深度重新武装,同样的繁忙/SubAgent 防护适用。面板遵循 `/rewind` 底部表面模态模式,在确认步骤之前绝不触碰磁盘。

- **全清单的候选文件捆绑。** `candidate-file-state` 捆绑现在是项目内容根下磁盘上所有内容的版本 2 全清单(内容寻址、去重),取代只覆盖分支回合台账跟踪路径的部分捕获。切换到候选使磁盘严格等于其清单:条目恢复,清单之外的磁盘路径被删除,符号链接与特殊文件豁免(记录为 `untracked` 并在切换结果中呈现),而草稿根 `tmp/` 照旧留在清单之外。捕获不再从分支回合的检查点台账推导其域(台账仍锚定捕获的可信度),只读切换预览与切换本身共享精确的删除/恢复计算。

- **`Alt+↑/↓` 上的统一回合焦点光标。** `Alt+↑/↓` 现在在每个转录上移动回合级焦点光标,而不只是 Stage 引擎消息:它停靠在每个创作回合的提示与最终回复上,在边缘回绕,以品牌色高亮两条消息并滚动进视野。光标设定后,`Ctrl+R` 重生成聚焦的回合而不是最后一回合。Stage 行为保留:聚焦回合的合格 Stage 消息仍是 `Ctrl+Alt+S` 与鼠标切换的目标。行内切换器武装时 `Alt+←/→` 仍循环候选;否则现在报告指引(聚焦回合有候选时 `Ctrl+B` 打开候选树,否则 `Ctrl+R` 重生成)而不是被静默吞掉 —— 包括在 Workspace 页与 Hero 上,修复了长期的死键缺陷。

- **Chat 上经 `Ctrl+R` 的水平候选分支。** 一个回合现在可以在保留旧回复的同时作为新候选重跑,且候选可以就地切换。`Ctrl+R` 重跑最后一回合(或 `Alt+↑/↓` 光标设定时的聚焦回合)—— 整个回合,因此在仅聊天的 Stage 引擎上是一次模型调用,而写文件的创作 Engine 重跑完整工作流 —— 并在共享用户记录之后追加兄弟候选子树;旧候选保留在只追加转录中,但从屏幕清除,让新候选在其位置流入,匹配重生成语义。页面范围的绑定不影响 Workspace 既有的 `Ctrl+R` 文件重载,并使用 Windows、macOS 与 Linux 上传统 VT 终端都可用的控制序列。重生成后,回复下方出现行内 `< n/m >` 标记,`Option+←/→` 切换活动候选(以及后续回合构建所依赖的上下文)而不再调用模型;重生成与切换键有修饰键门控,因此输入框中的普通输入永不冲突。候选选择跨重载持久。文件状态随候选切换:离开候选会把它在磁盘上的后状态捕获进只追加的 `candidate-file-state` 捆绑并链到其内容叶子(一旦记录永不重新捕获,因此重试的恢复不能把半恢复的磁盘误当作候选的真实状态),重生成在新候选运行前恢复分支基线 —— 每个候选回合前检查点状态的首选合并 —— 使它从分支回合实际看到的文件开始,而 `Option+←/→` 在重指选择标记之前恢复目标候选的捆绑文件(文件先动,因为恢复可重试而标记是一次性翻转)。失败或被中断的重生成把标记重指到旧候选并尽力而为地恢复其捆绑文件,把失败候选留在磁盘上的内容捕获为该候选的捆绑。注意事项:在该特性之前创建且从未离开过的候选没有捆绑,仅切换对话 —— 这样的切换记录降级标记,因此错误的文件状态永远不会在之后被冻结为该候选的捆绑,而对无捆绑候选(降级或无台账的分支回合)的重生成完全不移动文件;宿主进程写入(`shell_exec` / `run_skill_script`,在切换时呈现为污染警告)与草稿根 `tmp/` 如 `/rewind` 一样在权威恢复保证之外;Stage 不受影响(它不写文件);后台 SubAgent 运行或排队时拒绝候选切换。旧候选永不删除或垃圾回收,因此会话文件随使用增长(已在双语用户手册中记录)。

- **捆绑的 `update-config` Skill 与 `vesicle config` CLI 面。** 新的第一方 Skill 经过验证的原子 CLI 操作引导配置更改:检查净化后的配置状态(`show`),修改 providers/permissions/preferences/quality/settings(`set`、`add-provider`),管理非机密的 `.env` 结构(`env-set-empty`、`env-set-proxy`、`env-remove`),并校验全部配置文件(`validate`)。供应商管理面现在还支持逐字段编辑(`set providers providers.<id>.<field> <value>`,用于 `protocol`、`baseUrl`、`apiKeyEnv`、`authMethod`、`responsesProfile`、`responsesTransport`、`userAgent` 与 `defaultModel`)、追加模型(`add-model <id> --json`)、移除模型(`remove-model <id> <model>`)、移除供应商(`remove-provider <id>`)、取消偏好/设置(`unset <file> <key>`),并在 `.env` 移除缺失的键时警告。结构/供应商标识字段(`id`、`models`、`apiKey`)被拒绝,每次注册表写入都在原子重命名之前经重新解析序列化输出预验证,因此失败的跨字段约束不会留下损坏的文件。机密值在结构上被排除 —— `.env` 读取经白名单净化为 `<set>`/`<empty>` 标记并掩码代理凭据,且没有任何操作接受机密值作为参数;该 Skill 的 `SKILL.md` 指示模型引导用户为 API key 手工编辑 `.env`,并在凭据被粘贴进对话时警告(不回显、不存储、不使用)。两个薄 `.sh`/`.ps1` 包装器经既有的自调用契约重新调用确切的 Vesicle 运行时,遵循 `skillify` 模式。新的 `VESICLE_HOST_CONFIG_DIR` 环境变量与 `VESICLE_SELF_EXECUTABLE`/`VESICLE_SELF_ENTRYPOINT` 一起注入 `run_skill_script` 子进程,因此捆绑脚本无需重新推导平台路径即可解析用户级配置目录。

### 变更

- **候选文件切换现在是权威的,版本 1 捆绑被拒绝(破坏性)。** 因为全清单对内容根下的所有内容拍快照,候选活动期间进行的手工编辑与 MCP 工具写入会在该候选被离开时捕获,并在切换时像任何其它文件一样被删除或恢复 —— 不再不受切换影响地存活。宿主进程污染警告、符号链接豁免与草稿 `tmp/` 豁免不变。此变更之前记录的捆绑(无 `version` 字段)在解析时被拒绝:切换到这样的候选降级为仅对话并带状态栏通知,记录降级标记,与无捆绑候选一致。这是无迁移路径的 Alpha 阶段破坏性变更。

- **`Ctrl+B` 现在是全局候选树快捷键,取代输入框的 Emacs backward-char。** 该绑定位于与 `Ctrl+O` 页面切换相同的路由层 —— 在底部表面模态之后(打开的面板保留其按键)、在 Workspace 路由之上(两页都响应)—— 并使用 Windows、macOS 与 Linux 上传统 VT 终端可用的普通 `0x02` 控制字节。输入框中裸 `←` 的光标移动与 `Meta+b` 的单词移动不受影响。

### 修复

- **候选切换不再丢失恢复之后所做的编辑。** 第一次全清单迭代无条件复用候选的既有捆绑,因此恢复的候选活动期间所做手工编辑在该候选被离开并随后恢复时被丢弃。捕获资格现在跟随叶子的最新文件事件:成功的恢复追加 `candidate-file-restored` 标记,重建磁盘权威并让下一次离开捕获替代捆绑,而仍是最新事件的捆绑保持其可重试复用。失败的清单应用把两个受影响的叶子都标记为降级(半恢复的磁盘不属于任何一方);降级阻塞捕获但永不阻塞恢复,之后成功的恢复会复活重新捕获。

- **`Alt+←/→` 的拒绝指引现在在每个宽度都可见。** 宿主侧栏把状态行截断为一窄行并在 80 列完全隐藏,因此快捷键指引被切断或不可见。措辞以可操作的快捷键开头,指引还作为转录通知投递(连续的相同通知对按键轰炸去重)。

- **`deepseek-subset-2026-07-31` 现在准入 `deepseek-v4-pro`(#151)。** DeepSeek 官方 Responses 端点现在同时服务 `deepseek-v4-flash` 与 `deepseek-v4-pro`,v4 Pro 车道于 2026-08-13 通过对 `api.deepseek.com` 的独立验收(明文推理、精确 `call_id` 函数循环、用量/终止/错误语义;`2` 通过、`0` 失败)。三个失败关闭的准入守卫(注册表加载、引导 Setup、适配器网络前检查)、一致性夹具、双语供应商参考、开发者契约与示例注册表现在接受文档化的配对,同时继续拒绝其它所有模型;没有解锁新能力(WebSocket、`previous_response_id`、Conversations、storage、background、远端压缩),DeepSeek 服务端内置的 `web_search` 工具仍明确超出范围(#209)。示例注册表中 `deepseek-responses` 的 `baseUrl` 更正为 `https://api.deepseek.com/v1`,即官方端点实际服务的路径。

- **捆绑 Harness 更新到 `prism-engine-v10@10.2.1`(Vesicle 侧零变更)。** 已验证的 73 文件基线(Neural Narratology Release `harness-20260812-1`,提交 `979e0771`)新增变换指令(大纲可选的章级字段加场景分配变换列;独立的 Weaver Phase 1/2 读取并自检它,编排的 Weaver-Orch 写入场景计划由 Scene Writer 履行,Chapter Reviewer 维度 3 审计落地)、语域调制(场景分配上的语域列 —— 日常/悬疑/对峙/动作/序章/余韵 —— 每个语域附注对话设计原则)、Weaver 与 Scene Writer 的四个新场景技法(一动作干三件事 / 声音动作先于身份 / 间接出场 / 叙述者声音按张力调节),以及把物理正典自检前移,在 Weaver Phase 2、Scene Writer 第 5 步与 Chapter Reviewer 维度 4 之间复用角色卡的 Visual Cortex。Agent、绑定、能力、`protocolVersion`(`v10.1-prompt-assembly`)、`vesicle-v1@1.1.0` 宿主 Adapter(字节一致)、Driver Contract(仅刷新其 `version` 字段;操作、资源、Agent、Engine 均未变)与反 AI 味规则包(0.4.0,32 条规则;检测器/评审规则数据不变,评审规则仍为 23)全部不变,因此这是无 Vesicle 源码变更的纯内容基线升级。73 文件清单不变(9 个文件修订、0 新增、0 移除);静态提示资产台账在 upstream 重新计算,仍远低于 24000 字符的静态预算。经 `vesicle assets verify`(`compatible=true`)、完整确定性套件与 `vesicle doctor` 验证。

- **捆绑 Harness 更新到 `prism-engine-v10@10.3.0-alpha.1`(取代上面的 10.2.1 基线)。** 该 Pack 从每个 Engine Profile 与 Driver Adapter 工具组退役重叠的 `list_files` 模型可见面,改为采用随文件工具冷启动修复交付的统一 `list_directory` 契约(#205、#206),并把 manifest 来源钉到已合并的 Neural Narratology 源提交 `a833a220`(#208)。`protocolVersion`(`v10.1-prompt-assembly`)、Driver Contract 的操作与资源、宿主 Adapter 与反 AI 味规则包(0.4.0,32 条规则)其余不变。

- **OpenAI Responses `openai-public` 真实供应商门记录为通过。** 2026-08-11,官方 `api.openai.com` 端点以 `gpt-5.6-luna` 通过完整的 `openai-public` 验收套件(`3` 通过、`0` 失败):带精确 `call_id` 重放与无状态原生 Item 的 HTTP/SSE 函数循环、一次非流 JSON 往返、返回恰好一个加密压缩 Item 的独立 `/responses/compact`,以及公共 WebSocket 续接工具循环(WebSocket 测试覆写 `fetch` 以令任何静默 HTTP 降级失败,因此通过确认了真实 WebSocket 使用)。这完成了四片门并取代较早的部分网关证据 —— 可信的 `doro-gpt` 中继曾通过 HTTP/SSE 与一次非流请求,但其独立压缩返回 HTTP 503,其 WebSocket 探测也失败。`STATUS.md`、`docs/dev/OPENAI_RESPONSES_CONFORMANCE.md` 与双语供应商参考现在把该门记为通过;协议在 1.0.0-alpha.9 快照中仍为 `experimental`,随 1.0.0-alpha.10 毕业为 `released`。无源码变更 —— `ResponsesProfile` 类型不携带 experimental/tier 标志,适配器已实现全部四片。

- **`codex-beta-2026-02-06` 提升为有文档的一等、传输无关 Profile。** 此前被描述为“冻结指纹夹具”并锁定 WebSocket,它现在镜像 Codex 自己的传输策略:`responsesTransport: websocket` 时发送 Codex 的 V2 beta 线路形态(`openai-beta: responses_websockets=2026-02-06` 头加 `stream: true`),并在 WebSocket 耗尽时像 Codex 一样回退到 HTTPS/SSE;`responsesTransport: http` 时使用标准公共的 HTTPS/SSE 形态。Codex V2 指纹只在 WebSocket 路径上应用;强制该 Profile 使用 `responsesTransport: websocket` 的配置门已移除。钉住的头部值与 `ResponsesApiRequest` 字段集在一致性钉住的 Codex 提交 `8f00b9a0` 与当前 `main`(`a9dee37f`,领先 421 个提交)之间不变,因此指纹是最新的。记录于双语用户手册与 `docs/examples/providers.yaml`,由 `vesicle doctor` 重新标注,并由新的可选验收车道 `test:acceptance:responses:codex-beta` 覆盖(2026-08-11 以 `gpt-5.6-luna` 对 `api.openai.com` 通过)。

- **文件工具冷启动与目录查询一致性(#205、#206)。** 有文件能力的 Engine 回合与全新/摘要 SubAgent 现在接收有界的逻辑项目状态快照,而 `list_directory({ path: "." })` 暴露一个安全的虚拟根用于显式发现,不泄露 `.vesicle/`、包文件或其它宿主基础设施。项目状态是活动的宿主提示上下文,而非会话身份或对话历史:进程内暂停复用冻结的回合快照,而重启与新的顶层回合重新观察。读工具的 schema 派生并枚举规范根,项目根持久指令自我标识为宿主管理,被选中的指令信封明确说明其内容已加载。`stat_path` 把允许的缺失路径报告为结构化的 `not_found`;`list_directory` 现在对项目根与分层的 `assets/` 使用一个结构化的 `full`/`names` 契约,报告文件/目录/其它计数使真正的空目录在轻量模式下仍可区分,遵循文件对目录的覆盖遮蔽,并同时对条目数与遍历设界。重叠的模型可见 `list_files` 面从 Alpha 契约退役;新的 Neural Narratology `prism-engine-v10@10.3.0-alpha.1` Harness Pack 只暴露统一工具。

- **`codex-http-relay` 接受从终止输出剥离可选字段的中继。** 一些服务 Codex 的中继(例如可信的 `doro-gpt` 网关)返回的 `response.completed` 的 `output` Item 省略 `response.output_item.done` 流仍携带的可选或空字段 —— Item 信封的 `id`/`status`/`phase` 与内容部件的 `annotations`/`logprobs`。严格的深相等终止/Item 调和把它当作不匹配拒绝并失败关闭,破坏了该中继。`reconcileRelayTerminal` 现在在终止项是完成 Item 流的递归子集(相同语义载荷、更少可选字段)时接受它,并保留更完整的 `output_item.done` Item 用于重放;真正的载荷不匹配(不同的文本、`call_id`、Item 类型、长度等)仍失败关闭。对 `doro-gpt`(`gpt-5.6-luna`)的中继验收再次变绿。

- **`codex-http-relay` 不再发送 `service_tier`,恢复与拒绝它的中继的兼容。** 该 Profile 此前在每个请求上发送 `service_tier: "auto"`;`sssai` 等中继以 HTTP 400 拒绝每一个 OpenAI tier 值(`auto`/`low`/`medium`)。`codex-http-relay` —— 最大兼容 tier —— 现在省略 `service_tier` 使此类中继可用,而 `openai-public` 保留显式的 `"auto"`。经对 `sssai`(`gpt-5.6-sol`)的中继验收验证;`doro-gpt` 与 `buzz` 容忍该省略。

- **Skill 脚本执行不再依赖自由格式的 Shell 门。** `run_skill_script` 现在使用自己的 `skill_exec` 权限类别,并对每个有非空 Skill 目录的非 Stage 会话可用,即使 `permissions.yaml` 保持 `shellExec: false`。MANUAL 与 INERTIA 仍在执行前询问;默认的 MOMENTUM 与进程范围的 YOLO 遵循其正常的自动允许行为。所选脚本仍是固定的、可检查的 Skill 资源,其目录钉住的内容哈希在执行前立即复查,并保留结构化 argv 加既有的进程运行时环境过滤、超时、输出上限、取消、进程树清理与宿主进程检查点污染。解释器缺失或资源漂移仍清晰地失败而不执行。`shell_exec` 仍单独可选开启并保留其 `arbitrary_exec` 批准路径。以 `arbitrary_exec` 记录的遗留待处理 `run_skill_script` 批准在恢复时迁移。这恢复了预期的开箱 `skillify` 验证/发布流程,而没有启用通用 Shell。

- **权限续接再次可取消,繁忙模式的 `Esc` 可中断。** 在工具权限提示上选择 Allow/Reject 之后,续接在恢复之前重建其上下文 —— 包括 MCP 重连与 `tools/list` —— 而该重建忽略了回合的取消信号:MCP 服务器慢时 `resolving permission` 窗口可能挂到每服务器超时,`Esc` 既不能中断它也到不了输入框的全局中断,而繁忙权限面板拒绝按键。回合信号现在穿透续接上下文重建与 MCP 连接/`tools/list` 链(中止干净地使续接失败、关闭已打开的连接、不留持久解决记录,因此待处理提示重新武装),每种续接都防护其持久会话写入不被取消,首回合的引导表面重建也可取消,繁忙回合中没有被任何底部表面面板处理的 `Escape` 回退到全局提示中断。

- **TUI 现在在 `bun run dev` 下第二次 `Ctrl+C` 时干净退出(#212)。** 第一次中断保持既有语义;重复的 `Ctrl+C` 完成干净的进程退出,而不是让 dev 会话挂起。

## [1.0.0-alpha.9] - 2026-08-09

### 新增

- **`grep_files` 输出模式、上下文行与输出预算。** `grep_files` 获得两个可选参数:`outputMode`(带文本的匹配条目用 `content`,只有文件路径用 `files_with_matches`,逐文件命中计数用 `count`)与 `contextLines`(content 模式下每个匹配 0–10 行周边上下文)。content 模式下宿主侧 32 KiB 的输出文本上限与既有的 `maxMatches` 上限(默认 50、最大 200)并列作为安全阀。在 `files_with_matches` 与 `count` 模式下,`maxMatches` 限制返回的文件数。每行 500 字符的摘录上限不变。

- **捆绑的 `novel-outline-v3` 第一方 Skill。** 一个层级化的小说大纲工作流 Skill(卷 → 章 → 场景)加入 `host-assets/skills/` 下的 `vesicle-docs` 与 `skillify`。它教授文本优先的方法论 —— 通读全部源材料、维护两份活文档台账(角色成长与世界状态)、起草卷/章/场景大纲、用闭式校验分配逐章张力预算(Σ 场景 = 章合计)、跟踪伏笔的埋设/回收并回写台账 —— 以可读参考的形式提供,没有脚本或进程能力。它与 Harness 10.2.0 张力预算系统互补。可作为宿主范围 Skill 经 `/skill` 与 `vesicle skills list` 发现。

- **可选开启的 MCP 工具输出持久化(#137B,切片 1)。** 在 `.vesicle/preferences.yaml` 设置 `mcpOutputPersistence: true` 把每个 MCP 工具调用的文本结果与解码图像持久化到 `tmp/mcp-output/<sessionId>/`(文本)与 `.../blob/`(图像,原生格式)之下,作为带工具与参数派生名称的可寻址文件。行内结果不变 —— 持久化是附加的、尽力而为的持久副本,模型用 `read_file`/`grep_files`/`view_image` 重新读取,而不是重复昂贵或不可重复的 MCP 调用。默认关闭;仅对带有 MCP 工具的 Engine 在系统提示中给出提示。`tmp/` 检查点排除(切片 0)使这些溢出留在回退台账之外。自动截断与有界 `read_file` 随切片 2(下文)交付。

- **MCP 输出自动截断与有界文件读取(#137B,切片 2)。** 新增 `mcpOutputAutoTruncate` 子开关(要求 `mcpOutputPersistence`):开启时,大于等于 32 KiB 的 MCP 文本结果以 4 KiB 预览加指向持久化完整副本的引用行内交付,因此单个巨大结果不再能主导下一个供应商请求。`read_file` 获得可选的 `offsetBytes`/`maxBytes` 用于从不加载整个文件的有界字节切片(适合大型持久化输出与巨型单行载荷),`grep_files` 把每个匹配行的摘录截断到 500 字符。基于字节的阈值使 CJK 与英文一致有界。两个开关都经 `/theme --persist` 往返;除非持久化也开启,自动截断读作关闭。

- **双纪元 Streamable HTTP MCP 工具兼容(#174)。** Vesicle 现在可以用遗留的 `initialize` 协议(修订 `2024-10-07` 至 `2025-11-25`)或现代的 `server/discover` 协议(修订 `2026-07-28`)连接 MCP 服务器,且一个 Vesicle 进程可以在单个工具注册表中同时持有两个纪元。逐服务器的 `negotiation: legacy|modern|auto` 独立控制连接路径;缺少 `negotiation` 时默认 `legacy`,线路零变更。官方 `@modelcontextprotocol/client@2` SDK 在薄 Vesicle 适配器之后拥有线路协商、类型化错误与增量 Streamable HTTP 行为;SDK 类型不进入 `core/`、供应商、Engine Profile、权限运行时或 TUI 渲染。现代连接发送逐请求的 `_meta` 信封与路由头(`MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name`),经关闭 SSE 响应流取消,且从不使用 `initialize`、`notifications/initialized` 或 `Mcp-Session-Id`。auto 用 `server/discover` 探测,只对权威的仅遗留信号回退;auth(401/403)、服务器失败(5xx)、超时、网络错误与歧义响应永不回退。两个纪元都规范化进既有的 `ToolDefinition`、`ToolCall`、`ToolResult`、权限、Engine 范围、别名、结果投递与会话事件边界。既有的行内图像路径(#175)与机密卫生保留。Setup 生成的条目使用 `negotiation: auto`;既有 YAML 永不被改写。doctor 显示逐服务器的模式、纪元、修订与失败类别;侧栏显示紧凑的纪元后缀。resource、audio、URL/link 投递(#177)、`input_required` 自动履行、`subscriptions/listen`、本地 stdio、经典 HTTP+SSE、MCP prompts/resources API 与 OAuth 不属于本次交付。

- **类型化的 MCP 多模态工具结果(#175)。** Streamable HTTP MCP 调用现在穿过一个协议中立、不可信的结果规范化器,而不是把未知的 `content` 对象压平成文本。有序文本保持兼容,而有效的行内 PNG/JPEG/GIF/WebP `ImageContent` 被严格 base64 解码、对照声明的 MIME 与魔数检查、存入既有的内容寻址附件存储,并只为有视觉能力的主或 SubAgent 供应商请求物化。会话 JSONL、恢复与压缩历史只保留 `source: "mcp"` 引用与宿主派生的标签。非视觉模型、MCP 错误结果、畸形或失配的图像、附件失败与临时的共享 20 MiB 解码图像上限,都降级为有界的无载荷通知;resource、audio、URL/link 与未知条目保持显式不支持,永不自动抓取或注入。

### 变更

- **捆绑 Harness 更新到 `prism-engine-v10@10.2.0`(规则包 0.4.0)。** 已验证的 73 文件基线(Neural Narratology Release `harness-20260808-1`,提交 `90f3488`)新增带场景分配闭式校验的逐章张力预算、可选的卷级规划层、注入 Scene Writer 与 Weaver 的对话写作指南、Scene Writer 的写前五元素清单、新的 Evaluate 维度 H(设定揭示平衡),以及反 AI 味规则包 0.3.0-alpha.4 → 0.4.0 带三个新 zh-CN 检测:`zh-f1-negative-description`、`zh-f1-decorative-ending` 与 `zh-f3-period-density`(F3,仅观察)。Harness Driver Contract 与所需的 Vesicle 能力不变(契约差异仅版本号)。新的 `zh-f3-period-density` 规则使用 `period_per_100_chars` 度量信号,因此 Vesicle 为该信号增加宿主侧支持 —— 每 100 字符排除对话的 `。` 密度,由 `minimumMatches` 门控 —— 与既有的 `em_dash_per_100_chars` 路径并列;Quality Guard 加载器与检测器镜像破折号特例,不要求该信号提供规则 `patterns`。捆绑校准语料保持 24 个宿主一致性用例;评审规则数从 21 升至 23。

- **草稿根 `tmp/` 排除出回退检查点(#137B,切片 0)。** 项目相对草稿根 `tmp/` 下的受护栏文件变更仍可经普通文件工具写入,但现在排除出逐回合文件检查点与回退生命周期:`/rewind` 与双 Esc 不再恢复 `tmp/` 的状态,因此草稿编辑(包括 `tmp/skillify/` 草稿)不是回退安全的。这推翻了 137A 的决定,并为 `tmp/` 承载临时的 MCP 工具结果溢出做准备,而不污染持久的内容根检查点台账。宿主仍从不自动清理草稿状态。跨 `tmp/` 边界的移动在回退时不完全可逆(草稿→内容会丢失被移动的主体;内容→草稿会在 `tmp/` 留下副本);当回退安全重要时,用 `copy_file` 提升草稿中的工作。

### 修复

- **Skill 工具移至宿主层注入,在 Harness 10.2.0 升级后恢复 Skill 面。** 捆绑 Harness 10.2.0 升级(`f964c41`)整体替换 `assets/engines/` 并静默地从每个非 Stage Engine Profile 的 `defaultTools` 丢弃三个 Skill 工具(`activate_skill`、`read_skill_resource`、`run_skill_script`)。因为运行时把整个 Skill 面门控在 `profile.defaultTools.includes("activate_skill")` 上,真实会话丢失了 `<skill_catalog>` 提示块与全部 Skill 工具,既有的激活也被修剪 —— 使每个 Skill(包括捆绑的 `novel-outline-v3`、`vesicle-docs` 与 `skillify`)不可发现且不可用。集成测试没有抓住这一点,因为其夹具写入了重新加回这些工具的合成 Profile。Skill 工具现在由宿主层为会话目录非空的每个非 Stage Engine 注入,独立于 Harness Profile 的 `defaultTools`,因此 Harness 升级不再能覆盖它们。`resolveEngineEligibleCatalog` 现在只门控 `profile.id === "stage"`。`VESICLE_HOST_ASSETS_DIR` 环境变量让自定义部署独立于捆绑包布局解析 host-assets 根。

- **浅色主题的文本选择与 Workspace 编辑器对比度(#158)。** 可选择的 TUI 文本现在接收一个主题拥有的前景/背景选择对,而不是依赖 OpenTUI 隐式的透明缓冲颜色交换。Markdown 经正文、列表标记、围栏代码与表格传播同一选择对,包括主题更改期间挂载的选择。Workspace 文本区现在对普通与聚焦的文本、光标和选择颜色显式跟随活动主题,修复了其编辑器文本在浅色背景上显示为白色的问题。

## [1.0.0-alpha.8] - 2026-08-01

### 新增

- **宿主捆绑的 `skillify` Skill 与草稿区优先的草稿发布(#127)。** 用户可以让 Vesicle 把当前对话中已被验证的工作流变成可复用的可移植 Skill,而无需手工编写目录。捆绑的 `skillify` Skill 用普通的受护栏文件工具把可复用过程提取到 `tmp/skillify/<name>/`,经既有解析器与捆绑规则验证完整草稿,并在显式的目标决策之后仅创建式地发布到 `.agents/skills/<name>/`(项目)或不可变的 Skill Store(已安装)。发布是仅创建的:不覆盖、不合并、不升级、不备份替换。草稿总是保留;当前会话目录从不被更改,已发布的 Skill 只能从新会话发现。两个薄 `.sh`/`.ps1` 包装器从非模型可见的 CLI(`vesicle skills validate --draft --json`、`vesicle skills publish-draft --target <project|installed> --json`)中继一个带版本的 JSON 契约(`vesicle.skill-draft/v1`);包装器不含路径、哈希、复制、暂存或清理逻辑。随该特性交付的通用运行时支持:`run_skill_script` 中的 `.ps1` 脚本执行(Windows 上优先 PowerShell 7、回退 Windows PowerShell 5.1,其它平台仅 `pwsh`,`-File` argv 而无 `-Command` 或 `-ExecutionPolicy Bypass`);稳定的自调用(`VESICLE_SELF_EXECUTABLE`/`VESICLE_SELF_ENTRYPOINT`)使捆绑脚本调用启动它们的精确 Vesicle 运行时而不假设 PATH,仅注入被过滤的 `run_skill_script` 子进程;共享的可移植捆绑检查缝(`src/skills/bundle.ts`);以及带链接祖先拒绝与兄弟暂存原子项目发布的受护栏草稿发布器(`src/core/skills/draft-publisher.ts`)。普通 `skills install|update|rollback|uninstall` 的语义不变。

- **项目相对的 `tmp/` 草稿根(#137A)。** 普通的受护栏文件工具现在可以读取并更改项目相对 `<project>/tmp/` 下的路径用于草稿与中间工作,且 `tmp/` 以根锚定进 `.gitignore`。草稿变更参与既有的逐回合文件检查点与回退生命周期;绝对 OS `/tmp`、`..` 逃逸与符号链接遍历仍被拒绝,固定根规则仍拒绝创建/移动/删除 `tmp` 本身。`tmp/` 被刻意排除出 `/init` 扫描、Stage 输入发现与源漂移检查、产物工作台的 `/artifact` 与 `/validate`、Output Quality Guard 的产物目标、`vesicle skills copy-template` 的目的地与自动发布;宿主从不自动创建或自动清理草稿状态。根分类法从 `core/artifacts/roots.ts` 移到中立的 `core/project/roots.ts`(`sourceRoots`、`artifactRoots`、`scratchRoots`、`projectContentRoots`、`modelWritableRoots`),运行时提示、公开开发者文档、配对用户手册、`README` 对与 `STATUS` 描述了源/产物/草稿的区分。

- **可选的供应商 HTTP/WebSocket 代理(#150)。** 用户级 `.env`(与 `providers.yaml` 相邻)中的一个可选 `VESICLE_PROVIDER_PROXY` 把所有供应商 HTTP(S) 与 WebSocket 流量经支持的 `http://`/`https://` 代理路由,URL userinfo 作为 Basic 认证机制。优先级为用户文件 → 进程 → 继承的终端代理变量 → 直连,空值按缺省而非“直连”处理;显式的 Vesicle 代理覆盖继承变量,且不被终端的 `NO_PROXY` 绕过。共享的供应商 fetch 边界与原生 Responses WebSocket 工厂使用 Bun 的原生 `proxy` 选项,保留每一条既有的重试、取消、流式、续接、轮换与 WebSocket 到 HTTP 回退规则。代理 `407` 在 HTTP 与 WebSocket 上都是终止性且不重试(每会话预检在 WebSocket 重试循环之前抛出它,因为原生 WebSocket 否则会把代理 407 呈现为通用连接失败);代理连接失败遵循既有的重试策略;代理 URL、主机、端口与凭据永不进入错误消息、原因、诊断、会话/质量产物或 `vesicle doctor` 输出。引导 Setup 的模型发现也经显式代理路由,因此仅代理的网络也能完成上手。确定性解析器/脱敏覆盖、HTTPS 与原生 WebSocket 的真实本地 CONNECT 边界测试(包括一个 WebSocket 错误凭据回归),以及经必需代理的官方 OpenAI HTTP 与原生 WebSocket 函数循环(2026-07-31 以 `gpt-5.6-luna` 通过,已脱敏证据)现在全部通过;官方验收是可选开启的,注入解析后的代理策略,并在前置条件缺失时报告不可用。继承选择镜像钉住的 Bun 运行时:对安全目标遵循 `https_proxy`/`HTTPS_PROXY`(优先小写),不遵循 `HTTP_PROXY`/`ALL_PROXY`;`NO_PROXY` 支持 `*`、精确主机与前导点后缀,不支持 `:port` 或 `*.`;OS/PAC/SOCKS 发现、代理链、逐供应商选择、NTLM、自定义代理头与生产不安全 TLS 是非目标。

- **带日期的 DeepSeek Responses 子集。** `deepseek-subset-2026-07-31` 经独立的 Responses 适配器把 DeepSeek v4 Flash 暴露为显式 Bearer 认证、仅 HTTP、无状态的兼容 tier。它省略不支持的续接、Conversations、storage、background、加密推理 include、WebSocket 与远端压缩字段;重放完整的供应商可见上下文;映射 DeepSeek 明文的 `response.reasoning_text.*` 事件与 Item;并保留精确的函数 `call_id` 配对。推理控制遵循 DeepSeek 文档化的 `none`/`low`/`high`/`max` 映射,包括把 Vesicle 的 `medium`/`xhigh` 规范化为 `high`。引导 Setup、示例、doctor、配对用户文档、确定性省略/事件测试与一条可单独选择的真实供应商推理/函数车道携带相同的 Profile 边界。已注资的官方端点 2026-07-31 通过两个实时用例(`2` 通过、`0` 失败);`deepseek-v4-pro` 仍被排除,直到其宣布的八月 Responses 支持上线并独立验收。

### 变更

- **OpenAI Responses 产品暴露与第三方子集边界(#122,阶段 6)。** 独立适配器现在是显式配置、可选开启的实验供应商协议,而不只是实现路径;晋升仍等待 MiMo 门于 2026-07-31 完成之后的成功官方真实供应商验收。`openai-public` 暴露官方应用层 HTTP/SSE、非流 JSON、会话范围的公共 WebSocket、精确 Item/`call_id` 重放与模型声明的独立压缩 Profile,而不声称 Codex 私有身份或网络栈指纹相等。新的仅 HTTP `mimo-subset-2026-07-30` Profile 省略不支持的 storage、续接、并行调用、WebSocket、远端压缩与其它 OpenAI 专属请求字段;只在该 Profile 下映射 MiMo 的 `response.reasoning_text.*` 事件与 `reasoning_text` Item;支持其文档化的 `x-api-key` 认证;并保持显式的第三方兼容 tier,而非 OpenAI 一致性。原生 Item 与压缩状态为 Profile 所有,因此在同一端点更改 tier 会回退到可移植历史而不是重放不兼容的状态。引导 Setup 现在在端点发现之前询问 Chat/OpenAI Responses/MiMo Responses,并在序列化期间保留所选的 Profile;`vesicle doctor` 报告 Responses Profile、tier、传输与远端压缩声明。规范示例、配对的 zh-CN/en 供应商文档、架构/供应商/Setup 契约与 STATUS 现在陈述精确的边界。新的可选官方与 MiMo 套件在选择器、凭据、Profile、能力或端点缺失时使用真实的跳过测试与无机密的不可用原因;确定性覆盖证明 MiMo 字段省略与 Profile 范围的推理映射。初始 2026-07-30 运行没有官方凭据,MiMo 两个用例都返回 HTTP 402(`0` 通过);注资恢复后,2026-07-31 的后续运行通过两个 MiMo 用例(`2` 通过、`0` 失败),官方验收仍不可用。

- **会话生命周期与双 OpenAI Responses 压缩投影(#122,阶段 5)。** 可移植压缩保持恢复权威,而显式能力门控的 `openai-responses` Profile 也可以经 HTTPS 调用无状态的 `/responses/compact` 端点。两种投影从同一个未压缩会话头派生,并在一个只追加检查点中原子安装;竞争的头、畸形的原生输出、供应商失败或取消都不能留下部分的原生检查点。适配器把完整的规范压缩 Item 窗口存为有界的属主限定供应商状态,开启新的续接链,并只对相同的协议/供应商/模型/端点属主重放这些 Item。供应商/模型切换与不兼容、损坏、被拒绝或过期的原生状态从可移植历史恢复;非属主的 Chat Completions、Anthropic 与 Gemini 适配器从不序列化仅宿主的标记。子 Agent 现在以其持久的子会话 id 拥有供应商资源并在完成时关闭它们。受支持的用户可见配置、Setup/示例、第三方子集证据与发布验证仍是阶段 6。

- **会话范围的 OpenAI Responses WebSocket 传输(#122,阶段 4)。** 独立的 `openai-responses` 适配器现在可以为每个活动会话与精确的供应商/模型/端点/Profile 属主选择持久 WebSocket,同时保留 HTTPS/SSE 路径。公共的 `response.create` 消息省略仅 HTTP 的 `stream` 与 `background`;单独声明的 `codex-beta-2026-02-06` Profile 发送其冻结的 beta 头与流字段。首个请求执行 `generate: false` 预热,后续回合与工具轮在精确保留的 `previous_response_id` 之后只发送 input,缺失或过期的连接局部状态会重开 socket 并重放完整的可移植上下文。一个 socket 只允许一个在途响应,在公共的 60 分钟限制之前轮换,在会话/属主/进程生命周期变化时关闭,并把每次尝试缓冲在既有的终止提交屏障之后。可重试的失败获得五次带全新累加器的重试;耗尽把该活动会话永久降级到 HTTP,而取消永不重试。故障覆盖包括连接/打开失败、断开之前接受的文本与函数 Item、缺失续接、取消、重试耗尽、永久回退、属主变更与关机。远端压缩、第三方子集暴露、Setup/示例与受支持的用户可见配置仍是后续阶段。

- **独立 OpenAI Responses HTTPS/SSE 正确性基线(#122,阶段 3)。** 新增独立的 `openai-responses` 适配器,不更改 Chat Completions、Anthropic Messages 或 Gemini。一个确定性请求编解码器现在映射 instructions、有序的输入 Item、宿主函数定义/结果、推理控制、`store: false`、加密推理包含与生成限制;同属主的有界原生输出 Item 重放时不解密或重建推理,而不兼容的属主回退到可移植消息。非流 JSON 与类型化 SSE 共享一个严格的最终解析器,处理有序的 message/reasoning/function Item、精确 `call_id`、用量、错误与终止状态。SSE 尝试隔离并至多重试五次:临时文本、工具候选、用量与原生状态保持缓冲直到结构有效的 `response.completed`,因此过早的 EOF 不能复制 UI 输出或宿主副作用。应用层路径已对真实的 `doro-gpt` Responses 端点验证,包括流式函数调用、精确结果配对、不透明原生状态重放与最终文本回合。WebSocket 属主、续接、远端压缩、第三方能力暴露与受支持的用户可见配置仍是后续阶段。

- **为独立 Responses 工作铺设的供应商中立持久状态与终止提交基础(#122,阶段 2)。** 完成的 assistant 响应现在可以携带一个带版本、属主限定、JSON 安全的供应商状态信封,上界 256 KiB,并穿过持久化、恢复、回退、只追加分支、旁路提问/质量续接与保留的可移植检查点消息克隆。通用 core 从不解释该不透明载荷;畸形或未知的必需版本可操作地失败,而无状态的遗留会话保持不变。供应商回合现在穿过显式的尝试提交屏障:流式的工具候选保持临时,被丢弃或过早结束的尝试不发布调用或原生状态,只有匹配的终止响应才能把调用释放给 Agent Loop。一条回归证明:完整的流式 `write_file` 候选随过早 EOF 不产生文件或 assistant/工具记录,而随后的成功重试恰好执行一次。这只是供应商中立的基础;它还不暴露 OpenAI Responses 运行时 Profile。

- **Esc 中断现在拥有精确的 FIFO 头,并在持久重建之后恰好提交一次(#135)。** 繁忙时的提示级 Esc 中止活动的供应商或工具操作,并在被中断的持久会话投射重建之后,把按键时捕获的 FIFO 头作为新的顶层输入在正常命令分发下恰好分发一次。被召回、消费或替换的头会取消接管而不是替换为另一个排队项;缺失会话 id 或投射重建失败保持失败关闭,不出队也不提交任何东西;Esc 之后排队的项永不回溯晋升。带光标、元素与图像附件的输入框草稿保持不动,繁忙 Esc 从不自动入队草稿。输入框现在对空的繁忙队列显示 `Esc interrupt`,存在队列头时显示 `Esc interrupt & send next`,都在 80 列预算内。完整的按键路由控制器链覆盖与聚焦的失败关闭单元测试保护恰好一次的提交契约。

- **PromptComposer 使用终端原生的细线光标而非反白字符块高亮(#136)。** 共享的多行输入现在经渲染器的后处理阶段把终端真实的光标(style `line`,闪烁)定位到插入点,而不是把每个视觉行拆成前缀/cursorChar/后缀并对光标下的字形应用 `INVERSE`。这消除了空行上的一列偏移、CJK 字符上的双宽块与反白前一字符的全行回退。光标坐标按字形显示宽度计算,覆盖 ASCII、CJK、emoji、ZWJ 序列与组合标记,横跨软换行、显式换行与滚动的视觉窗口。每个共享输入框必须声明是否拥有原生光标,因此 Workspace 文本区与模态表面不冲突;焦点丢失与卸载隐藏旧光标并恢复默认样式,不向调用方 shell 泄漏 line 模式。

### 修复

- **独立 CR 的后续恢复会话、供应商、Setup 与 SubAgent 不变量。** 供应商原生压缩标记现在在每次重建的请求中保持其仅宿主的类别,并在失败回合清理中与可移植压缩边界一起存活,因此远端压缩的 Responses 会话既不注入空的用户 Item,也不在失败的回合之后丢失原生窗口。全新会话的 `/skill` 初始化释放其已解析的身份缓存,`/new` 使其失效,防止之后的激活重新打开被放弃的会话。引导 Setup 在所选粗粒度预设仍描述该 Profile 时,保留既有的 Codex/Responses Profile、传输、认证方式与 User-Agent。子 Agent 失败的工具结果为 Anthropic 的 `is_error` 重放保留 `toolOk: false`。Responses WebSocket 的代理认证预检受 socket 请求超时限制,预热的 token 用量计入完成的逻辑响应。损坏的可选质量决策候选状态被隔离而不是破坏全会话选择器,而必需的 assistant 供应商状态保留其文档化的失败关闭行为。最后,`reasoningTier: off` 现在为官方/Codex Responses Profile 发送 `effort: none`,而不是回退到供应商默认的推理。

- **`codex-http-relay` 现在消费 Codex 原生的完成 Item 流而不削弱终止安全。** 服务 Codex 的 HTTP/SSE 中继可能经有序的 `response.output_item.done` 事件交付推理、消息与并行函数调用,而让 `response.completed.response.output` 为空。最大兼容的中继 Profile 现在只在结构有效的 `response.completed` 之后重建该输出,持久化重建的有序 Item 用于精确的原生重放,并保留精确的 `call_id`/参数配对。公共与第三方 Profile 保持既有的终止规则;中继的非空终止输出必须与其完成 Item 流精确匹配,而过早的 EOF、失败/不完整的终止、缺失 Item、稀疏索引、畸形调用或矛盾的表示不提交任何 assistant 状态或工具副作用。脱敏的一致性证据与聚焦的多调用回归覆盖真实的 Doro/Codex 形态。

- **MiMo Responses 推理 Item 接受供应商的空 summary 占位符。** 带日期的 MiMo 子集仍拒绝 OpenAI 推理摘要与加密推理,但不再仅因真实端点包含其固定的空 `summary: []` schema 字段而拒绝有效的终止 `reasoning_text` Item。聚焦覆盖保留对非空 summary 内容的失败关闭行为。

- **官方 Responses 推理 Item 接受空内容占位符。** 全部非 MiMo Profile(`openai-public`、`codex-http-relay`、`codex-beta-2026-02-06`)现在接受携带 `content: []` 连同加密推理与 summary 字段的官方推理 Item 形态;非空或畸形的推理内容仍被拒绝。

- **Responses 验收区分中继诊断与真实 WebSocket 传输。** 仅 HTTP 的 `codex-http-relay` Profile 现在准入观察到的非语义 `responsesapi.websocket_timing` 事件,而不把它暴露为规范化输出或持久状态,而 `openai-public` 保持严格。官方公共 WebSocket 验收现在在适配器降级到 HTTP 时失败,防止成功的回退请求被计为 WebSocket 证据。

- **MiMo 真实供应商验收现已完成;可信中继证据保持能力范围。** 注资恢复后,带日期的 MiMo 子集通过了真实的推理与函数循环用例(`2` 通过、`0` 失败)。可信的 Codex 后端 `doro-gpt` 网关通过了中继 HTTP/SSE 与一次非流 Responses 请求,但其独立压缩仍返回 HTTP 503,禁止回退的 WebSocket 探测仍在连接建立期间失败。公开状态因此保持可选开启的实验,而不是把部分网关覆盖当作完整的 `openai-public` 通过。

- **Workspace 文本粘贴现在到达聚焦的文件编辑器而不是隐藏的聊天输入框(PR #139 后续)。** 全局括号粘贴处理器忽略 Workspace 页与焦点状态,因此当可编辑的 Workspace 源文件持有焦点时,终端粘贴的文本被插入共享的聊天输入框,聚焦的文本区从未看到该事件 —— 编辑器缓冲与保存的文件保持不变。路由现在解析一个显式的 Workspace 粘贴所有权决策:编辑器焦点下存在未遮挡的可编辑源时,事件保持未消费,让 OpenTUI 交付给聚焦的文本区(保留多行文本);树焦点、只读查看器焦点或缺失焦点数据阻塞事件(失败关闭,永不进入聊天输入框);Workspace 输入框焦点与 Chat 页保持既有的插入一次并消费的行为。全局覆盖层、Workspace 局部面板、输入条、对话框与其它模态、选择器、权限、门或问题表面仍优先于 Workspace 编辑器交付,键盘触发的剪贴板图像粘贴(Ctrl+V、Alt/Option+V)不变。这恢复了已文档化的契约:终端文本与括号粘贴走正常的文本输入路径;经聚焦的路由测试与真实的 PTY 冒烟验证 —— 粘贴进可编辑文件、以 Ctrl+S 保存并断言磁盘上的粘贴字节。

- **图像粘贴的组合缺陷:多图像逆序插入的编号与 Workspace 输入框路由(#134)。** 以相反的位置顺序粘贴图像(后位先、先位后)产生的占位编号与发送给供应商的视觉元素顺序不匹配,导致三个协议适配器(OpenAI Chat、Anthropic Messages、Gemini)反向标注图像。`insertComposerImage` 现在在每次插入之后按视觉位置重新编号全部占位符,使占位文本、ComposerElement 顺序、附件 id 与供应商图像数组保持在单一一致的映射中。此外,Workspace 页的输入框此前永远无法触发剪贴板图像粘贴:`input-routing.ts` 在 workspace 键处理器之后无条件返回,使 `isClipboardImagePasteKey` 分支不可达,即使 workspace 焦点在共享输入框上。路由现在区分三种所有权结果 —— 被 workspace 消费、传播到原生 editor/textarea、落空到共享输入框 —— 因此 Ctrl+V 与 Alt/Option+V 从 Workspace 输入框到达 `pasteClipboardImage()`,而树与编辑器区域永不泄漏图像粘贴。同一图像被重复粘贴时状态行也报告正确的编号:附件 id 由内容哈希派生并对相同字节复用,因此报告的编号严格计算插入点之前既有的图像数而不是查找该 id —— 在既有占位符的正好开头处粘贴会正确地把新图像报告为 #1。

- **畸形的工具参数不再毒化供应商历史或截断下一回合(#133)。** Agent Loop 现在在权限或执行之前把每个完成的规范化工具调用验证为 JSON 对象。无效的调用不分发给宿主、MCP 或 SubAgent 工具;其持久的供应商可见参数变为 `{}`,配对的失败 ToolResult 告诉模型用更小的有效输入重试,有界的仅宿主元数据保留失败类别、字节长度、SHA-256 与 256 字符前缀用于诊断。有效的兄弟调用仍恰好执行一次并保持可审计。Anthropic 以原生 `tool_result.is_error: true` 重放失败结果;Anthropic 与 Gemini 序列化器也把修复前会话的畸形参数降级为 `{}`,因此恢复不会在本地历史序列化上循环。任何主回合异常之后,TUI 从持久会话投射重建其供应商对话,保留回合中已追加的 assistant/工具记录,同时保留既有的顶层 `failed-turn` 行为。

- **以 `/skill` 作为全新会话的第一个输入不再触发 Harness 身份守卫(#131)。** 以 `/skill <name>`、`/skill <name> --context-only` 或裸 `/skill` 选择器开启全新的 TUI 会话此前失败并提示 “Session Harness identity does not match the active verified project baseline”:宿主路径铸造会话 id 并把 `skill-activation` 记录作为会话的首记录持久化,因此首个供应商回合看到一个没有系统头的“已存在”会话,身份守卫正确地拒绝了它。宿主路径现在先持久化完整的会话身份 —— 新的核心 `initializeSessionIdentity`(经共享的 `buildSessionHeaderRecord` 与回合引导共用)在任何激活记录追加之前写入完整的系统头,包括 Engine/Profile、供应商/模型、权限、生成、资产、指令、Harness 身份与冻结的 Skill 目录;TUI 只在该头持久化之后才采用会话 id,像正常的首次回合一样门控供应商配置/权限就绪,并在分支激活之后推进分支头使下一回合链在其后。激活注册表只在持久追加成功之后标记,hydrate/去重/追加/记录事务在跨进程原子的每会话锁下运行,因此并发的相同激活 —— 无论单进程内的快速重复提交还是两个独立进程 —— 都不可能同时通过哈希去重检查(一次激活落地,不是两次)。无头的遗留或损坏会话仍失败关闭:守卫不变,也没有任何东西为既有会话自动写入头。

## [1.0.0-alpha.7] - 2026-07-28

### 新增

- **宿主捆绑的 Skills 与第一方 `vesicle-docs` Skill(#127,部分)。** 交付 #127 的宿主发现机制与 `vesicle-docs` Skill;计划中的 `update-config` 与 `skillify` Skill 仍延后到未来发布。为包所有的第一方 Skill 在 `host-assets/skills/` 下新增通用的宿主发现范围。没有用户、项目、已安装或 Harness Skill 的干净安装现在从包布局发现 `vesicle-docs`,显示为范围 `host`,并允许在每个非 Stage Engine 上激活。完整优先级在冲突选择与目录省略中都变为 `project` > `user` > `installed` > `harness` > `host`。宿主 Skill 经既有的用户级禁用名称文件切换;Harness 保持不可禁用。CLI 与会话目录共享一个文件系统来源解析器(`src/core/skills/catalog-sources.ts`)。捆绑的 `vesicle-docs` Skill 包含精炼的 `SKILL.md` 加公开 `README.md`、`docs/user/`、`docs/dev/` 与 `docs/examples/` 材料的确定性、被跟踪镜像(81 个资源,无脚本,无进程能力)。同步脚本(`bun run skills:docs:sync` / `skills:docs:check`)把公开来源的漂移强制为可执行失败。npm、独立二进制、assets ZIP 与 Windows 安装器载荷都包含该 Skill。运行时边界见 `docs/dev/SKILLS.md`。

- **Skills 运行时阶段 0:格式、清单与 Skill Store。** 引入开放的 Agent Skills `SKILL.md` 格式作为一等、非模型可见的基础。严格的解析器与校验器(`src/skills/parser.ts`)检查可移植核心 —— 必需的 `name`(1–64 个小写字母数字/连字符,与父目录匹配)与非空的 ≤1024 字符 `description`,可选的 `license`/`compatibility`/字符串到字符串的 `metadata` —— 每个 `SKILL.md` 上限 64 KiB / 500 行,至多 200 个支持资源。实验性的 `allowed-tools` 字段为兼容性解析但带一条诊断忽略;工具权限运行时仍是唯一的工具批准权威。未知的 frontmatter 字段保留供检查但无运行时行为。有界的发现扫描已验证的 Harness(`assets/skills/`)与用户(`<user-config>/skills/`)范围,确定性的 `user` 覆盖 `harness` 优先;名称冲突恰好选择一个胜者并把较低优先级的条目报告为被遮蔽,从不合并正文或资源。解析严格且失败软化:一个畸形的 Skill 被跳过并带诊断,而有效的兄弟保持可用,UTF-8 致命解码并剥离一个 BOM,符号链接的 Skill 根与资源被拒绝,每个资源路径都被限制在虚拟 Skill 根内(无绝对路径、`..`、反斜杠、NUL、符号链接或规范化歧义)。不可变、内容寻址的 Skill Store(`<user-config>/skill-store/<name>/<version>/`)在来源侧车与小活动索引旁保存字节精确的标准捆绑;快照暂存、按哈希复验并原子重命名,重装相同内容幂等,永不留下对来源路径的活动依赖。有界的目录构建器只暴露 `name`/`description`/逻辑来源 `scope`,预算约为上下文的 2% / 8 KiB 回退,并对保留的 Skill 计算身份哈希。新的 `vesicle skills list | validate | inspect` 命令与 `vesicle doctor` 的 Skills 行呈现有效/无效/被遮蔽计数;没有 CLI 输出携带绝对宿主路径。**此阶段没有模型可见的激活**:没有 `activate_skill` / `read_skill_resource` 工具、没有 `/skill` 命令,也没有提示组合、会话、压缩或 Engine 切换的更改。仓库安装命令、激活运行时、项目 `.agents/skills/` 范围与脚本执行延后到文档化的后续阶段。运行时边界见 `docs/dev/SKILLS.md`。

- **Skills 运行时阶段 1:仓库安装与生命周期。** 在阶段 0 Skill Store 之上构建 `install` / `update` / `rollback` / `uninstall` 面,仍无模型可见的激活。`vesicle skills install <path-or-url>` 接受本地目录、本地 Git 仓库或 GitHub 仓库 URL(`--ref`、`--path`、`--all`、`--include-worktree`)。仓库形状检测(`src/skills/repo.ts`)把来源分类为根 Skill、单个嵌套 Skill、常规的 `skills/*/` 集合或多任意布局,并在存在多个 Skill 时拒绝猜测(要求 `--path` 或 `--all`)。本地 Git 来源默认快照被跟踪的 HEAD 树,要求 `--include-worktree` 才捕获未提交的更改;GitHub 引用(分支、标签或 SHA)在下载之前经 GitHub API 解析为不可变的提交 SHA,因此安装的版本永不随移动引用漂移。每次安装验证可移植核心、经既有路径护栏枚举捆绑、对每个文件内容哈希、暂存、按哈希复验并原子激活;重装相同内容按捆绑哈希幂等,硬冲突(相同版本标签、不同内容)被拒绝。来源侧车记录来源的种类与身份、请求的引用、解析的提交与脏来源标记。`update` 从记录的来源重新获取并向前滚动(保留前一版本),`rollback` 恢复最近的先前版本,`uninstall` 移除索引条目与版本家族。活动索引的读改写由 SQLite 事务跨进程串行化,其所有权在进程退出后自动释放。`vesicle skills list` 与 `inspect` 显示已安装的 Skill(范围 `installed`)及版本、来源种类与来源信息,`vesicle doctor` 增加已安装计数;Skill Store 可由 CLI 列出但还不是模型可见的目录来源。没有面向模型的目录或诊断形状携带绝对宿主路径。仍没有模型可见的激活:没有 `activate_skill` / `read_skill_resource` 工具、没有 `/skill` 命令。运行时边界见 `docs/dev/SKILLS.md`。

- **Skills 运行时阶段 2:激活、资源、脚本与 `/skill` 命令。** 使 Skills 模型可见且用户可调用。三个新的模型工具:`activate_skill(name)` 把精确的 `SKILL.md` 正文作为带资源清单、内容哈希、范围与权威披露的标记工具结果注入(枚举动态目录、基于哈希的去重);`read_skill_resource(skill, path)` 读取任何捆绑文件,包括脚本源,而不要求进程能力(256 KiB 截断、路径加固);`run_skill_script(skill, path, args[])` 经既有的进程运行时以结构化 argv 执行捆绑脚本(无 shell 插值,与任何进程动作相同的超时/输出/取消/清理/权限行为)。`/skill` TUI 命令提供裸选择器(带范围、脚本计数与描述的 OptionPicker)、`/skill <name> [task]` 激活并调用、`/skill <name> --context-only` 仅加载。会话语义:目录按会话冻结并持久化为有界快照(恢复按名称+哈希重解析,从不静默替换已更改的内容);激活记录持久化为持久的用户记录;压缩在 16 KiB 预算内重新附加活动的 Skill 正文,否则报告丢失并要求重新激活;Engine 切换重算资格并修剪激活注册表;重放/回退/恢复从持久记录派生激活状态。目录块只在至少一个 Skill 合格时注入系统提示(空目录保持提示字节一致)。六个非 Stage 的 Engine Profile 声明 Skill 工具;Stage 保持无 Skill。权限分类:`activate_skill` 为 `mutate`(失败关闭默认),`read_skill_resource` 为 `observe`,`run_skill_script` 为 `arbitrary_exec`。运行时边界见 `docs/dev/SKILLS.md`。

- **Skills 运行时阶段 3:创作与项目范围。** 新增项目 `.agents/skills/` 发现,带可见的 `project` 范围归属且无单独的信任门。优先级现在是 `project` > `user` > `installed` > `harness`;共享的项目约定高于个人创作,后者高于显式安装,后者高于已验证的 Harness 基线。新的 CLI 命令:`vesicle skills create <name> [--scope user|project] [--force]` 用有效的 `SKILL.md` 模板脚手架标准的 Agent Skills 目录(无 `--force` 拒绝覆盖;有 `--force` 时先备份);`vesicle skills enable <name>` / `disable <name>` 跨所有范围切换可用性(已安装使用 store 活动索引的 `enabled` 标志;user/project 使用 `<user-config>/skills/.disabled` 与 `<project-root>/.vesicle/disabled-skills` 的按行禁用名称文件);`vesicle skills copy-template <skill> <resource-path> <dest-path>` 把 Skill 资源复制进已批准的可写根,来源路径加固、目的地做可写根验证。被禁用的 Skill 在目录解析时排除;按会话冻结的契约不变。`vesicle skills list`、`inspect` 与 `vesicle doctor` 现在呈现项目范围的 Skill。运行时边界见 `docs/dev/SKILLS.md`。

- **回合中自动压缩、诚实的 `/context` 与生命周期可见性(#107,PR 4/4)。** 完成 issue #107。第二个投射的硬上限检查现在在排队转向与后台通知物化之后(这些包被保留的边界逐字钉住)的精确请求前边界运行,而正常的软检查在完整的 assistant/工具批次之后运行 —— 因此长的工具循环只在轮次之间压缩,永不拆分并行的工具批次,活动的边界 + 工具调用/结果配对精确存活。压缩之后,活动的内存消息数组重绑定到检查点后的历史;每个边界至多运行一次压缩;硬上限失败以可操作的通知阻塞下一个供应商请求,而不是超上限发送。`/context` 现在诚实:它报告配置的窗口、最新的供应商观测用量、激活状态及未激活时的精确原因(阈值或窗口缺失时不再有 “enabled” 行)、有效的软触发与硬输入上限、输出预留及其来源,以及活动的策略(`portable-summary`);它从不把估计当作供应商确认的保护来报告。核心的 `compact_check` / `compact_started` / `compact_completed` / `compact_failed` / `compact_deferred` 生命周期事件到达 TUI 状态行与活动日志(触发/阶段/原因、用量来源、投射 token、保留/逐出计数、检查点 UUID、时长 —— 绝无摘要文本或用户内容)。配对的 zh-CN/en 配置文档描述可选开启的激活要求。Issue #107 完整交付:只追加转录 + 原子替换检查点 + 以当前权威重载 + 安全的回合前与回合中触发 + 诚实的可观测预算状态。(关闭 #107。)

- **回合前自动压缩(#107,PR 3/4)。** 当模型声明 `limits.autoCompact` 且 `threshold` 严格介于 0 与 1 之间、`enabled` 不为 false、`limits.contextWindow` 为正整数时,Vesicle 现在在把新的顶层用户输入持久化进既有会话之前评估投射的下一请求(可用时取最近的供应商 `contextInputTokens`,否则取包含传入输入的宿主基于字节的估计),并在投射越过软触发时对旧头运行可移植检查点压缩。软触发为 `floor(min(contextWindow * threshold, contextWindow - effectiveOutputReserve))`,硬输入上限为 `contextWindow - effectiveOutputReserve`,其中输出预留按 `autoCompact.reserveOutputTokens` → 有效回合 `maxTokens` → `limits.maxOutputTokens` → 零的优先级解析;不小于上下文窗口的显式预留(或任何使有效输入预算非正的静态限制)会停用自动压缩而不是被静默钳制,且没有隐藏的默认阈值。软触发压缩失败保留旧头并让请求继续(它仍在硬上限之内);硬上限失败或削减不足会在不更改会话的情况下阻塞供应商请求、恢复输入框草稿并呈现可操作错误,使用户可以重试、手动 `/compact` 或切换模型。新会话、Stage 与恢复的待处理交互跳过检查;压缩供应商请求本身从不重新进入自动评估(无递归)。核心生命周期事件(`compact_check`、`compact_started`、`compact_completed`、`compact_failed`)携带触发/阶段/原因、用量来源、投射 token 计数、保留/逐出单元计数、检查点 UUID 与时长 —— 绝无摘要文本或用户内容。手动 `/compact` 与 `/engine --summary` 不变。(回合中自动压缩、诚实的 `/context` 与配对的用户文档在 PR 4 交付。)

- **可移植的 `/compact` 检查点(#107,PR 2/4)。** 手动 `/compact` 现在安装一个原子、带版本的 `compact-checkpoint-v1` 替换历史记录,而不是单一的全历史摘要分支。检查点携带被逐出前缀的可移植摘要加逐字保留的最近回合(最新的完整 Agent Loop,当该循环本身过大时回退到其最新的完整供应商/工具轮),因此连续性在压缩后存活,而不把生成的摘要文本当作当前的宿主权威。原始的只追加转录在检查点上方为转录、`/rewind` 与审计保持完整;供应商可见历史在最新的有效检查点重置并重放其后缀。重复压缩把前一摘要与仅新逐出的回合合并,从不重新摘要未更改的保留尾部;供应商失败、畸形载荷或追加错误让先前的头保持活动可用。检查点两侧的恢复与 `/rewind` 重现精确的替换。选轴的 `/rewind` 摘要(`Summarize from here`)保持其独立的压缩摘要分支行为。

- **带基于时间的 `auto`、项目持久化与启动标志的四值主题偏好(#85、#86、#87)。** 日/夜主题现在暴露四值偏好域:`dark` 与 `light` 强制调色板,`default` 跟随终端自身报告的浅/深模式(终端报告之前为深色),`auto` 为本地时间自适应 —— 07:00–19:00 浅色,其余深色。旧 `auto` 含义没有兼容别名;既有的 `/theme auto` 与 `VESICLE_THEME=auto` 现在跟随时钟。边界调度器为每个渲染器生命周期拥有一个计时器:进入 `auto` 时把下一个本地 07:00/19:00 严格排在现在之后,边界回调从实际当前时间重新解析并重排(因此睡眠后延迟触发会自我纠正),离开 `auto` 取消计时器。终端报告只影响 `default`;计时器只影响 `auto`。`/theme` 报告偏好、来源与已解析的模式(`auto` 时还有下一边界)。(关闭 #85。)
- **项目主题持久化(`.vesicle/preferences.yaml`)。** 项目根下一个带版本的本地忽略文件存储 `theme` 字段:要求 `version: 1`,`theme` 只接受 `dark`/`light`/`default`/`auto`,未知字段无效,且该文件从不被 git 跟踪。有效来源的优先级为会话 `/theme` > 启动 `--dark`/`--light` > 项目 `.vesicle/preferences.yaml` > `VESICLE_THEME` 环境变量 > 内置 `default`。`/theme <pref> --persist` 原子写入并在本会话应用;`/theme --unset-project` 移除项目主题、清除会话覆盖并重算。读取与写入都拒绝符号链接目标;畸形/无效的既有文件从不被静默覆盖。`/new` 与恢复另一个会话清除临时的会话覆盖并重算启动偏好;主题从不进入会话 JSONL。无效的 `VESICLE_THEME` 或无效的项目文件呈现一条有界诊断并回退到较低优先级的来源,而不是阻塞启动(无效的环境值不再被静默重新解释为 `auto`)。(关闭 #86。)
- **`--dark` / `--light` 启动标志。** 类型化启动解析器上的仅长选项、进程范围的初始主题偏好。重复同一标志幂等;同时提供两者是显式的解析器错误;顶层 `--` 结束识别,其后的标志是字面操作数。这些标志在裸/路径启动、`--` 终结符形式、`launch [path]`、`dev` 与 `setup` 上接受,被 `--version`/`--help` 以及 `doctor`/`once`/`prompt`/`quality`/`assets`/`debug` 以动作特定的消息拒绝。偏好经显式的类型化选项传递(而非 `process.env` 变更):`RunTuiOptions` 与引导 Setup 接收它,项目目录子启动精确转发相应的标志一次。之后的 `/theme` 会话覆盖仍具有更高优先级。(关闭 #87。)

### 变更

- **开发者文档现在有显式的公开/本地边界。** 被跟踪的 `docs/dev/` 树是自包含的公开契约层并有了完整索引;被 gitignore 的 `dev/docs/` 树是计划、私有参考上下文、决策与归档的从属机器本地工作台。贡献者指南现在定义晋升、命名、权威与生命周期规则,使这两条相似路径不能静默互换。

- **Quality Guard、Stage 与视觉语言的新公开开发者与品牌契约。** Output Quality Guard 的交付策略运行时、Stage 消费 Engine 的引导与渲染契约,以及品牌视觉设计语言各自获得单一的权威公开属主(`docs/dev/QUALITY_GUARD.md`、`docs/dev/STAGE.md` 与 `brand/VISUAL_LANGUAGE.md`)。此前仅由内部笔记承载的结论 —— 产物侧栏焦点(`Alt+A`)、资产分层与会话身份不变量、提示投射边界、OpenTUI/Solid 前端选择与升级边界、提示覆盖自定义界限,以及品牌签名时刻 —— 被提炼进其所属的公开契约(`docs/dev/TUI.md`、`ASSETS.md`、`SESSIONS.md`、`ARCHITECTURE.md`)与双语命令速查。`docs/dev/QUALITY_BENCHMARK.md` 与 `docs/dev/SKILLS.md` 去掉了历史 PR/Alpha 与未来阶段的路线图措辞,改为当前的命令与能力边界。其有效结果已完全由这些公开属主承载的内部决策记录按标准历史头归档;一份长期的内部设计记录带显式的内部决策元数据保留。没有运行时行为、命令或配置变更。

- **`/quality` 是一个状态感知的设置流程;`confirm` 步骤与 Rewrite 重入已移除。** 实验性 Semantic Judge 的配置面不再暴露宿主配置语法,也不再以第二个斜杠命令重复确认。`/quality`(无参数)打开状态感知的选择器,显示当前模式、有效或保留的 Judge Profile 与一个次要的 `Change Judge` 动作;它标记当前模式而不是总从 Off 开始,并记住最后一个完整的供应商/模型/超时三元组。关闭 Judge(或 `/quality off`)现在把该三元组保留为休眠 Profile,关闭期间发出零个 Judge 请求;首次使用且无保留 Profile 时,活动注册的供应商/模型被可见地预选(UI 默认后跟显式动作,绝不是静默的运行时回退)。裸 `/quality observe` 在存在保留的有效 Profile 时立即启用 Observe,否则在选择器上打开 `Review only`;裸 `/quality rewrite` 对有效的保留 Profile(或首次使用无保留三元组时的活动模型)打开仿照 `/permissions YOLO` 的红色两阶段确认面板,并在保留的 Profile 不再解析或缺少其密钥时路由到选择器(Enter → Continue → Enable Review and Rewrite;任一阶段的 Esc 是无操作)。`/quality rewrite <provider> <model> [timeout-ms]` 用这些精确值暂存同一面板,并在打开之前验证 1000–180000 ms 的超时边界。`/quality confirm ...` 作为无效用法被拒绝且无变更。过期或缺密钥的保留三元组从不被静默替换:选择器要求显式的 `Change Judge` 选择后 Observe 或 Rewrite 才能启用,`Change Judge` 浏览期间不写入任何东西,直到提交一个模式动作。Off 把当前候选提交为休眠 Profile(仅当已关闭且 Profile 未变时为无操作)。验证在 Rewrite 面板打开之前运行,并在最终写入之前立即重验。

- **`quality.yaml` 版本 2 保留休眠的 Judge Profile。** 设置文件现在写入 `version: 2`;既有的 `version: 1` 文件仍完全照旧加载,首次设置更改会把它们重写为版本 2。版本 2 允许 `mode: off` 携带一个完整的供应商/模型/超时三元组(或不携带),因此禁用 Judge 不再破坏有效的选择;`observe` 与 `rewrite` 仍要求完整的三元组,部分三元组被拒绝,超时边界(1000–180000 ms)与未知字段拒绝不变。无论是否保留三元组,`loadExperimentalQualityProfile()` 对 `off` 仍立即返回 `undefined`。版本 2 是 Alpha 时代的前向迁移;较旧的 Vesicle 构建可能无法读取。双语的 `quality-guard` 与 `commands` 参考、`configuration` 页与 `docs/examples/quality.yaml` 已更新为以裸 `/quality` 领衔并记录休眠 Profile。

- **捆绑 Harness 的版本/SHA 不再作为字面量粘贴在各文档与测试中(#95)。** `prism-engine-v10@<version>` 戳记与计算出的 manifest SHA-256 已从 `README.md`、`README.zh-CN.md`、`STATUS.md` 与 `docs/dev/ASSETS.md` 移除;这些文档现在引用捆绑的 V10 基线并指向 `harness-manifest.json` 作为唯一真源。`tests/integration/harness/harness.test.ts` 中的捆绑解析测试现在对照 manifest 自身的值断言解析出的 Pack 版本与 manifest SHA,而不是粘贴的字面量,因此 Harness 升级不再强制跨文档与测试的手工字面量同步。运行时本来就只从 manifest 读取这些值,因此没有行为变更。(自动获取 upstream 的 Harness 发布仍是独立的更大后续项。)

### 修复

- **校验器现在报告机械确立的结构而不是关键字猜测(#124)。** 模块 A 不再使用小型双语关键字表判断 Variant 轴是否有正向开场或软化方向。模块 A/B 的 frontmatter 被解析为 YAML 并检查允许、必需、类型、非空与重复字段;模块 A 的小节/子小节恰好一次、有序且非空并带范围化的 `Hard limit:` 条目,而模块 B 强制列表形状的类型化节拍图、普通单行的 `world_state`、可见的开场与恰好一次有序/非空的逻辑评论小节。运行时/Stage 校验现在检查范围化的 Neural Chain 字段、独立有序的 HUD 行、变体分离与非空正文,而不是接受任何位置的 token;Evaluate 要求一个独立的判决加五个恰好一次有序/非空的小节;L-System 拒绝列表包含独立的 `L4` 而不误分类 `L4-A/B`。两个卡片校验器还为已识别的产物镜像显式的 `zh-f1-not-x-but-y` 词法策略,并把 `不是……而是……` 报告为建议性警告。普通的 ETL 正文仍在产物校验器的适用范围之外;此变更不添加 Quality Guard 绑定、自动重写、供应商调用或交付门。

- **Skills 运行时阶段 1 的后续修复。** 阶段 1 安装/生命周期面中的正确性与持久性修复。跨进程的活动索引更新现在使用 SQLite `BEGIN IMMEDIATE` 事务而非 PID/令牌锁文件,消除了创建/写入与过期回收的竞争,同时让操作系统在崩溃之后释放所有权。`uninstall` 报告版本家族的删除失败并保留活动索引条目以便直接重试,而不是在文件残留时声称成功。`listSkillVersions` 跳过被中断的 `.staging-*` 目录与没有来源侧车的版本目录,因此 `rollback` 永不能把活动版本重指到半复制的树。GitHub 获取此前以完整的父环境且无超时派生 `git`/`tar`;两者现在都以项目的过滤进程环境(`buildProcessEnvironment`)运行,远端 tarball 的解压在有界超时与截断输出捕获下运行。`<ref>` 含斜杠的 `/tree/<ref>/<subpath>` GitHub URL(例如 `feature/integrate`)不再被截断到第一段 —— 解析器逐段尝试更长的 ref 前缀,直到某一个解析为提交。仓库名不是小写 Skill 名(大写、下划线、点)的 GitHub 根 Skill 现在可以安装,因为解档的根被重命名为声明的 `SKILL.md` `name` 而非仓库 slug。`vesicle skills update` 从记录的来源重新应用 `--include-worktree`,因此从脏工作树快照的 Skill 可以刷新。`vesicle skills list` 不再因损坏的 Skill Store 索引或来源侧车而中止:列表降级为 “installed unavailable” 通知并仍显示 harness/user 范围,镜像 `vesicle doctor` 已使用的守卫。

- **Workspace 状态指示器:无重复/过期/错误归属的校验、诚实的提示、80 列状态(#118)。** Workspace 页的状态行不再向校验摘要追加焦点特定的动作,因此 Alpha.6 的 `… · v view · v view` 重复消失。`validationSummary()` 现在是纯状态 —— `✓ validators passed` / `✗ N · ⚠ M` / `validation stale` / `no validator matched` —— 由组件决定在其自身焦点内哪个单一动作可达(树中 `v validate`,查看器中 `v findings`)。每个非待处理的校验快照现在拥有其描述的项目相对路径,经一个控制器助手在打开、查看器重载、保存/强制保存、外部编辑器返回、显式 `v`、删除/关闭清除与重命名/移动重键时安装,因此树选择永不穿戴另一个文件的判决,发现面板的头部标识其目标。脏的编辑器缓冲把其先前的判决投射为中性的 `validation stale`(无旧颜色或计数);撤销回干净恢复它,保存/重载安装新鲜的当前判决。树焦点 `v` 现在校验所选的行(消费已当前的快照而不是重跑),以 `save <path> before validating` 拒绝脏缓冲,并在目录或空选择上以 `select a file to validate` 保持关闭。模式与可编辑性使用不同的术语(`preview` / `source view` / `viewer` 加 `m edit` / `m source` / `m preview`),其中 `m edit` 要求实际准入的可编辑缓冲(`canEditOpenFile`),因此全脏 LRU 的拒绝、超大/截断/只读的 Markdown、仅元数据的符号链接或普通的图像/二进制文件都只通告真实的操作。`Enter jump`(状态行与发现面板页脚都有)与跳转处理器本身要求同一个 `canJumpToSelectedFinding` 谓词,因此不可编辑的目标既不提供也不执行跳转。新的 `src/tui/workspace-status.ts` 拥有单行状态组合:它接收真实的内容宽度,在中截断路径之前先整段丢弃低优先级段,并保证该行永不超出预算,因此长路径或 CJK 路径不再能在 80 列把校验警告或破坏性的确认选项挤出该行。一次后续评审把控制器 `status()` 的文本(保存/重载/拒绝/外部编辑器/错误消息)在构建器重构曾丢失之后恢复到该行,把状态颜色绑定到聚焦的目标以匹配路径绑定的文本(因此在树中离开被校验的文件不再为另一个文件的判决画红线),让 `Enter jump` 在面板描述的文件与打开缓冲不同时拒绝(不再跨文件行跳转),停止在脏预览模式的 Markdown 上通告 `v findings`,在窄宽度硬截断发现面板的头部,在逐键组合路径上缓存逐段宽度,并在紧凑与 Workspace 冒烟之间共享 PTY 冒烟的 ANSI 剥离器与 YAML 夹具。一次用户视角的评审随后把发现面板的快照复用门控到文件存储的磁盘身份(mtime+ino),并在被删除文件拥有快照时清除它,因此同路径的删除后重建或外部重写文件不再能继承过期的发现;重排 `composeStatus` 使每级丢弃之后收缩路径,因此长路径或 CJK 路径被压缩而不是在真实的 79 列预算下挤掉中等 `m`/`v` 动作;让 PTY 冒烟真正移动树选择并诚实地覆盖其声称的行为(跨选择契约由路径绑定的组件测试断言);并把本地计划/路由权威同步为“实现完成”。经聚焦的控制器/组件测试、56/80/100/140 列的宽度投射单元套件,以及 80 列与更宽尺寸的真实 PTY 冒烟验证。(关闭 #118。)

- **干净的自动校验通过不再打断消息流(#111)。** 无错误且无警告的通过自动校验器检查 —— 最明显的是匹配每个合规 Stage 回合的 `runtime-packet` 检查 —— 不再向主消息流追加 `Validation passed: ✓ …` 卡。校验器仍在每个适用的回合运行,仅宿主的 `kind: validation` 审计记录仍被持久化;干净的结果在活动日志中保持可观测。有错误的校验仍产生消息流卡与 `complete with validation findings` 状态;仅警告的通过(`ok: true` 且建议性警告)仍产生卡并获得独立的 `complete with validation warnings` 状态行,因此建议信号不被隐藏。供应商可见历史不变(校验记录本就仅宿主),用户发起的 `/validate` 仍经独立路径渲染其自己的显式通过/失败通知。(关闭 #111。)

- **自动压缩的补充评审加固(#109、#110、#112、#113)。** 实时的回合前压缩现在立即替换当前进程的供应商历史,而不是继续使用调用方检查点前的过期消息,重复压缩保留前一检查点逐字的保留尾部。每个正常的供应商请求现在在排队输入与已完成的后台进程通知物化之后通过一个精确的硬上限守卫,包括已恢复的门/权限/问题/质量续接的首个请求与成功软压缩之后的请求。供应商用量与该请求的宿主估计配对,因此后续的投射只加之后的增长;估计包含活动的工具 schema。生成的替换在检查点安装之前重估,当它未能削减下一请求或仍高于硬上限时,在不更改头的情况下被拒绝。检查点安装使用跨 Vesicle 进程保护的期望头条件追加,持久化的替换消息经验证失败关闭,静态无效的预留组合在供应商配置加载时被拒绝,`/context` 使用活动模型的生成默认值,取消发出 `compact_cancelled` 而非失败。手动压缩现在拒绝每个未解决的权限、委派与质量交互,以及门与问题。

- **压缩后空会话 Hero 的回归(#107,PR 2/4)。** `/compact` 此前把压缩后的会话错误分类为空:压缩摘要与 `Conversation compacted into a summary (N messages).` 完成行作为固定的空会话 Hero 通知渲染在居中的品牌标记之上,长摘要文本与标记重叠,鼠标滚轮够不到它们,发送下一条消息使主聊天区域空白,直到 `Ctrl+O` 页面切换重新挂载它。压缩摘要现在经显示投射保持 `compact-summary` 显示类别,空会话 Hero 的不变量从显式的对话契约(任何用户提示、assistant 回复、工具活动或压缩摘要)派生而非“每个可见角色都是 system”,因此压缩摘要或任何回合保持转录挂载,真实的启动通知(例如 YOLO 警告)在对话存在之前仍渲染在 Hero 上方。经 80 列与更宽尺寸的真实 PTY 冒烟验证。

- **浅色主题的 Markdown 代码块保持可读。** 共享的 Markdown 表面现在把活动主题的前景传入 OpenTUI,防止无标签的围栏代码块在浅色背景上回退为白色文本。挂载的 Markdown 可渲染对象也在 `/theme` 或终端自动检测更改活动主题时刷新其基色与语法样式,因此从深色切换到浅色不再留下过期的深色主题样式。
- **供应商失败现在在 TUI 中可见并分类。** 非 2xx 的供应商响应此前在侧栏状态行塌缩为裸红色 `error`,而实际原因 —— HTTP 状态、供应商消息 —— 被丢弃:状态被设置为字面字符串 `"error"`,宿主的 `output` 信号曾被只写连线(其 getter 在创建时被丢弃,因此从未有东西渲染它),失败被作为普通的 `Error:` assistant 消息推入转录。宿主现在把任何抛出的供应商失败归约为结构化摘要 —— 类别、HTTP 状态、供应商 id、可重试性与净化后的消息 —— 从 `ProviderError` 派生并在 OpenAI 兼容、Anthropic Messages 与 Gemini 适配器之间共享。侧栏状态行显示分类(例如 `error · mimo · 402 · payment required`),转录渲染专门的红色失败卡,带类别标题、可操作的提示(payment required / provider auth failed / rate limited / transient / …)与有界的供应商消息 —— 而不是 `Error:` assistant 行。供应商失败也不再把用户刚发送的消息从转录回卷进输入框(该副作用曾让空会话的 hero 卡在屏幕上,因为只要每条可见消息都是 `system` 角色,hero 就会显示);用户消息保持原位,失败卡出现在其后。供应商提供的消息在到达 UI 之前剥离控制字符并截断到 240 字符,因此无界或恶意的响应体不能破坏布局。侧栏状态行现在点名供应商;Unicode 格式与双向覆盖字符也被剥离;同一宿主路径捕获的非供应商错误(本地命令、配置/权限加载、门或权限解析)回退为普通系统消息而不是供应商失败卡,因此代码或文件系统错误不再被误标为 “provider error”。对主聊天回合,传输层的重试循环(408/429/5xx 与网络错误,在 `fetchProvider` 中)现在也可见:每次重试发出 `provider_retry` 事件更新侧栏状态行(`retrying · attempt 1/2 · HTTP 429`)与活动日志,以一目了然的进度行取代退避期间的沉默。可重试的供应商失败(限流或瞬态)也恢复输入框草稿与粘贴的图像,使“重发”提示可操作,同时仍把用户消息留在转录中。同一宿主路径捕获的非供应商错误回退为普通的红色 `host-error` 系统消息,永不触发空会话 hero。重试逻辑保持单源于传输层 —— UI 只观察它;它不运行第二个重试循环。(关闭 #98。其两个延后后续随之一同落地 —— 非主聊天供应商调用的传输重试可见性(#101)与恢复时调和会话中遗留的失败用户回合(#102);见下面专门的条目。仍延后:卡内的手动重试按钮,以及调和失败的续接回合 —— 门、用户问题、Engine 切换与权限的解决会在可失败的供应商回合之前追加用户后续(与工具结果),尾部的工具结果在恢复时仍可能呈现为连续用户交替错误。)
- **传输重试的可见性扩展到每个非主供应商调用(#101)。** 为主聊天回合添加的 `provider_retry` 面现在覆盖 `/init`、`/compact`、`/btw`、SubAgent 子回合与实验性的 Semantic Judge。每条路径把单源的 `fetchProvider` `onRetry` 回调转发到正确的位置:`/init` 与 `/compact` 更新自己的状态行与活动日志,`/btw` 在加载时于其覆盖层显示 `retrying · attempt 1/2 · HTTP 429`,SubAgent 的重试经 agent 进度通道从父活动日志呈现,judge 的重试作为范围化的 `provider_retry` 事件发出,只进活动日志以免冲掉主聊天的状态行。重试决策仍只存在于传输层;没有任何站点运行第二个重试循环。(关闭 #101。)
- **失败的用户回合不再以连续同角色消息破坏恢复(#102)。** 当新的用户回合的供应商轮在任何 assistant 回复之前失败时,宿主在已持久化的提示之后追加仅宿主的 `failed-turn` 标记(提示按 #98 的设计留在转录中)。历史投射现在丢弃失败回合尾部的用户输入 —— 提示,加任何宿主注入的用户输入(如后台进程结果或质量重写反馈)—— 因此恢复或重发不再发送会被 Anthropic Messages 以交替错误拒绝的两条连续用户消息。`/compact` 摘要是穿过该标记的唯一已完成操作边界;循环中途的失败(assistant 已回复)留下有效的交替尾部且不被标记。失败的提示仍留在会话中供转录与 `/rewind`,在那里被标记为无回复的幽灵。(主用户回合关闭 #102。仍延后:失败的续接回合 —— 见 #98 条目。)
- **统一的剪贴板图像粘贴输入。** 裸 `Ctrl+V` 键盘事件现在进入既有的剪贴板图像附件流程,同时 Alt/Option+V 保留为兼容路径,包括注入 `Ctrl+V` 控制字节的 WSL 终端。终端文本与括号粘贴仍走独立的文本粘贴路由,活动的模态、选择器、门与 Workspace 表面保留键盘所有权。
- **Workspace 文件安全的后续。** 外部更改检测现在同时比较 mtime 与 inode 身份,因此同时间戳的替换仍会在覆盖之前询问;项目相对的预览/stat 路由共享编辑器的绝对/遍历/NUL 守卫;符号链接保持仅元数据而不加载其目标;脏缓冲的保存/关闭动作在途时键盘输入保持所有权。树高度的接线现在显式在挂载之后附加,而不是依赖 ref/effect 的时序。

## [1.0.0-alpha.6] - 2026-07-26

### 修复

- **npm 安装的交互式启动现在使用预编译的 Solid TUI 运行时。** 包启动器执行生成的 JavaScript 而不是 `node_modules` 下的裸应用 TSX,因此全局与本地的 npm 安装不再落到 React 的 `jsx-dev-runtime`。包资产、稀疏覆盖、OpenTUI 原生包、解析器 worker、调用 cwd 与显式的项目目录启动保留既有行为。
- **npm 消费者获得干净的生产依赖树。** 移除未使用的 `@opentui/keymap` 依赖;`@opentui/solid` 与对齐的 `solid-js@1.9.12` 是仅构建依赖并捆绑进生成的运行时。这从已安装的生产依赖中移除了无效的 Solid peer 关系与被弃用/被审计的 Babel → module-resolver → glob 链。
- **发布门现在演练宣传的 npm 旅程。** 包冒烟把精确的 tarball 安装进隔离的全局前缀与本地 lockfile 消费者,拒绝 npm 警告与无效树,要求干净的生产 audit,检查检出之外的包资产与 tree-sitter,并在 Linux PTY 中经调用 cwd 与显式项目参数启动全局命令。Windows CI 安装同一 tarball,验证其选择的原生运行时与诊断,并把真实的 Solid/OpenTUI 应用有界地挂载然后干净地销毁,作为有界的 TUI 引导。

## [1.0.0-alpha.5] - 2026-07-25

### 新增

- **外部编辑器交接(TUI,Scope B 里程碑 B5)。** 任何 Workspace 焦点区域上的 `Ctrl+X` 挂起 TUI 渲染器并在你的真实编辑器中打开当前文件(或树选择),然后恢复并对其所作所为作出反应。编辑器解析遵循 git 的顺序:`$VESICLE_EDITOR` → 新的用户级 `settings.yaml` `editor:` 字段 → `$VISUAL` → `$EDITOR` → 平台回退(POSIX 上 `vi`,Windows 上 `notepad`);命令行带引号感知地拆分(因此 `code --wait` 可用),文件路径作为独立的 argv 元素传递,绝不经过 shell。有未保存编辑的文件被拒绝并指向 `Ctrl+S`,因此外部写入不能静默覆盖你的缓冲。返回时:mtime 移动过的打开缓冲被重载(经 `replaceText` 保留撤销)并像保存一样重新校验;未更改的文件报告“无变更”;被编辑器删除或替换为符号链接的文件被关闭;只在树中的文件仅刷新目录缓存与索引。只读、图像与二进制文件也可以交接 —— 编辑器如何处理它们是它的事。Scope B 现已完成(Git 按裁定排除;输入框的重设计是独立里程碑)。
- **用户级 `settings.yaml`。** `providers.yaml` / `permissions.yaml` 旁边一个新的、刻意微小的用户配置(相同的 `key: value` 行格式,`version: 1`)。B5 读取 `editor` 字段用于外部编辑器;该文件是未来用户设置(#86 主题持久化,…)的保留家园,因此未知字段被忽略。
- **Workspace 页文件管理 + 页内校验(TUI,Scope B 里程碑 B4)。** 文件树现在是真正的文件管理器:`a` 创建文件,`A` 创建目录(路径输入条、自动 `mkdir -p`、拒绝覆盖),`m` / `F2` 重命名或移动,`c` 复制(移动/复制条预填目录前缀,使你就地输入新名),`d` 删除 —— 每个目标都有项目根边界(拒绝 `..` 与绝对路径),破坏性操作经确认对话框路由(移动/复制到既有目标询问覆盖/取消;删除询问 `y`/其它任意键取消,并在条目有未保存编辑时注明)。删除是移入 `.vesicle/trash/<timestamp>-<name>` 的回收站移动(已在树的隐藏列表中,永不提交),不是永久移除;目录只在为空时移除,因此一次按键不能丢掉子树;状态行显示回收站路径以便手工恢复。重命名或移动编辑器中打开的文件会就地重键缓冲 —— 脏标记与内容存活,磁盘文件移动,树刷新。共享的 `ARTIFACT_VALIDATOR_NAMES` 常量现在支撑回合终结器的自动检查、`/validate` 与新的 Workspace 校验面,因此三者不会漂移。打开或保存卡时自动运行校验器;`v`(树/只读查看器焦点)打开发现面板,列出每个 `✗`/`⚠` 及其校验器,可用 `↑↓` 导航,`Enter` 跳到发现的行(经消息文本的事后锚点扫描解析 —— `## …` 小节头或被引用的 frontmatter 键 —— 当发现是关于缺失内容时,回退到 frontmatter 结束处并标记 `(no anchor)`)。状态行汇总校验(`✓ validators passed` / `✗ N · ⚠ M · v view` / `no validator matched`)并按严重性着色,同样的升级适用于新的文件操作确认。可编辑源中的 `v` 仍输入字符(它是可打印键),因此那里的手动校验经保存触发。
- **Workspace 页编辑器(TUI,Scope B 里程碑 B3)。** 源模式现在是构建在 OpenTUI 文本区上的真正编辑器(每个打开的文件一个实例,保持挂载使每个文件保留自己的撤销历史)。512 KB / 2000 行以下的文本与 Markdown 文件可编辑打开;Markdown 仍默认预览,`m` 切换到可编辑的源。`Ctrl+S` 保存(原子 temp+rename、项目根边界、拒绝 `..` 与绝对路径);`Ctrl+Shift+S` 另存为新路径;`Ctrl+Z` / `Ctrl+Y` 撤销/重做(自定义键绑定,因为文本区默认的 `ctrl+-` 撤销在传统终端上失败);`Ctrl+F` 查找(纯文本匹配,`Enter` / `Shift+Enter` 循环,活动的匹配被选中);`Ctrl+G` 跳转到某行;`Ctrl+R` 在外部更改之后重载;`Tab` 插入两个空格;脏缓冲上的 `Esc` 询问 “save / discard / cancel”。缓冲池容纳至多 8 个文件(LRU、脏保护 —— 如果八个全脏,第九个以状态说明只读打开),脏状态是 plainText 对快照的比较,因此撤销回干净清除圆点,外部修改经 mtime 检测:每次保存之前(不匹配打开“覆盖/另存为/取消”确认)与页面重新激活时(被更改的缓冲获得标记且可重载)。单行的编辑器状态行(文件、脏 `●` / 磁盘已更改 `†` 标记、`Ln:Col` 与键提示)位于查看器与 shell 底面之间,树聚焦时切换为树提示并按严重性升级颜色 —— 脏/覆盖/重载确认与磁盘更改通知为琥珀+粗体,失败(被拒的另存为、磁盘上消失的文件、全缓冲脏的上限)为红+粗体,保存/重载确认为祖母绿,普通提示为暗色。图像、二进制、符号链接、超大与只读文件留在只读查看器;模型可见的文件工具未被触碰(编辑器由人驱动,因此其路径策略是项目根边界而非限于可写子根)。

- **Workspace 页文件树、查看器与快速打开(TUI,Scope B 里程碑 B2)。** Workspace 页现在是真正的工作台:项目文件树(惰性目录加载、展开/折叠、`r` 刷新、`.` 切换点文件与 `.git`、`node_modules`、`dist` 等嘈杂条目)、只读查看器(带编号的源行、Markdown 在 `m` 上的源/预览切换、图像与二进制文件的元数据卡、符号链接与只读标志、预览以 512 KB / 2000 行为界),以及带子序列模糊匹配索引文件的 `Ctrl+P` 快速打开。键盘模型有三个焦点区域 —— 树、查看器、输入框 —— 经 `F6` / `Shift+F6` 循环并用 `Esc` 退绕(查看器 → 树 → 输入框);可打印的快捷键只在其聚焦的区域动作,绝不与输入框冲突。`/workspace [path]` 跳到该页并在树中定位文件或目录;`/artifact` 现在在此查看器中打开产物(见变更)。
- **双页 shell 骨架:Chat / Workspace(TUI,Scope B 里程碑 B1)。** shell 现在有两个顶层页面:既有的聊天表面与新的 Workspace 页(issue #62 —— 键盘优先的项目文件工作台;B1 交付带占位符的页面骨架,显示项目根,文件树与编辑器在 B2/B3 落地)。`Ctrl+O` 从任何非模态表面切换页面,`/workspace` 跳到 Workspace 页(即时类命令,Agent Loop 繁忙时也可用)。头部是页面感知的(Chat 中为 Engine 折射强调色,Workspace 中为带项目根的品牌祖母绿);门/权限/选择器表面仍在底部共享,因此回合的安全提示在任一页都可达。页面状态活在组件树之外,永不触碰会话 JSONL、检查点或回退。左侧栏从 `Workspace` 更名为 `Host`,以区别于 Workspace 页与 `workspace/` 目录(其七个运行时小节不变)。
- **带终端自动检测的日/夜主题(TUI)。** shell 现在在石墨深色调色板旁携带浅色调色板:暖纸底(`#f5f4f0`,永不纯白),每个文本角色、Engine 强调色与状态色都为 WCAG AA 对比度重新锚定,包括锁定紫色 `#7c3aed` 的 Stage 引擎。品牌标记、启动光与语法高亮都有匹配的浅色变体。解析顺序:会话的 `/theme dark|light|auto` > `VESICLE_THEME` 环境变量 > 终端自动检测(默认;shell 在启动时查询终端自身的模式并跟随实时的 `theme_mode` 更改)。该偏好从不持久化。
- **启动启动画面与空会话 Hero(TUI)。** 启动现在以 ANSI 派生的 prism-vesicle 品牌标记与 `PRISM VESICLE` 字标开场,外加一束沿囊膜缓慢移动的光;它在供应商配置就绪后淡出(永不阻塞启动),在首次按键时立即结束,并无残留地消失。空会话在消息区显示安静的品牌 Hero —— 紧凑标记、标语与一条入门提示 —— 而不是裸的 `Ready.` 系统通知;首个对话回合用真实的转录替换它。启动画面按终端能力降级:非交互终端跳过,256 色终端获得静态量化帧,`VESICLE_REDUCED_MOTION=1` 冻结帧并停止光。所有应用内的标记派生自 `brand/prism-vesicle.ascii.txt` 并从锁定的调色板重渲染;启动画面之下不存在任何连续动画。
- **侧栏 ASCII 框小节标签(TUI)。** Workspace 侧栏的内部小节(Status、Agents、Shell、Effort、Session、MCP、Artifacts)现在使用克制的 `┌─ Title ─` 框标签母题而非裸粗体文本。逐消息的角色光谱车道与逐 Engine 的折射强调色此前已接入消息流与头部;这完成了静态母题的遍历而无布局更改。

### 修复

- **后台挂载缓冲的 Workspace 编辑器换行宽度不再过期。** 编辑器池的实例隐藏挂载(`display:none`),OpenTUI 在那里跳过 `onResize`,文本区的 EditorView 保持其 80 列构造回退 —— 缓冲变为可见之后(例如 Markdown 预览 → 源),软换行点落在意外位置,行号槽可能在编辑之后与视觉行不一致。页面现在在缓冲每次变为可见时把 EditorView 的视口重新同步到布局尺寸。
- **Workspace 编辑器的文本区不再塌缩到内容宽度。** 没有显式尺寸时,Yoga 按内容为文本区定尺寸 —— 空或小文件把编辑器塌缩为 1 列视口,因此每个输入的字符都把该行滚出视野。文本区现在填满查看器(`100% × 100%`),并有组件回归测试。
- **Workspace 编辑器不再在查看长行之后截断较短行的开头。** 行长于视口时 OpenTUI 文本区向右滚动以保持光标可见,但光标移到较短行时它让水平偏移(`offsetX`)过期 —— 较短行以其开头在屏幕外渲染(看似空的行,或从词中开始的文本)。编辑器现在在光标落在首视口宽度的列内时把 `offsetX` 拉回 0,覆盖导航键(方向键 / Home / End / PageUp / PageDn / Enter / Backspace / Delete)之后与 find / goto / findings 跳转之后。长行上的输入不受影响(光标在那里保持在视口之外,因此重置永不触发)。
- **Workspace 页不再涂画到输入框之上。** 页面使用忽略动态尺寸底面(输入框/门/选择器)的显式高度,因此长文档的底部行与输入框重叠。页面现在弹性填充主行,树窗口跟随树面板的测量高度。

### 变更

- **捆绑 Harness 更新到 `prism-engine-v10@10.1.2`。** 已验证的 73 文件基线现在包含更强的 ETL 场景钩生成正面指南,以及 Chapter Reviewer 对章级张力、伏笔与 Chekhov's Registry 连续性的扩展检查。Harness 契约与所需的 Vesicle 能力不变。

- **品牌源资产被跟踪;二进制资产现在经 Git LFS。** `brand/` 目录 —— SVG 标记(主、浅、单色、动画)、1024² 深/浅 PNG 导出、ASCII 方案与治理调色板和用法的 README —— 现在被提交为 Prism Vesicle 标记的规范来源(应用内启动画面与空会话 Hero 已派生自 `brand/prism-vesicle.ascii.txt`)。二进制多媒体(图像、视频、音频、字体)经 `.gitattributes` 全仓库路由通过 Git LFS,从两个 PNG 导出开始;文本资产(SVG、Markdown、ASCII 方案)以 `eol=lf` 留在普通 git 中保持可 diff。`brand/` 被排除出 npm 包(不在 `files` 中),因此 LFS 永不触碰已发布的 tarball。被跟踪的 `.githooks/pre-push` 现在也在 lint 检查之后运行 `git lfs pre-push`,因此贡献者需要安装 `git-lfs`(克隆后一次 `git lfs install`)。

- **Workspace 编辑器软换行长行(VSCode 风格)。** 编辑文本区现在使用 `wrapMode="word"`:超宽的逻辑行在下一视觉行继续并带空槽,而不是水平滚动,编辑器的全宽总是可用。(文本区默认的水平滚动边距也会在右缘之前约 20% 就开始滚动 —— 有软换行后根本没有水平滚动。)
- **Workspace 页的键别名(cc-switch-cli 键位评审)。** `q` 像 `Esc` 一样精确退绕焦点,`hjkl` 在树与查看器中充当方向键(文本输入持有键盘时永不),文件行上的 `→` 打开文件并把焦点交给查看器。为编辑器里程碑冻结:脏缓冲的 Esc 询问“关闭前保存?”,键绑定一旦批准即冻结(危险动作获得确认对话框而不是重绑定),Tab 插入缩进。
- **`/artifact` 在 Workspace 查看器中打开产物。** 裸 `/artifact` 跳到 Workspace 页并打开最新的产物;`/artifact <n|path>` 解析目标并在那里打开它。消息流的预览卡退役;校验(`/validate`)与修订流程不变。
- **TUI 调色板与锁定的品牌调色板对齐。** 一次颜色审计解决了深色主题中的三个身份冲突:assistant 的角色色与 Stage 引擎的强调色字节相同,警告的沙色混入 assistant/stage/evaluate 集群,用户的光谱车道使用偏离品牌的 SaaS 蓝。`assistant` 现在是去饱和的暖纸色,`warn` 与门的边框使用锁定的琥珀,`success` 使用锁定的祖母绿亮,`error` 是区别于 weaver-orch 玫瑰的更深警红,用户车道是与角色文本匹配的暗青。Stage 引擎的强调色从暖金移到锁定调色板的紫色家族(`#8b5cf6`)—— 金色与 evaluate 的黄色只差 5° 色相;紫色是最后一个未使用的锁定色相,契合叙事引擎的舞台光身份。六个折射 Engine 的强调色不变。
- **TUI 表面迁移到中性石墨。** shell 的背景、边框与中性文本阶离开遗留的冷蓝家族,转向近零色度的石墨(`#121415` 底,色相 ≈ 200°、色度 ≤ 8%)—— 暖深底在终端尺度下显脏,旧的蓝黑读作泛型的 IDE 镀铬。语法高亮的中性色跟随同一阶。

## [1.0.0-alpha.4] - 2026-07-24

### 新增

- **`read_instructions` / `update_instructions` 模型工具。** 模型现在可以在每个非 Stage Engine 上经两个通用的宿主工具读取并管理持久指令。`read_instructions`(观察)返回一个精确 `{ scope, engine }` 目标的内容、大小、哈希,以及它是否被当前 Engine 选中。`update_instructions`(变更)经指令存储写入或删除一个目标:原子写(temp + rename)、经 `ifMatchSha256` 的可选乐观并发(`"absent"` 或 64 位十六进制哈希;过期的值永不覆盖)、`.vesicle/instruction-backups/`(项目范围)或配置目录 `instruction-backups/`(用户范围)下的单个可恢复前状态备份,以及写前检查新内容加另一范围保持在变更影响的每个 Engine 的 32 KiB 预算内。空内容创建显式的空覆盖;删除恢复回退。目标是固定的 `{ scope, engine }` 枚举 —— 没有任意路径 —— 且活在模型可见的可写根之外,因此这是有界的宿主例外,不是放宽的文件系统面。`update_instructions` 经既有的工具权限运行时路由:MANUAL 与 INERTIA 经标准权限请求暂停,MOMENTUM 与 YOLO 立即执行。成功的更新刷新回合内冻结的指令快照,因此在同一回合的下一个供应商轮生效。Stage 按设计保持严格无工具。自定义统一 diff 的权限预览延后。
- **`/init [--force] [notes]` 项目初始化。** 扫描项目的可写根(`workspace/`、`source_materials/`、`novels/`、`reports/`、`test_runs/`),并以专用的宿主提示进行一次无工具的供应商调用来起草项目范围的 `VESICLE.md` —— 宿主每个会话自动加载的同一个持久指令文件。它是持久指令的伴侣:不必手工编写第一个 `VESICLE.md`,`/init` 播种精炼的草稿(项目概览、推荐 Engine、角色/情景约定、工作流与命名约定、非显而易见的坑),在下一回合生效,然后由你审阅与编辑。init 提示活在 Vesicle 的 host-assets 层,因此不需要来自 Neural-Narratology 的新 Harness。既有的 `VESICLE.md` 在供应商调用之前被拒绝;显式的 `/init --force` 在替换之前把普通文件备份到 `.vesicle/init-backups/VESICLE.md.previous`。`/init` 作为可取消的宿主动作运行(像 `/compact` 一样),独立于活动 Engine 的工作流。
- **持久指令。** 用户编写的 Markdown,自定义 Engine 的工作流并在新会话中存活 —— 宿主自动把它加载进系统提示,因此不需要让模型把规范写入文件并在下一个会话提醒它读取。文件活在两个范围,使用相同的名称:项目范围的 `VESICLE.md`(通用,每个 Engine)与 `VESICLE.<engine>.md`(Engine 特定覆盖)在项目根,用户范围在 `providers.yaml` 旁边使用相同的名称,跨每个项目根适用。一个范围内 Engine 特定的文件替换通用文件;跨范围用户文件之后跟项目文件,直接冲突时项目内容胜出。指令作为宿主上下文追加在字节一致的 Engine 提示之后 —— Engine 契约保持唯一的系统权威与稳定的前缀缓存前缀 —— 且只能在既有的宿主能力内自定义工作;它们不能添加工具、权限、门、校验器或文件系统权威。选择在顶层回合开始、进程重启之后的会话恢复与确认的 Engine 切换时从当前磁盘解析;单个回合内选择冻结,因此回合中的暂停与恢复观察一个稳定的指令集,编辑在下一回合生效。无效、链接或超大的范围被跳过并警告,回合继续,合并的所选内容以 32 KiB 为界。`vesicle prompt shape` / `prompt dump --engine <id>` 与 `/instructions` 命令显示有效的选择、来源、字节预算与诊断。
- **`vesicle --version` / `-v` 与 `--help` / `-h`。** 类型化的启动解析器现在把一次调用分类为终端动作(`--version`/`-v`、`--help`/`-h`)、子命令或项目启动。`--version` 打印构建时烙进二进制的包版本;`--help` 打印全局用法。短选项可捆绑(`-vh`),`--` 结束选项解析使连字符前缀的路径可用,`--dangerously-skip-permissions` 保持位置无关的进程标志。在源/npm 启动上 Bun 运行时会消耗前导的 `--`,因此在那里使用 `vesicle launch ./-path`;编译的二进制保留它。
- **`vesicle --resume` / `-r` [path]。** 启动修饰符,在启动时打开会话选择器,路由到与无参数 `/resume` 相同的宿主自有选择器 —— 打开选择器只是状态操作,在选择会话之前绝不开始供应商回合。`-r` 与其它布尔短选项捆绑;子命令与终端动作拒绝 `--resume`。
- **消息与命令队列。** Agent Loop 运行期间,Enter 把普通的文本与图像输入排队,在输入框上方显示有界的混合 FIFO 预览,并清除草稿以便继续输入。排队的消息在活动循环当前的完整工具轮之后、下一个供应商请求之前转向它。每个斜杠命令现在在命令注册表中声明必需的繁忙回合行为:安全的仅宿主命令立即运行,产物读取等待当前的工具轮,配置、选择器或会话命令等待 Agent Loop。Escape 中断当前的供应商或工具操作并立即处理下一个排队的输入。空草稿时 Up 取回最新的排队输入进行编辑。
- **`/btw <question>` 旁路提问。** 在不打断活动回合的情况下就当前对话提出一个无工具的问题。`/btw` 复制每个主供应商请求之前发布的冻结供应商有效上下文边界,因此它绝不观察半写状态的工具轮,然后把它投射进单个请求,恰好一个系统权威(专用的旁路提问提示)与一条引用父 Engine 提示、对话与工具结果作为惰性参考数据的用户消息 —— 父级的工作流意图、工具协议与推理状态永不成为活动的旁路指令。不声明也不执行工具;响应中的任何结构化工具调用(包括文本加工具的混合)都会使交换失败。请求在独立于主回合的旁路专属 AbortController 下运行,答案流入全区域的临时覆盖层,在回合于其下继续时报告主状态;裸 `/btw` 重新打开最新的内存答案,`←/→` 导航、`c` 复制、`↑/↓` 滚动、`x` 清除当前会话的交换。旁路交换永不进入会话 JSONL、主转录、检查点、校验器、门、权限或工具执行,且不在进程重启后存活。

### 修复

- **安全的 `/init` 重生成。** `/init` 现在在进行供应商请求之前拒绝既有的项目 `VESICLE.md`;`/init --force [notes]` 是显式的替换路径并把先前的文件保留在 `.vesicle/init-backups/` 下。非强制的运行还在生成之后使用独占创建,因此供应商请求在途时创建的文件永不被覆盖。
- **持久指令的恢复可见性。** `update_instructions` 的成功结果与用户手册现在声明 `/rewind` 不恢复这些宿主配置文件、点名用于手工恢复的单个 `.previous` 备份,并区分恢复先前的内容与删除首次创建的目标。
- **模块 A/B 校验器对非卡片内容的误报。** 卡片校验器的适用性测试把任何以 `---`(Markdown 水平线)开头的 assistant 响应当作 YAML frontmatter 产物,因此普通的报告或阶段过渡说明被同时作为角色卡与情景卡校验,并抛出一整批虚假的“缺失小节/缺失字段”发现。卡片适用性现在按键族与模块 A 的正文小节识别真正的 frontmatter,因此以 `---` 开头的报告不触发任何卡片校验器。回合终结器与 `/validate` 现在经一条共享路径只运行 `applies` 谓词匹配的校验器(角色卡不再被交叉校验为情景卡,反之亦然),且分类不再依赖校验器本应诊断的字段(缺失 `archetype` 或 `scenario_name` 的卡片仍被识别)。
- **Assets CLI 错误**现在在 Harness manifest 或参数校验失败时以简洁的面向用户消息退出,而不是泄漏 Bun 的堆栈跟踪。

## [1.0.0-alpha.3] - 2026-07-21

### 新增

- **Stage 消费 Engine。** 第一方 `/stage <character-card-path> <scenario-card-path>` 冻结模块 A 与模块 B 的内容不变,渲染并持久化开场引导上下文,并在源卡之后漂移时仍恢复该冻结的上下文。Stage 不暴露模型可见的工具、门、MCP、Agent 或 shell 表面;它校验共享的三段式包并记录 `stage.prose` 观察。玩家视图保持正文为主并带紧凑的 HUD。
- **实验性运行时 Semantic Judge。** 经用户级 `quality.yaml` 可选开启(默认 `off`);`rewrite` 要求显式的确认命令。宿主只记录无机密的 Profile 快照与有界的结果,保留带一次修复的严格 Judge 解析,并在 Profile 漂移之后拒绝待处理的重试。与校准的 Policy 激活分离;不做任何产品质量或 AI 作者身份的声明。
- **开发者 `vesicle quality benchmark` 命令。** 从冻结的计划运行显式的供应商/模型矩阵,要求 `--allow-live`,追加可恢复的仅哈希行,并写入逐模型的 Wilson/切片报告,不含候选文本或原始响应。只记录测量证据;不能启用语义阻塞。计划可设置 `earlyStop.minimumEvaluations`,避免在运营试点有足够的观察之前应用基于比率的早停。
- **`quality-policy/semantic-rewrite@1` 识别。** 要求它的 Harness 必须发布活动的、经哈希验证的策略,带稳定的 Judge 规则、精确的协议/模型范围、完整的逐规则置信度阈值与非占位符的校准摘要。宿主只暴露纯资格评估;已发布的 Harness 保持仅观察,语义发现仍不能进入重写决策。
- **钉住的 Biome 正确性 lint**,覆盖 TypeScript/TSX 源、脚本与测试,由可复用的 CI/发布构建在类型检查之前强制执行,并有可选的被跟踪 pre-push 钩子在存在 lint 诊断时阻塞推送。格式化与导入辅助保持禁用;Harness 资产保持在 lint 范围之外。

### 变更

- **`STATUS.md` 重写为实现清单索引** —— 分组的能力状态表、分类的限制列表、刷新的仓库树与指向权威 `docs/dev/` 文档的链接。无运行时行为变更。
- **Windows Authenticode 签名无限期延后。** 产物保持未签名并依赖 GitHub Release、SHA-256 校验和与 npm 来源;较早的 `1.0.0-beta.1` 签名截止被取代且无替代门。`CODE_SIGNING_POLICY*`、`README*`、`STATUS.md`、`CONTRIBUTING*` 与用户手册的签名参考已同步更新。
- **用户手册重写**,从单一线性的 Windows 优先课程改为漏斗式频道结构:一个路由页、四个入门页(Windows 安装器、npm、Windows 便携版、Linux 便携版)、五个频道无关的教程与一个参考区,基于当前的 CLI、引导 Setup 向导、doctor 输出、校验器、配置文件、安装器与发布产物。
- **用户手册的语言政策翻转为简体中文为规范**,英文镜像在相同的相对路径;根与 `docs/dev` 的治理文档保持英文为规范。
- **npm 路径推荐全局安装**(`npm install -g prism-vesicle`),因此标准工作流是 `cd project && vesicle .`。
- **新的 `advanced/` 用户手册小节**(宿主 shell/进程运行时、Output Quality Guard、SubAgents、Stage),简体中文为规范并带英文镜像。每页标记时间点的 🟢/🟡 状态并让位于 STATUS.md,因此实验特性可以毕业而无需重写正文。
- **捆绑 V10 基线刷新**到 Neural Narratology Release `harness-20260720-3` / `prism-engine-v10@10.1.0-rc.1`(提交 `90f65c9`):精确的 73 文件 manifest 清单、Profile 声明的宿主简报、紧凑的质量投射、原始的 Stage 引导模板与静态提示资产台账。

### 修复

- **Stage 转录投射**在隐藏的 Neural Chain 与紧凑 HUD 周围折叠空行,而不剥离可见正文中有意义的缩进,同时在 HUD 下方保留一个稳定的视觉间隙。
- **Stage 源视图切换**使用 `Ctrl+Alt+S` 而非裸 Enter 或空格,因此聚焦的 Stage 消息不能拦截输入框的文本、命令的空格、提示的提交或 `Ctrl+Enter` 的换行。
- **Output Quality Guard 的产物强制**只从成功的 `create_file`、`write_file`、`replace_in_file` 与 `append_file` 结果派生目标,在质量边界读取每个受护栏路径完整的当前后像,并让阻塞的路径在重写、暂停、取消与重启之间独立保持待处理。干净的完成摘要或无关的干净文件不再能让未更改的坏产物通过。
- **Quality Guard 耗尽**不再作为普通完成落空。质量事件把评估结果与宿主动作分离;只追加的警告与解决记录在重启之间保留耗尽、不可读与超大的目标,TUI 把被中断或耗尽的修订恢复为三向决策(用同一 Engine 重试一次/使用当前版本并保留其警告/停止且不调用供应商)。
- **Semantic Judge 基准**在调用供应商之前拒绝不受支持的语料目标类型,并支持参与计划哈希的有界冻结逐评估超时,而不更改交互式运行时的 15 秒期限。
- **引导 Setup** 限制页面的描述并根据实际的紧凑或常规面板结构预算模型选择行,防止 Setup 在非最大化的 Windows Terminal 窗口中启动时文本重叠。
- **固定高度的 TUI 行**退出隐式的 OpenTUI 自动换行;共享的测量、截断、填充与输入框编辑用终端显示列而非 JavaScript 字符串长度保留字形簇。Rewind、Permission 与 YOLO 面板保留有界的行数,使当前点、警告、错误与批准的控件保持可见。
- **斜杠命令的参数补全**现在由命令所有而非控制器白名单:内置命令注册自己的语法与候选来源,`/quality`、`/artifact`、`/validate`、`/resume`、`/stage` 与 `/engine --summary` 现在补全其参数。

## [1.0.0-alpha.2] - 2026-07-15

### 新增

- **SubAgent 运行时。** Profile 驱动的前台/后台子 Agent(`spawn_agent`、`list_agents`、`send_message`、`interrupt_agent`、`wait_agent`),带捆绑的 Explore、Plan、Research、Reviewer 与 General Profile,以及 `assets/agents/` 下的稀疏项目/用户覆盖。前台子级只暂停父模型循环并流式传输进度;后台子级立即返回、并发运行、在持久的父收件箱中持久化完成,并在会话空闲时触发自动的父续接。`/agents` 暴露状态与取消。
- **一等公民的 SubAgent 可观测性** —— 专用的生命周期卡、实时的进度与有界的结果预览、头部与 Workspace 侧栏中持久的活动/就绪摘要、后台投递的状态、会话恢复时恢复的卡,以及带参数补全的 `/agents <handle>` 详情。
- **双重 SubAgent 身份** —— 用于存储与恢复的不透明仅宿主 `runId`,加上用于模型工具与用户命令的稳定父范围句柄如 `explore-1`;遗留的 UUID 引用保持输入兼容。
- **目录工具** —— `list_directory`、`create_directory`、`move_directory` 与 `delete_directory`(仅空、非根)。文件检查点现在保留目录拓扑,并行的 Agent 写所有权检测祖先/后代冲突,模型可见的项目路径拒绝符号链接遍历。
- **契约绑定的 Harness 委派**(`prism-agent/delegation@1`),构建在既有的 SubAgent 运行时之上。已验证的 Driver Contract 唯一绑定父 Engine、Agent Profile、执行模式、目的与重试限制;拒绝未声明、有歧义或模式升级的请求;串行化 Harness 委派;规范化 Driver ABI 错误;持久化尝试与终止的元数据;并在瞬态重试耗尽时打开声明的可恢复用户决策点。
- **失败关闭的 Prism Harness Pack 基础** —— 严格的 `prism-harness-pack/v1` 解析、精确的文件/哈希与 Profile/Prompt 绑定验证、Adapter/能力兼容性检查、外部宿主资产校验与基于暂存的不可变目录安装。`/permissions` 仍是唯一的工具调用授权层,而不是在 Harness 或 HAL 中重复。
- **离线的受管 Harness 生命周期** —— `vesicle assets verify`、`install`、`use`、`status` 与 `rollback` 接受已解包的 Pack,持久化精确的项目与会话身份,在激活与恢复时复验不可变的内容,并在稀疏覆盖之下选择一个完整的受管基线。缺失的受管文件不能落到捆绑 V10;回滚原子地恢复整个捆绑 V10 基线。
- **捆绑 V10 基线**在没有项目锁时自动激活:精确的 Harness manifest 清单、根 `harness-manifest.json` 与受限制的宿主扩展层。新会话持久化 Harness 身份(前 V10 会话在恢复时失败关闭)与有效合并资产树的仅内容指纹,在恢复漂移时警告。
- **Output Quality Guard**(`quality-guard/anti-ai-flavor@1`)—— 校验已发布的规则包与检测器契约,在受保护的 Markdown/HUD 区域之间保留规范化的证据偏移,把运行时正文缓冲到 Guard 策略解析,向原 Engine 至多请求两次重写,在重复的候选哈希上停止,并持久化可恢复的有界 QualityEvents。Dyad、Weaver、Weaver-Orch 与 Scene Writer 使用观察路径;Evaluate 与 Chapter Reviewer 的报告不被递归守护。
- **全局资产覆盖层** —— `vesicle assets status`、`materialize <assets/path> [--global]` 与 `init --global` 创建用户级或项目特定的可编辑层。运行时资产逐文件经稀疏的项目覆盖、用户全局覆盖、一个受管/捆绑 V10 基线与受限制的宿主层解析;模型可见的工具只看到逻辑 `assets/...` 路径,永不见物理的全局或包位置。
- **工具权限运行时** —— 四个粗粒度模式:`MANUAL` 对每个工具询问,`INERTIA` 自动允许观察工具,`MOMENTUM` 自动允许除 `shell_exec` 之外的所有工具,`YOLO` 在两次红色确认之后自动允许有效表面。MCP 工具总被视为有副作用,SubAgent 的请求经父 TUI 路由。
- **可选开启的非交互 `shell_exec`**,由有界的跨平台进程运行时支撑:固定的项目 cwd、过滤的子环境、分离的 stdout/stderr 上限、墙上时钟超时、进程树终止、精确计划的批准哈希、持久的请求/解决/进程元数据,以及不确定崩溃恢复之后的不重放。
- **后台 shell 执行**经 `shell_exec.runInBackground` 立即返回受管的 `shell-N` 任务,带 `.vesicle/processes/` 下持久化的有界状态/输出、下一回合的完成通知与 `shell_output`/`shell_stop` 控制。
- **Shell 解释器 Profile** —— 宿主拥有的 `auto`、`powershell-7`、`windows-powershell-5.1`、`cmd`、`git-bash` 或 Linux/WSL 的 `posix-sh`。Windows `shell_exec` 不再要求 PowerShell 7;解析出的可执行文件与运行时策略绑定进批准的计划,PowerShell/CMD 输出规范化为 UTF-8,模型指南跟随所选的命令方言,不可用的显式 Profile 失败关闭而不是跨越 shell 家族。
- **用户级 `permissions.yaml`、`/permissions` 与进程范围的 `--dangerously-skip-permissions` 覆盖。** 持久的 YOLO 默认被拒绝,恢复的 YOLO 会话降级到 MOMENTUM,除非危险的 CLI 覆盖处于活动状态。
- **引导的逐用户 Windows 安装器**(Inno Setup 6),带稳定的升级身份、完整的独立 V10 载荷、开始菜单的 Setup/Doctor 条目、精确的用户 PATH 增删行为、保留的用户/项目状态,以及 Windows CI 的安装/运行/卸载冒烟覆盖。PR CI 与标签触发的发布把带版本的安装器与便携产物并列携带。
- **可复用的 CI/发布构建**合并到一条拥有发布门与产物的 Linux/Windows 流水线;PR 与 `develop` CI 保留短寿命的带版本 PE、ELF、assets-ZIP 与安装器产物供评审。

### 变更

- **1.0.0-alpha.2 被授权为显式披露的未签名 Windows 预发布**,面向知情的 Alpha 组,同时 SignPath Foundation 的申请待定。GitHub Release 前置双语未签名产物警告,链接代码签名政策,并引导用户到 `SHA256SUMS.txt`;临时的发布工作流把可发布的包版本钉在恰好 `1.0.0-alpha.2`,直到经评审的签名集成或另一个显式的 Alpha 决定取代它。
- **单下载的逐用户 Windows 安装器是主要的非技术上手路径**,同时为开发与专家用途保留 npm、PE/ELF 与 assets-ZIP 产物。
- **标签触发的发布** —— 在被接受的 `main` 提交上推送受保护的带注释 `v<version>` 标签,授权工作流重跑所有门、创建带校验和的 GitHub Release,并经 Trusted Publishing 发布 npm。正常路径由命令行驱动,没有 Actions 页面调度、Candidate 工作流或 GitHub Environment 批准步骤;未来的签名批准仍是独立的手动信任门。
- **Agent 循环与代码坏味的重构**把供应商循环与剩余的 P1 运行时模块拆分为更窄的职责,而不更改外部行为。

### 修复

- **供应商返回的工具调用**在权限评估或执行之前对照当前有效的工具面检查,因此当宿主 shell 能力被禁用时,YOLO 不能执行幻觉出的 `shell_exec`。
- **权限恢复**在能力/配置漂移与被中断的多工具窗口之间失败关闭:恢复的批准不能重新启用被禁用的工具,不完整的调用永不重放,被 shell 污染的检查点呈现针对性的回退警告。
- **MANUAL 与 INERTIA 的批准保留并行前台 SubAgent 契约**,在并发启动被批准的 Agent 批次之前收集精确的逐调用决策;同时发生的父/子提示解析实际显示的请求。
- **混合宿主工具与 SubAgent 的轮次**在传播兄弟宿主工具的失败之前持久化每个已启动的 SubAgent 结果,为恢复保留持久的工具调用/结果配对。
- **取消后台 SubAgent**不再入队合成结果或为另一个供应商回合唤醒父 Engine;取消是持久的终止 Agent 状态,遗留的排队取消通知被确认而不投递。
- **SubAgent 的生命周期与进度事件**不再覆盖父 Engine 的 Workspace STATUS 行;活动仍经专用的卡、头部摘要、Agents 侧栏与活动记录可见。
- **被中断的前台 Agent**在崩溃恢复期间关闭其原始的 `spawn_agent` 工具调用,后台投递阻塞直到供应商/门的状态一致,已终止的子级拒绝迟到的控制请求,`/agents retry` 显式恢复在供应商重试耗尽之后暂停的投递。
- **Workspace 侧栏**保持固定两行的 Shell 摘要,防止多个后台任务覆盖 Effort、会话与 MCP 行。
- **权限暂停**不再渲染空的 assistant 气泡,活动的 TUI 底面经与渲染相同的模态优先级持有键盘与粘贴输入。
- **Shell 进程的期限**保持活动直到继承的 stdout/stderr 管道关闭,成功的 shell 退出也清理存活的组内后代,而不是留下普通的子工作。
- **通用宿主 SubAgent**(`explore`、`general`、`plan`、`research`、`reviewer`)在 V10 Harness 活动时保持普通的并发宿主 Agent,而未声明的非宿主 Agent Profile 仍经 Driver Contract 失败关闭。
- **引导 Setup 不再持久化第一个项目目录**或把开始菜单的启动路由回它。项目选择可选且一次性,遗留的 `setup-state.json` 指针被忽略而不删除,无效的启动路径产生一条有界的 CLI 错误,后退导航不再与紧凑的终端布局重叠。已安装的用户获得原生的 `vesicle.exe` 命令加逐用户的 Explorer 动作;升级移除遗留的启动器,重跑安装器呈现 Reinstall/Repair/Uninstall。

## [1.0.0-alpha.1] - 2026-07-11

### 新增

- **Anthropic Messages 供应商协议** —— 非流式的文本响应、`tool_use` / `tool_result` 循环与 `thinking` / `redacted_thinking` 块的保留,外加文本增量、思考增量与流式工具调用 JSON 的 SSE 流式与最终响应重建。
- **Gemini `generateContent` 供应商协议** —— 非流式与 SSE 文本、函数调用/函数响应、思考努力控制、思考摘要显示,以及跨工具循环的 `thoughtSignature` 重放。
- **OpenAI 兼容 Chat Completions SSE 流式** —— assistant 内容增量与流式 `tool_calls` 重建为与非流式调用相同的最终响应形状,外加 Agent 循环的流式事件与响应在途时 TUI 实时的 assistant 草稿渲染。
- **思考块与推理可见性** —— 供应商中立的内部思考块,以 OpenAI 兼容的 `reasoning_content` 作为兼容桥,穿过流式、工具循环后续与会话恢复保留。`/effort off|low|medium|high|xhigh|max` 控制运行时的思考努力(加 `/effort auto`/`unset` 清除),`/reasoning hidden|collapsed|expanded` 控制显示,带有限的折叠/展开尾部视图。
- **模型配置默认值** —— 用户级 `providers.yaml` 中 `generation`(`temperature`、`maxTokens`)与 `capabilities` / `limits` 元数据的对象模型条目,同时保留既有的字符串模型条目。
- **文件系统工具 v2** —— `stat_path`、`grep_files`、带范围的 `read_file`、视觉门控的 `view_image`、`create_file`、`replace_in_file`、`append_file`、`delete_file`、`copy_file` 与 `move_file`,全部位于既有的项目相对路径护栏与产物根写边界之后。
- **文件操作台账** —— 成功的文件系统工具现在经 Agent 循环的活动事件与会话 JSONL 的工具记录发出结构化的 `fileEvent` 元数据。
- **跨 OpenAI 兼容 Chat、Anthropic Messages 与 Gemini 的多模态图像输入。** 模型以 `capabilities.vision: true` 选择加入;TUI 经 `Alt+V`(与 WSL 兼容的 `Ctrl+Alt+V`)接受剪贴板图像,在历史/回退/恢复之间保持原子的 `[Image #N]` 元素,并把字节存进内容寻址的 `.vesicle/attachments/` 存储,base64 只存在于内存中的供应商请求副本。
- **Streamable HTTP MCP 集成** —— `providers.yaml` 旁边可选的用户级 `mcp.yaml` 声明启用的服务器、来自兄弟 `.env` 的 `${ENV_VAR}` 头展开、工具前缀、include/exclude 过滤器、Engine 范围与超时。发现的工具以 `mcp_<prefix>_<tool>` 别名暴露,经 `tools/call` 执行,呈现结构化的 `mcpEvent` 元数据,出现在提示转储中,并由 `vesicle doctor` 报告而不打印机密的头值。Workspace 侧栏显示紧凑的 MCP 状态小节。
- **Tavily 支撑的 Web 工具**(`web_search`、`web_fetch`、`web_map`、`web_crawl`、`web_research`),服务 ETL 与 Evaluate 回合,从用户级 `.env` 或进程环境读取 `TAVILY_API_KEY` 并持久化结构化的 `webEvent` 元数据。
- **回退与逐回合检查点** —— `/rewind`(别名 `/checkpoint`)与空输入双 Esc 打开一个选择器,可以恢复对话、文件检查点、两者一起,或从选定的提示摘要,分叉未来的回合,同时在只追加的会话 JSONL 中保留被放弃的分支。逐用户回合的检查点活在 `.vesicle/file-history/` 下,带变更前的备份、变更文件与插入/删除的预览、100 张快照的活动上限与分支感知的恢复。
- **Engine 切换** —— `/engine [id]` 用于手动检查与切换 Prism 引擎,外加暂停等待确认、只在用户确认之后切换未来回合的 `request_engine_switch` 模型可见交接工具。两者共享一个统一的过渡记录;确认的切换追加有界的用户角色 `engine_handoff` 包,使 OpenAI 兼容、Anthropic Messages 与 Gemini 适配器都收到相同的目标 Engine 上下文,而不更改动态的系统提示。
- **`ask_user_question`** 模型可见的澄清工具 —— 一个带 2-4 个模型选项的单选问题,加宿主拥有的 Skip 与开放回答回退,保持问题面板的方向键选择不滚动消息历史,并在选择之后恢复当前的 Engine 循环。
- **`/compact [notes]`** 经配置的供应商摘要活动的会话,并在新的只追加分支上以用户角色的摘要替换旧上下文。`/engine <id> --summary [notes]` 先压缩再切换;模型请求的交接现在也提供 `Confirm with summary`。
- **跨供应商的用量规范化** —— 供应商响应在全部三个适配器之间规范化运行时的用量元数据。TUI 页脚显示紧凑的逻辑回合上游/下游 token 总计、缓存输入命中与配置时的上下文窗口百分比,外加按逻辑回合摘要相加(而非重复计数重复的上下文发送)的会话总计;会话把底层的遥测持久化为仅宿主的元数据。`/context` 报告配置的限制、最新的占用、会话总计与自动压缩元数据,而不调用供应商。
- **供应商/模型注册表与产物工作台** —— 用户级 `providers.yaml` 声明多个供应商与模型加可选的 `defaultModel`,TUI 提供两步的 `/model` 选择器、供应商默认快捷方式与精确的供应商/模型选择。`/artifact [n|path]` 列出或以有界的结构保留卡预览生成的文件,`/validate` 检查磁盘上选定的文件。
- **供应商取消**经 `AbortSignal`,适用于 OpenAI 兼容、Anthropic Messages 与 Gemini 请求;生成期间的 Esc 中断请求并恢复已提交的提示供编辑。
- **斜杠命令候选菜单** —— 输入命令 token 时的过滤弹窗,带 Up/Down 或 Ctrl+P/Ctrl+N 选择、Tab/Enter 补全与 Escape 取消。`/model`、`/engine`、`/effort` 与 `/reasoning` 补全其参数,包括补全到规范值的别名匹配。
- **独立可执行文件** —— `bun run build:exe` 在 WSL 上一次运行交叉编译 Windows PE(`prism-vesicle.exe`)与宿主 ELF(`prism-vesicle`),把 OpenTUI 的 tree-sitter worker 作为平面的 Bun worker 入口嵌入,因此不需要外部的 `node_modules/` 运行时捆绑。编译的二进制在 `process.execPath` 旁边加载其不可变的默认 `assets/`。`vesicle debug markdown-runtime` 不启动 TUI 即可验证 worker、WASM 运行时与高亮探针;`bun run build:assets` 创建单独分发的可编辑 `dist/prism-vesicle-assets.zip` 发布包。
- **GitHub Actions CI** 验证 Linux ELF 与原生 Windows PE 的发布形状,包括独立的 Markdown 运行时诊断与外部资产;拉取请求的运行上传短寿命的带版本产物供评审,而不发布 GitHub Release 或 npm 包。
- **协议特定的出站头 Profile**,对齐经审计的 OpenCode Chat Completions、Claude Code Messages 与 Gemini CLI 行为。Vesicle 发出从 `package.json` 与活动 Bun 运行时派生的品牌 `User-Agent`,支持可选的供应商级 `userAgent` 覆盖,保留协议原生的流式 `Accept` 行为,并在每次传输尝试上更新 Anthropic Stainless 的重试计数器。
- **供应商重试** —— 响应前的网络失败、HTTP 408/429 与 5xx 响应在全部三个适配器之间至多重试两次,带有限的指数退避、抖动与 `Retry-After` 支持。取消立即中断退避;部分消费的 SSE 流从不隐式重放。
- **“Synaptic Prism” TUI 重写(阶段 A–E)** —— 深冷表面配单一的祖母绿棱镜强调色;每条消息的逐角色光谱车道带不对称容器;带真实行级 diff 与结构化结果页脚的行内文件系统工具调用卡;逐回合的 `▣ {engine}·{model}` 标记带逐 Engine 的强调色;流式优先的单侧栏布局;实时的回合阶段状态跟踪;`engineDisplayName` 助手(etl → ETL,runtime → Runtime,weaver-orch → Weaver-Orch);以及 `scripts/palette.ts` 开发色板工具。
- **宿主拥有的多行输入框**取代 OpenTUI 的单行输入 —— 软换行长连续输入,按视觉行数扩展底部区域,保持跟随光标的视口,并让 Up/Down 先在换行的行之间移动,再回退到提示历史。裸 Enter 提交,`Ctrl+Enter` 插入换行,`Shift+Enter` 被区分报告时为惰性,尾随的反斜杠+Enter 保留为兼容的换行回退。

### 变更

- **共享的 Markdown 显示层**保守地把常见的 LaTeX 公式转换为终端可读的 Unicode,并在围栏代码块之外把常见的 Markdown 扩展语法(`==mark==`、`~sub~` / `^sup^`、脚注、定义列表、图像替代文本、emoji 短代码与常见的行内 HTML 如 `<u>`、`<mark>`、`<kbd>`、`<abbr>`、`<details>`)降级为可读的终端文本。产物预览剥离常见的 Markdown 标记,共享的 TUI 语法样式注册 Prism 色调的 Markdown/代码 token 颜色。
- **会话记录**现在携带 `uuid` 与 `parentUuid`,允许只追加的对话分叉;既有的线性 JSONL 会话在加载时获得确定性的隐式父级并保持可恢复。
- **Escape 遵循 Claude Code 的提示契约** —— 单次空 Escape 是无操作,空输入的双 Esc 打开回退,非空的双 Esc 保存并清除草稿;Ctrl+Q 与既有的双 Ctrl+C 路径保持显式的退出控制。
- **`AGENTS.md` 与 `CLAUDE.md`** 扩展为完整的 AI 协作者入口,链接仓库的工作流、风格、状态、贡献、供应商配置、验证与文档清扫规则。
- **快速开发的工作流例外**把 `develop` 当作低风险内部迭代的活动主干,同时为高风险或面向发布的工作保留 PR/CR 流程。
- **OpenAI 兼容的供应商后端拆分**为请求整形、响应解析、流式、线路类型与结构化的供应商错误,以加固传输基础。
- **供应商配置要求用户级 `providers.yaml`** —— 该文件缺失时,Vesicle 不再回退到单一的 `VESICLE_API_KEY` 环境配置。API key 从其旁边的 `.env` 加载,优先于继承的进程变量,因此遗留的项目根 `.env` 文件不能遮蔽它;`vesicle doctor` 报告是否找到该 `.env`,而不打印机密值。
- **思考档的映射**发送供应商的线路控制(`off` 禁用;`low`/`medium`/`high` 映射到高努力;`xhigh`/`max` 映射到最大努力);未设置的会话保持供应商/模型默认且不发送思考控制字段。生成默认来自所选的模型配置,而非硬编码的适配器温度。
- **供应商配置接受 `anthropic-messages`**(可选 `authMethod: x-api-key` 或 `bearer`)与 **`gemini-generate-content`**(可选 `authMethod: x-goog-api-key`)。
- **形状接近的单复数命令对合并** —— `/artifact` 与 `/engine` 无参数时列出、有目标时动作;冗余的 `/artifacts` 与 `/engines` 被移除。`/effort` 现在是思考控制命令,与 `/reasoning` 的显示分离;旧名称与 `/engine` 隐藏的 `/workflow` 别名被移除,把 `workflow` 留给未来的引导工作流特性。
- **公开 Alpha 的文档边界声明**:Setup、诊断、提示形状检查与捆绑示例是受支持的上手路径;综合的用户文档在特性与修复工作仍是优先事项时刻意延后。根 README 重组为简洁的安装与上手入口,详细的实现清单移到 `STATUS.md` 之后,自然换行确立为 Markdown 正文的约定,并添加了 README 与贡献指南的同步简体中文版。
- **npm/Bun 包更名**,从无主的带范围候选 `@prism/vesicle` 改为可用的公共包名 `prism-vesicle`。1.0.0-alpha.1 的发布契约使确定性测试不再仅因本地凭据存在就运行真实供应商,npm 包只附带运行时文件与钉住的依赖,包资产与 OpenTUI worker 独立于调用方的 cwd 解析,并新增 `vesicle assets init` 创建可编辑的项目本地资产副本。

### 修复

- **`source_materials/`** 现在是模型生成研究与 Web 捕获的可写项目根;`/artifact` 仍限定于四个最终输出根。
- **`/artifact <n|path>`** 在消息流中渲染所选的文件;先前的实现只写入一个未消费的选择信号,并声称预览在已被移除的右侧面板中可见。
- **侧栏的产物编号**遵循固定的根顺序(`workspace`、`novels`、`reports`、`test_runs`),每个根内最新文件在前,小节在剩余的侧栏高度内滚动,而不是在头八个之后静默丢弃条目。
- **非确认的门与问题路由**经渲染、键盘与粘贴路由之间共享的一个激活谓词,在其常驻的 Reject/自由格式输入框中输入与粘贴,防止漂移。
- **未确认的 `request_engine_switch`** 决策把其工具结果返回给供应商并在当前的 Engine 下继续;确认的交接仍只切换未来的回合,而不在新系统提示下调用供应商。
- **斜杠命令的候选选择**响应式渲染,过滤查询更改时重置,并对空结果集保持有效,因此方向键精确移动一个可见的光标。
- **供应商/模型选择器**参与底部的布局尺寸并把可见行限制到终端高度,而不是覆盖输入框或遥测页脚;无效的 `defaultModel` 引用在加载配置时被拒绝,`/model <model>` 保持与活动供应商切换的向后兼容。
- **提示契约**把用户选择的检查点与当前的 `ask_user_question` 运行时对齐,把 Runtime 引擎的 `runtime-turn` 停止门绑定到 `request_confirmation`,并把 RooCode 时代失配的工具名如 `ask_followup_questions` 与 `apply_diff` 排除在捆绑提示之外。
- **`vesicle prompt dump` / `prompt shape`** 报告有效的模型可见工具面,包括运行时添加的 `ask_user_question`、`request_engine_switch` 与仅停止门的 `request_confirmation`。
- **Windows 的 Ctrl+C 选择复制**经 UTF-8 base64 桥把剪贴板文本写入 `Set-Clipboard`,避免复制中文或其它非 ASCII 文本时的乱码。
- **TUI 的工具调用与结果**渲染为紧凑的转录摘要,而不是把完整的工具参数或完整的文件内容倾倒进主聊天流。
- **流式**拒绝过早的 SSE EOF,以供应商流错误报告畸形的块,对更严格的兼容供应商不带 OpenAI 特定的 `stream_options` 重试,并在内存的对话历史中保留最终的 assistant 回合。
- **OpenAI 兼容流式的工具调用名**保留最新的供应商值,而不是拼接重复的 `function.name` 增量,避免不合规范流造成的重复名称。
- **OpenAI 兼容的推理响应**在非流式、流式、工具循环的后续请求与会话恢复之间保留供应商的 `reasoning_content`,因此推理模型可以使用工具而不丢失必需的思考上下文。
- **`/model` 与会话恢复**经用户级的供应商 `.env` 解析 API key 的可用性,因此当选定的 key 存储在那里时,不再显示 “API key: missing”。
- **源与编译启动**使用分离的 OpenTUI Setup 路径:`bun run dev` 在导入 TUI 之前预加载 OpenTUI,而 `build:exe` 显式应用 OpenTUI 的 Bun 构建插件,避免外部的 `bunfig.toml` 预加载查找,并在不更改项目 cwd 的情况下解析编译的运行时文件。
- **`bun run build:exe`** 在 Linux/macOS 上成功 —— 编译步骤发出带平台适当扩展名的入口基名,因此构建后的重命名不再因寻找不存在的 `main.exe` 而失败,并在 Windows 之外产出宿主原生的 `prism-vesicle` 二进制。
- **独立的二进制保留启动目录为项目根**;会话、工作区与项目的资产覆盖留在活动项目,而运行时/默认文件显式在可执行文件旁边解析。嵌入的 tree-sitter worker 现在即使在构建目录的 `node_modules/` 仍可达时也被使用,防止该仅开发路径覆盖单文件运行时。
- **npm/Bun 安装经 `.mjs` Bun 启动器暴露 `vesicle`**,npm 11 在发布期间保留它。
- **带回退确认面板与文件更改**为 `Never mind` 选项、手工编辑的警告与页脚保留足够的底部布局高度。行内自由格式的问题输入框与门的备注/拒绝输入框同样保留有界的布局行,防止短终端中选项、输入与页脚的重叠。
- **输入框自有的方向键**在可渲染分发之前消费其原始的 OpenTUI 事件,因此光标移动与提示历史召回不能再滚动消息流或侧栏;带修饰的方向键在没有输入框动作时作为输入框的无操作消费,`Ctrl+C` 立即消费,同时保留其复制选择/双击退出的契约。

## [0.1.0] - 2026-07-07

### 新增

- Engine Profile 加载器:`assets/engines/*.yaml` 现在在运行时驱动 systemPrompt 组合、工具解析、校验器名称与声明的停止门。手写的 YAML 解析器无依赖地处理窄的 Profile schema。命名未知工具或缺少必需字段的 Profile 大声失败。
- 停止门运行时:`request_confirmation` 工具让模型暂停工作流等待用户确认。Agent 循环返回 `needs_user` 结果;`resolveGate()` 把决策反馈并继续。未声明的门被拒绝,而不是暂停。ETL 阶段 0 的蓝图确认端到端接线。
- 模块 A 与模块 B 校验器:角色卡(frontmatter 字段白名单、七个小节、Persona Topology 子小节、Invariant/Variant 轴计数、正向转变方向、L-System 泄漏)与情景卡(3–5 节拍图、逐节拍字段、张力范围、非单调轨迹、遗留字段拒绝)的 v9 schema 检查。
- `vesicle prompt dump --engine <id>` 与 `vesicle prompt shape --engine <id>` 打印完全组合的系统提示与 Profile 结构,用于“是否存在宿主污染?”的审计。
- 会话恢复:`listSessions()` 与 `loadSessionMessages()` 重建先前的回合。TUI 的 `/resume`、`/resume <n|id>`、`/new` 与 `/help` 命令管理会话而不触碰供应商。
- TUI 中的 Markdown 渲染:assistant 消息经 OpenTUI 的 `<markdown>` 组件带 `conceal` 渲染,因此标题、列表、强调与代码区间显示为格式化的输出。
- 借鉴 Claude Code PermissionPrompt 形状的选择式门 UI:编号的 Confirm/Reject 选项、Tab 展开确认备注,以及持久的拒绝/讨论逃生口。
- 集中化的调色板与共享的语法样式在 `src/tui/theme.ts`。

### 变更

- ETL 的停止门现在除 `blueprint-confirmation` 之外还包括 `phase-confirmation`,因此阶段 1/2 的产物检查点使用 `request_confirmation` 工具,而不是普通的正文暂停。
- TUI shell 现在是响应式的:窄终端使用可读的单消息列,中等终端添加工作区/产物侧栏,宽终端添加活动/产物窗格。
- `/resume` 现在打开 TUI 的会话选择器,停在未解决 `request_confirmation` 门上的会话可以恢复回门面板。恢复的会话现在把先前的可见对话加载进消息流。
- ETL 校验器不再在普通的 assistant 正文上运行;它们只在产物形状的 YAML-frontmatter assistant 输出上运行。
- 宽的 TUI 布局现在把右侧窗格用于活动与最近的产物,而不是重复最后的 assistant 输出。
- Agent 循环为供应商请求、assistant 响应、工具调用、门暂停与校验发出粗粒度的活动事件。
- 输入区现在显示斜杠命令提示并支持 Up/Down 的提示历史召回。
- Agent 循环的工具上限从 6 提升到 40,并带无进度断路器(连续 4 个失败的工具轮停止循环并持久化最后的响应,而不是抛出)。Vesicle 受控的文件工具不需要编码 Agent 宿主会施加的严格上限。
- `RunPromptResult` 现在是可辨识的联合(`complete` | `needs_user`),complete 分支上带可选的 `validation` 结果。
- ETL 引擎提示的阶段 0 现在指示显式的 `request_confirmation` 调用,而不是正文“等待用户确认”;新的停止门契约小节记录所有门控与对话绑定的点。
- 校验器的结果呈现在 TUI 消息流与会话日志中;失败是建议性的,永不中止回合。

### 修复

- 门确认现在渲染在专用的底部面板中,带有限的摘要文本、稳定的选项行,且门的时刻没有侧栏挤压。
- 运行时产物根(`workspace/`、`test_runs/`、`novels/`、`reports/`、`source_materials/`)现在被 gitignore 并带 `.gitkeep` 桩,因此模型/用户的输出不进入 git 历史。

## [0.0.0] - 2026-07-07

### 新增

- 添加 M0 Bun + TypeScript + OpenTUI 的项目脚手架。
- 添加 Prism v9 的提示、规范、模板、协议与 Engine Profile 资产。
- 把 `3aKHP/Neural-Narratology` 记录为 Prism Engine 资产的公开兄弟/来源仓库。
- 添加 OpenAI 兼容 Chat Completions 的供应商支持。
- 添加 `.vesicle/sessions/` 下的 JSONL 会话持久化。
- 添加经供应商循环的 `list_files`、`read_file` 与 `write_file` 工具调用,带项目相对的路径护栏。
- 添加改编自用户既有项目工作流的项目状态、贡献、工作流与风格文档。
- 添加配置加载、提示加载、TUI 渲染、会话复用与文件工具执行的冒烟测试。

### 变更

- 更新 Vesicle 的基础提示,要求在声称产物已写入之前先有成功的 `write_file` 工具结果。
- 更改 Ctrl+C 的处理:可能时复制所选文本,并使用双击流程退出。

### 修复

- 修复 TUI 消息前缀使用悬空 `role>` 标记的问题。
- 修复提交之后输入栏不清空的问题。
- 修复导致模型跨回合丢失记忆的逐回合会话创建问题。

[Unreleased]: https://github.com/3aKHP/prism-vesicle/compare/v1.0.0-beta.1...HEAD
[1.0.0-beta.1]: https://github.com/3aKHP/prism-vesicle/compare/v1.0.0-alpha.10...v1.0.0-beta.1
[1.0.0-alpha.10]: https://github.com/3aKHP/prism-vesicle/compare/v1.0.0-alpha.9...v1.0.0-alpha.10
[1.0.0-alpha.9]: https://github.com/3aKHP/prism-vesicle/compare/v1.0.0-alpha.8...v1.0.0-alpha.9
[1.0.0-alpha.8]: https://github.com/3aKHP/prism-vesicle/compare/v1.0.0-alpha.7...v1.0.0-alpha.8
[1.0.0-alpha.7]: https://github.com/3aKHP/prism-vesicle/compare/v1.0.0-alpha.6...v1.0.0-alpha.7
[1.0.0-alpha.6]: https://github.com/3aKHP/prism-vesicle/compare/v1.0.0-alpha.5...v1.0.0-alpha.6
[1.0.0-alpha.5]: https://github.com/3aKHP/prism-vesicle/compare/v1.0.0-alpha.4...v1.0.0-alpha.5
[1.0.0-alpha.4]: https://github.com/3aKHP/prism-vesicle/compare/v1.0.0-alpha.3...v1.0.0-alpha.4
[1.0.0-alpha.3]: https://github.com/3aKHP/prism-vesicle/compare/v1.0.0-alpha.2...v1.0.0-alpha.3
[1.0.0-alpha.2]: https://github.com/3aKHP/prism-vesicle/compare/v1.0.0-alpha.1...v1.0.0-alpha.2
[1.0.0-alpha.1]: https://github.com/3aKHP/prism-vesicle/compare/v0.1.0...v1.0.0-alpha.1
[0.1.0]: https://github.com/3aKHP/prism-vesicle/releases/tag/v0.1.0
