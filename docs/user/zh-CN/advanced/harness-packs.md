# Harness Packs:管理创作基线

[English](../../en/advanced/harness-packs.md) | 简体中文

> **状态(截至 `1.0.0-rc.1`):** 🟢 已实现离线 verify/install/use/status/rollback。在线发现、下载、解压和自动更新尚未实现。

Harness Pack 是一整套经过清单校验的 Prism 创作基线:Engine profiles、prompts、validators、Agent profiles、Skills 与 Adapter Binding 必须作为一个版本整体使用。普通首次安装已经自带 V10 基线,**不需要**再安装 Pack。只有当你收到一个可信来源提供的、已经解压的完整 Pack 目录时才走本页。

## 先看当前基线

在目标项目目录运行:

```bash
vesicle assets status
```

成功输出包含 `Active baseline: bundled ...` 或 `Active baseline: managed <id>@<version>`,以及 manifest SHA-256。`bundled` 表示使用安装包自带基线;`managed` 表示这个项目钉住了另一个已安装 Pack。

## 安装并选择一个 Pack

下面四步必须在**你想使用它的项目目录**执行。把示例路径替换成已经解压的 Pack 目录:

```bash
vesicle assets verify /path/to/extracted-pack
vesicle assets install /path/to/extracted-pack
vesicle assets use <pack-id>@<version>
vesicle assets status
```

1. `verify` 只验证,不安装。成功显示 `compatible=true` 和资产数量;任何 hash、manifest、兼容性或 ABI 错误都会 fail-closed。
2. `install` 复制一个不可变快照到用户级 Store。成功显示 `Installed Harness <id>@<version>`。
3. `use` 为**当前项目**写入 `.vesicle/assets.lock.json`。成功显示 `Activated managed Harness ... for this project.`
4. 再跑 `status`,确认 `Active baseline: managed` 与刚选的 id/version 一致。

然后运行 `vesicle doctor` 与 `vesicle prompt shape --engine etl`,再开一个**新会话**。启动和恢复都会重新核对锁定身份;旧会话若记录了不同 Harness 身份,供应商续接会被阻止,不会静默用新基线继续。

## 回退到内置 V10

在选错版本、Pack 缺失或想恢复默认时:

```bash
vesicle assets rollback
vesicle assets status
```

成功时第一条显示 `Rolled back <id>@<version>; bundled V10 baseline is active.`,第二条显示 `Active baseline: bundled ...`。回退只移除当前项目的选择锁,不会删除用户 Store 中已安装的 Pack,也不会改你的制品。

## 只定制一个 prompt 或 Agent

若目标只是为当前项目定制一个文件,不要复制整套 Harness。先用 `status` 确认有效基线,再做稀疏 materialize:

```bash
vesicle assets materialize assets/prompts/engines/etl.md
```

它把当前有效版本复制到项目 `assets/` 的对应位置,目标已存在时拒绝覆盖。加 `--global` 会写用户级覆盖,影响所有项目,新手通常不应使用。完整复制所有可编辑资产的兼容命令是 `vesicle assets init [--global]`,但整树副本更容易在升级后漂移。

Prompt materialize 得到的是**已经编译的有效层**,其中 Host Adapter Binding 把 Prism 操作绑定到 Vesicle 工具、门和质量策略。不要删除你不理解的 binding 段。修改后用:

```bash
vesicle prompt shape --engine etl
vesicle doctor
```

确认加载来源和环境无缺项,再新建会话验证行为。要撤销稀疏覆盖,先备份你自己的改动,再手动移除刚 materialize 的项目文件;`assets rollback` 只回退 managed Pack 选择,不会删除本地覆盖。

## 常见失败

- `compatible=false`:不要安装。逐条看兼容性错误,获取与当前 Vesicle 版本匹配的完整 Pack。
- `Harness reference must use <pack-id>@<version>`:从 `verify` / `install` 成功输出复制精确 id 与版本。
- 启动提示 Harness identity drift:恢复记录所需的原 Pack,或新建会话;不要修改会话 JSONL 绕过身份检查。
- materialize 拒绝覆盖:目标已有自定义文件。先人工比较和备份,工具不会替你覆盖。
- Pack 是压缩包:先用系统工具解压到单独目录;Vesicle 当前不会自动解压或联网下载。

## 检查点

- [ ] 你用 `assets status` 说得出当前是 bundled 还是 managed。
- [ ] 你知道完整 Pack 的顺序是 verify → install → use → status。
- [ ] 你知道 `rollback` 回退项目选择,但不删除 Store 或本地覆盖。
- [ ] 你知道定制单文件优先用 `materialize`,并在新会话验证。
