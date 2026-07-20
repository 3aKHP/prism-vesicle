# Linux 便携版

[English](../../en/start/linux-portable.md) | 简体中文

适合 Linux 与 WSL 用户。当前 Linux 渠道只有单文件 ELF + 资源包(`.deb` 尚未发布,发布后会在[路由页](../README.md)补一行)。

> 部署建议:**装在你常用的创作环境里**——经常在 WSL 里写角色卡就装 WSL,经常在 Windows 写就用 Windows 渠道,不要跨 `/mnt/c` 折腾。

## 下载与校验

从官方 Release 下载:

- ELF 二进制 `prism-vesicle-linux-x64-<version>`
- 资源包 `prism-vesicle-assets-<version>.zip`

用 `sha256sum` 对照 `SHA256SUMS.txt`:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

Linux 工件无 Authenticode 议题,本节比 Windows 版短,不引入签名讨论。

## 摆放布局与执行位

```bash
chmod +x prism-vesicle-linux-x64-<version>
```

解压资源包,使三件与二进制并排(同 Windows 版契约):

```text
任意目录/
├── prism-vesicle-linux-x64-<version>
├── harness-manifest.json
├── assets/
└── host-assets/
```

资源版本必须与二进制匹配,升级时一起换。

## PATH

二进制总是按**自己的真实位置**去找旁边的资源(经 symlink 调用时也解析到真实路径),所以下面两种做法都可行,任选其一:

- 从一个 PATH 目录(如 `~/.local/bin`)做 symlink 指向真实二进制:`ln -s /opt/prism-vesicle/prism-vesicle-linux-x64-<version> ~/.local/bin/vesicle`
- 或直接把真实二进制所在目录加入 PATH。

想用 `vesicle` 这个短名,重命名二进制或用上面的 symlink 都行。

## 配置、检查、启动

```bash
vesicle setup          # 或手动编辑 ~/.config/prism-vesicle/providers.yaml + .env
vesicle doctor
cd /path/to/my-project
vesicle .
```

配置存于 `~/.config/prism-vesicle/`(`XDG_CONFIG_HOME` 优先)。

## 更新

替换二进制并重新解压资源包;用户配置与项目不受影响。详见[参考:更新·卸载·迁移](../reference/update-uninstall-migrate.md)。

## 下一步

→ [第一次对话](../tutorials/first-conversation.md)
