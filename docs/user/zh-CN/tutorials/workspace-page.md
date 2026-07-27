# 在 Workspace 页查看和修改产物

[English](../../en/tutorials/workspace-page.md) | 简体中文

Workspace 页是 Vesicle 内置的项目文件工作台。它适合在对话后查看、校验和小改产物；不需要为了改一个标题或字段另开 VS Code。

## 打开一个产物

在 Chat 页输入：

```text
/artifact
```

Vesicle 会切到 Workspace 页并打开最新产物。也可以用 `/workspace workspace/角色卡.md` 定位任意项目文件，或按 `Ctrl+O` 在 Chat 与 Workspace 两页间往返。

文件树获得焦点后：

- `↑` / `↓` 选择，`→` / `Enter` 展开目录或打开文件；
- `Ctrl+P` 按文件名快速打开；
- `.` 显示或隐藏点文件和高噪声目录；
- `F6` / `Shift+F6` 在文件树、查看器/编辑器和输入框之间切换。

## 编辑并校验

文本文件会直接进入编辑器；Markdown 默认显示预览，按 `m` 切到源码。

1. 修改内容，使用 `Ctrl+Z` / `Ctrl+Y` 撤销或重做。
2. 用 `Ctrl+F` 查找，或用 `Ctrl+G` 跳到指定行。
3. 按 `Ctrl+S` 原子保存。角色卡和情景卡会自动运行对应校验器。
4. 状态行出现 finding 时，在文件树按 `v` 校验当前**选中项**(或在只读查看器按 `v` 校验已打开文件)打开列表；选择一项并按 `Enter` 跳到对应位置。

校验结论带文件归属:状态行只显示属于当前焦点对象的摘要,选中项与已打开文件不一致时不会张冠李戴。进入源码编辑后,旧结论会被标为 `validation stale`(不再沿用旧的通过/失败颜色);撤销回到底稿等于存盘的内容即恢复为当前结论,存盘则装上一份新结论。`Enter jump` 只在文件真正可编辑时出现——只读、超大或未进入编辑缓冲区的文件不会显示跳转。

## 管理文件

在文件树中可以直接使用：

- `a` 新建文件，`A` 新建目录；
- `m` 或 `F2` 移动/重命名；
- `c` 复制；
- `d` 删除。

所有路径都必须位于当前项目根内。删除会把目标移入 `.vesicle/trash/`，而不是永久清除；目录只有为空时才能删除。覆盖和删除都会先显示确认。

## 交给外部编辑器

打开文件后按 `Ctrl+X`，Vesicle 会暂时挂起界面并启动外部编辑器；退出编辑器后自动恢复、重新读取并校验文件。编辑器按以下顺序选择：

```text
VESICLE_EDITOR → settings.yaml 的 editor → VISUAL → EDITOR → 平台默认
```

如果当前缓冲区尚未保存，Vesicle 会拒绝交接并提示先按 `Ctrl+S`，避免两份修改互相覆盖。

## 切换主题

使用 `/theme dark`、`/theme light`、`/theme default` 或 `/theme auto` 临时切换主题。`default` 跟随终端明暗模式;`auto` 按本地时间切换(07:00–19:00 浅色)。选择只对当前会话生效。

## 检查点

- [ ] 你用 `/artifact` 或 `/workspace <path>` 打开了一个文件。
- [ ] 你修改并用 `Ctrl+S` 保存了文本文件。
- [ ] 你看过一次校验结果或明确的 `no validator matched`。
- [ ] 你知道 `Ctrl+O` 返回 Chat，删除的文件可以从 `.vesicle/trash/` 恢复。

完整键位见[命令速查](../reference/commands.md)。下一步可以继续学习[运行中继续工作](./work-while-running.md)。
