# 更新·卸载·迁移

[English](../../en/reference/update-uninstall-migrate.md) | 简体中文

Vesicle 的**用户配置**和**项目数据**与程序本身分开存放,所以升级和卸载都不会动它们。

- 用户配置:见[配置文件](./configuration.md)里的用户目录(Windows `%APPDATA%\prism-vesicle\`,Linux `~/.config/prism-vesicle/`)。
- 项目数据:每个项目目录下的 `.vesicle/`(会话、文件检查点等),跟着项目走。

## Windows 安装器

再次运行 `PrismVesicleSetup-<version>-windows-x64.exe`,会弹出维护选项:

- **Reinstall / upgrade** —— 用新版本覆盖安装。
- **Repair** —— 修复程序文件与 Windows 集成(资源管理器右键、PATH),不重开 Setup 向导。
- **Uninstall** —— 启动卸载器。

升级时:程序文件更新,你的 `%APPDATA%\prism-vesicle\` 配置和所有项目目录原样保留。卸载时:程序、PATH 条目、资源管理器集成被移除;用户配置与项目数据**保留**(卸载器不碰它们)。要彻底清除,再手动删 `%APPDATA%\prism-vesicle\`。

## npm

```bash
npm update -g prism-vesicle      # 升级
npm uninstall -g prism-vesicle   # 卸载
```

包自带完整只读 V10 运行时基线,升级即换新基线。用户配置(`~/.config/prism-vesicle/` 或 Windows `%APPDATA%\prism-vesicle\`)和项目不受影响。

## 便携版(Windows / Linux)

升级 = 替换二进制 + **重新解压同版本资源包**:

- 二进制和资源包(`assets/`、`host-assets/`、`harness-manifest.json`)**版本必须匹配**,两者一起换。
- 解压后让三件与二进制并排(见各便携入门页的布局图)。

用户配置与项目不受影响。

## 配置与项目的留存原则

- **同一台机器上,所有渠道共享同一个用户配置目录。** 从安装器版换到 npm 版、或换到便携版,配置都不用动。
- **会话属于项目。** 每个项目目录有自己的 `.vesicle/sessions/`;换项目目录就是换一组会话。

## 迁移:旧的根目录 .env

早期版本可能在项目根目录放 `.env`。这已不再支持。把里面的值迁到用户级 `.env`(与 `providers.yaml` 同目录),然后删掉项目根的 `.env`。详见[配置文件](./configuration.md)。
