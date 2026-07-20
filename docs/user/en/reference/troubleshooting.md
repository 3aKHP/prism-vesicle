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
| `Assets …` / `Harness: …` | Runtime resources and baseline | `missing` → portable: check the three pieces are side by side; npm: reinstall |
| `Shell exec: enabled` / `disabled` | Whether the shell tool is on | Adjust `permissions.yaml` as needed |

Doctor prints `Bun: <version>`, not the Vesicle package version; for the Vesicle version check the GitHub Release or `package.json`.

## Common problems

| Symptom | Fix |
|---|---|
| `vesicle` command not found in a terminal | **Open a new terminal.** The installer added `vesicle` to the user PATH, but already-open terminals do not refresh; for a global npm install, confirm the global bin directory is on PATH |
| `Project directory does not exist` | The path in `vesicle <path>` is wrong; start with `vesicle .` in the current directory |
| Model discovery failed / model list empty | The wizard only discovers **OpenAI-compatible** `/v1/models`. For Anthropic, Gemini, or services without a model list, edit `providers.yaml` by hand with exact model ids (see [configuration](./configuration.md)) |
| Provider returns 401 / 403 | Wrong API key or no permission — check the value in `.env` and the provider's key |
| Provider returns 429 | Rate-limited; retry shortly |
| A confirmation panel at the bottom seems "stuck" | That is a **gate**, waiting for you to pick confirm or reject; it is not frozen |
| Context window nearly full | Check with `/context`; `/compact` to summarize and continue |
| Rewind can't find a file change | Rewind covers only Vesicle's own tool changes; files you edited by hand or via shell are not in the ledger (see [permissions](./permissions-and-security.md)) |
| Portable build reports resources missing on start | The binary and asset pack versions don't match, or the three pieces aren't side by side; re-extract the matching asset pack |

## Still stuck

Note: the exact command, the full `vesicle doctor` output, and the error text. Report it at [GitHub Issues](https://github.com/3aKHP/prism-vesicle/issues) — **do not** include API keys, `.env` contents, or sensitive creative data from sessions.
