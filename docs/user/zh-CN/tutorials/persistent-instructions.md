# 为项目建立持久化指令

[English](../../en/tutorials/persistent-instructions.md) | 简体中文

如果每次新会话都要重复说明命名规则、写作约束或项目工作流,可以把它们放进 Persistent Instructions。Vesicle 会在会话中自动加载这些 Markdown 文件,但它们只能约束现有工作流,不能新增工具、权限或文件访问范围。

## 生成第一份项目指令

在已经有一些素材或制品的项目里启动 Vesicle,输入:

```text
/init 请重点归纳角色与情景卡的命名规则，以及本项目不应提前揭示的设定
```

`/init` 会扫描 Vesicle 的项目根目录,让当前供应商生成项目根目录下的 `VESICLE.md` 初稿。生成完成后先打开文件检查,删除推断错误或过度宽泛的内容,再继续使用。它是可编辑的项目配置,不是模型输出制品。

如果项目已经有 `VESICLE.md`,普通 `/init` 会在调用供应商前拒绝。只有确实准备替换时才运行:

```text
/init --force 保留现有命名规范，并补充最近新增的情景卡约束
```

强制生成会先把旧文件保存到 `.vesicle/init-backups/VESICLE.md.previous`。不要用 `--force` 代替人工审阅。

## 确认当前生效内容

在 Vesicle 中输入:

```text
/instructions
```

结果会列出当前引擎选择的用户级和项目级文件、字节大小、总预算及告警。再发一个普通回合,让模型概括它必须遵守的项目约束,核对是否与 `VESICLE.md` 一致。

项目根目录的 `VESICLE.md` 对所有引擎生效。需要只覆盖 Runtime 时,可以另建 `VESICLE.runtime.md`;同一作用域内,引擎专属文件会**替换**通用文件而不是与它合并。用户级文件放在 `providers.yaml` 同一配置目录,会跨项目生效;项目级内容排在用户级之后,直接冲突时以项目级为准。

## 让模型协助修改

在非 Stage 引擎中,可以明确要求模型先读再改:

> 读取当前项目通用 Persistent Instructions。保留已有规则,加入“角色卡文件名使用小写 kebab-case”,并说明准备修改的目标。

模型会使用 `read_instructions` 与 `update_instructions`。修改操作遵循当前权限模式;需要批准时,先检查目标作用域和新内容。成功写入后,新的指令会从本回合下一次供应商请求开始生效。Stage 没有模型可见工具,不能使用这条路径。

## 理解恢复边界

Persistent Instructions 是宿主配置,不是回退管理的制品。`/rewind` 或双击 Esc 可以回退对话和受保护文件,但**不会**还原 `update_instructions` 改过的指令文件;对话里看不到工具调用时,磁盘改动仍可能存在。

每次成功修改后,工具结果会给出唯一的上一状态备份位置:

- 原目标存在:把报告的 `.previous` 文件复制回目标。
- 首次创建:对应 `.previous.json` 只记录“原先不存在”,恢复时删除新目标。

下一次修改会替换这份单一备份。恢复前先确认路径和内容,不要把它当作多版本历史。

## 检查点

- [ ] 你用 `/init` 生成并人工审阅了项目 `VESICLE.md`。
- [ ] 你用 `/instructions` 确认了当前引擎实际选择的文件。
- [ ] 你知道引擎专属文件会替换同作用域的通用文件。
- [ ] 你知道 `/rewind` 不恢复 Persistent Instructions,并能找到手工恢复提示。

更完整的作用域、预算和文件位置说明见[配置文件参考](../reference/configuration.md)。下一步学习[权限与宿主 Shell](./permissions-and-shell.md)。
