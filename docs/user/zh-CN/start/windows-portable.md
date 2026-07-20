# Windows 便携版

[English](../../en/start/windows-portable.md) | 简体中文

适合不想运行安装器的人:免安装环境、U 盘运行、或希望逐文件校验的用户。想要向导和资源管理器集成,请回 [Windows 安装器](./windows-installer.md)。

## 下载两个文件

从官方 Release 下载(命名对照实际产物):

- 单文件可执行程序 `prism-vesicle-windows-x64-<version>.exe`
- 运行时资源包 `prism-vesicle-assets-<version>.zip`

资源包解压后含三件:`harness-manifest.json`、`assets\`、`host-assets\`,必须与二进制版本匹配,升级时两者一起换。

## 校验下载

本页是校验和验证的"正宅"(安装器页只给链接)。PowerShell 对照 `SHA256SUMS.txt`:

```powershell
Get-FileHash .\prism-vesicle-windows-x64-<version>.exe -Algorithm SHA256
Get-FileHash .\prism-vesicle-assets-<version>.zip -Algorithm SHA256
```

把输出和 `SHA256SUMS.txt` 里对应行比对。

> alpha 阶段的 Windows 工件有意未做 Authenticode 签名(SignPath 审批中)。校验和能确认文件未被篡改,但不等于签名。详见[参考:校验和与签名](../reference/checksums-and-signing.md)。

## 摆放布局

可执行文件在**自身旁边**定位默认资源,因此三件必须与它并排放在同一目录:

```text
任意目录\
├── prism-vesicle-windows-x64-<version>.exe   (或重命名为 vesicle.exe)
├── harness-manifest.json
├── assets\
└── host-assets\
```

想要 `vesicle` 这个短命令,把 exe 重命名为 `vesicle.exe` 即可(改文件名不影响运行,资源仍按真实位置查找)。

## PATH(可选)

不加 PATH 也能用完整文件名调用。想在任意目录直接敲 `vesicle`,把上面这个目录加入用户 PATH。

## 配置、检查、启动

与其余渠道汇合:

```powershell
vesicle setup          # 或手动编辑 %APPDATA%\prism-vesicle\providers.yaml + .env
vesicle doctor
Set-Location C:\path\to\my-project
vesicle .
```

配置存于 `%APPDATA%\prism-vesicle\`,与安装器版共享——从安装器版迁来无需改动任何配置。

## 更新

替换 exe 并重新解压资源包;用户配置与项目不受影响。详见[参考:更新·卸载·迁移](../reference/update-uninstall-migrate.md)。

## 下一步

→ [第一次对话](../tutorials/first-conversation.md)
