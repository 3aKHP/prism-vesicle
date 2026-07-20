# npm 安装

[English](../../en/start/npm.md) | 简体中文

适合已经在用 Bun 的开发者:全局装一次,在任意项目目录里 `vesicle .` 启动。本页不解释终端、密钥等常识。

## 前置

Bun ≥ 1.3.14(以 `package.json` 的 `engines` 为准)。

## 安装

```bash
npm install -g prism-vesicle
vesicle prompt shape --engine etl
```

包内自带完整只读 V10 运行时基线(`assets/`、`host-assets/`、`harness-manifest.json`),无需单独安装 Harness。第二条命令打印 ETL 引擎的组合结构,用来确认安装可用。

不想全局安装时,也可以在项目内 `npm install prism-vesicle` 后用 `bunx vesicle …`;但全局安装是推荐路径,直接支撑 `cd 项目 && vesicle .` 的标准工作流。

## 配置

两条路,任选其一:

- `vesicle setup` —— 走终端向导(与 Windows 安装器是**同一个**向导),掩码粘贴 API key、自动发现 OpenAI 兼容模型。
- 或手动编辑用户级配置:`~/.config/prism-vesicle/providers.yaml` + 同目录 `.env`(Windows 为 `%APPDATA%\prism-vesicle\`)。从仓库的 [`docs/examples/providers.yaml`](../../../examples/providers.yaml) 和 [`provider.env.example`](../../../examples/provider.env.example) 起步。

密钥只进 `.env`,不进 `providers.yaml`。

## 检查与启动

```bash
vesicle doctor
cd /path/to/my-project
vesicle .
```

调用时所在目录就是项目根;会话与产物都存在该项目内。

## 更新 / 卸载

```bash
npm update -g prism-vesicle
npm uninstall -g prism-vesicle
```

用户配置在 `~/.config/prism-vesicle/`(Windows 为 `%APPDATA%\prism-vesicle\`),卸载包不影响配置与项目。更多细节见[参考:更新·卸载·迁移](../reference/update-uninstall-migrate.md)。

## 下一步

→ [第一次对话](../tutorials/first-conversation.md)
