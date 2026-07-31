<!-- Generated from docs/user/en/reference/troubleshooting.md — do not edit. -->

# Troubleshooting

English | [简体中文](../../zh-CN/reference/troubleshooting.md)

When something is wrong, start with `vesicle doctor` — its output tells you what is missing.

## Start from doctor

```bash
vesicle doctor
```

Focus on these lines:

| Line | Meaning | If it's wrong |
|---|---|---|
| `API key: available` / `missing` | Whether `.env` has the key | `missing` → write it in `.env` or rerun the wizard |
| `Missing: none` | All required items present | Listed items → fix per the hint, or `vesicle setup` |
| `Provider env: file` / `missing` | Whether the user-level `.env` exists | `missing` → create `.env` in the config directory |
| `Provider proxy: …` | Whether the selected provider endpoint uses, bypasses, or has no proxy | `invalid` → fix the complete `http://`/`https://` URL in `.env`; for other states see [Configuration: Provider proxy](./configuration.md#provider-proxy-optional) |
| `Assets …` / `Harness: …` | Runtime resources and baseline | `missing` → portable: check the three pieces are side by side; npm: reinstall |
| `Shell exec: enabled` / `disabled` | Whether the shell tool is on | Adjust `permissions.yaml` as needed |

Doctor prints `Bun: <version>`, not the Vesicle package version; for the Vesicle version run `vesicle --version` (or `-v`).

## Common problems

| Symptom | Fix |
|---|---|
| `vesicle` command not found in a terminal | **Open a new terminal.** The installer added `vesicle` to the user PATH, but already-open terminals do not refresh; for a global npm install, confirm the global bin directory is on PATH |
| `Project directory does not exist` | The path in `vesicle <path>` is wrong; start with `vesicle .` in the current directory |
| Model discovery failed / model list empty | First distinguish a network failure from an endpoint without a list: if the network requires a proxy, exit Setup, configure the [provider proxy](./configuration.md#provider-proxy-optional), and restart; for Anthropic, Gemini, or services without `/v1/models`, edit `providers.yaml` by hand with exact model ids |
| Provider returns 401 / 403 | Wrong API key or no permission — check the value in `.env` and the provider's key |
| Provider returns 429 | Rate-limited; retry shortly |
| `Provider proxy authentication failed` / `proxy_authentication_required` / HTTP 407 | The proxy requires auth or the credentials are wrong; check the username/password in the proxy URL and percent-encode reserved characters. Vesicle does not retry the same known-bad credentials |
| `Provider proxy connection failed` / `proxy_connect_failed` | The proxy host or port is unreachable, the proxy is not running, or CONNECT is blocked; check the address and listener, then send a real model request. Doctor checks route selection, not connectivity |
| HTTPS/WSS stays direct with `HTTP_PROXY` set | The current Bun runtime uses only `https_proxy`/`HTTPS_PROXY` for secure targets; prefer an explicit `VESICLE_PROVIDER_PROXY` |
| One endpoint should bypass the proxy | Only inherited standard terminal proxies honor `NO_PROXY`; explicit `VESICLE_PROVIDER_PROXY` does not. Use an exact hostname or `.example.com`; `host:port` and `*.example.com` are unsupported |
| A confirmation panel at the bottom seems "stuck" | That is a **gate**, waiting for you to pick confirm or reject; it is not frozen |
| Context window nearly full | Check with `/context`; `/compact` to summarize and continue |
| Rewind can't find a file change | Rewind covers only Vesicle's own tool changes; files you edited by hand or via shell are not in the ledger (see [permissions](./permissions-and-security.md)) |
| Portable build reports resources missing on start | The binary and asset pack versions don't match, or the three pieces aren't side by side; re-extract the matching asset pack |

## Still stuck

Note: the exact command, the full `vesicle doctor` output, and the error text. Report it at [GitHub Issues](https://github.com/3aKHP/prism-vesicle/issues) — **do not** include API keys, `.env` contents, or sensitive creative data from sessions.
