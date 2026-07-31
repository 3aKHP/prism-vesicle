# 故障排查

[English](../../en/reference/troubleshooting.md) | 简体中文

遇到问题先跑 `vesicle doctor`,它的输出会告诉你缺什么。

## 从 doctor 读起

```bash
vesicle doctor
```

重点看这几行:

| 行 | 含义 | 不对时怎么办 |
|---|---|---|
| `API key: available` / `missing` | `.env` 里有没有对应密钥 | `missing` → 写入 `.env` 或重跑向导 |
| `Missing: none` | 所有必需项齐备 | 列出的项 → 按提示补,或 `vesicle setup` |
| `Provider env: file` / `missing` | 有没有用户级 `.env` | `missing` → 在配置目录建 `.env` |
| `Provider proxy: …` | 当前供应商端点是代理、绕过还是直连 | `invalid` → 修正 `.env` 中的完整 `http://`/`https://` URL;其它状态见[配置:供应商代理](./configuration.md#供应商代理可选) |
| `Assets …` / `Harness: …` | 运行时资源与基线 | `missing` → 便携版检查三件是否并排;npm 版重装 |
| `Shell exec: enabled` / `disabled` | shell 工具是否打开 | 按需改 `permissions.yaml` |

doctor 打印的是 `Bun: <版本>`,不打印 Vesicle 包版本;查 Vesicle 版本用 `vesicle --version`(或 `-v`)。

## 常见问题

| 症状 | 处置 |
|---|---|
| 终端里 `vesicle` 命令找不到 | **开一个新终端**。安装器把 `vesicle` 加进了用户 PATH,但旧终端不会刷新;npm 全局装的要确认全局 bin 目录在 PATH 里 |
| `Project directory does not exist` | `vesicle <路径>` 里的路径写错了;用 `vesicle .` 在当前目录启动 |
| 模型发现失败 / 模型列表为空 | 先区分网络失败与端点不提供列表:网络必须走代理时,退出 Setup,按[供应商代理](./configuration.md#供应商代理可选)先配置并重启;Anthropic、Gemini 或不暴露 `/v1/models` 的服务则手动编辑 `providers.yaml` 填精确 model id |
| 供应商返回 401 / 403 | API key 错或没权限——核对 `.env` 里的值与该供应商的 key |
| 供应商返回 429 | 被限流,稍后重试 |
| `Provider proxy authentication failed` / `proxy_authentication_required` / HTTP 407 | 代理要求认证或凭据错误;核对代理 URL 中的用户名/密码,特殊字符做 URL 编码。该错误不会用同一组错误凭据重试 |
| `Provider proxy connection failed` / `proxy_connect_failed` | 代理主机或端口不可达、代理未启动或 CONNECT 被拦截;先核对地址并确认代理正在监听,再发送真实模型请求。Doctor 只检查路由选择,不是连通性测试 |
| 配了 `HTTP_PROXY` 但 HTTPS/WSS 仍直连 | 当前 Bun 对安全目标只使用 `https_proxy`/`HTTPS_PROXY`;推荐改用明确的 `VESICLE_PROVIDER_PROXY` |
| 想让某个端点绕过代理 | 只有继承的标准终端代理响应 `NO_PROXY`;显式 `VESICLE_PROVIDER_PROXY` 不响应。`NO_PROXY` 使用精确主机或 `.example.com`,不支持 `host:port`、`*.example.com` |
| 底部弹出的确认面板"卡住" | 那是**门**,在等你在面板里选确认或拒绝;不是死机 |
| 上下文窗口快满了 | `/context` 查看;`/compact` 压成摘要再继续 |
| 回退找不到某次文件改动 | 回退只覆盖 Vesicle 自有工具的改动;你在 Vesicle 外手动改的、或 shell 改的文件不在账本里(见[权限](./permissions-and-security.md)) |
| 便携版启动报资源找不到 | 二进制与资源包版本不匹配,或三件没并排放;重解压同版本资源包 |

## 还是不行

记下:精确的命令、`vesicle doctor` 的完整输出、报错原文。到 [GitHub Issues](https://github.com/3aKHP/prism-vesicle/issues) 报告——**不要**附 API key、`.env` 内容或会话里的敏感创作数据。
