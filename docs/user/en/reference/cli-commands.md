# Terminal command reference

English | [简体中文](../../zh-CN/reference/cli-commands.md)

This page lists commands run **outside the Vesicle TUI**, directly from PowerShell or another terminal. For in-conversation slash commands such as `/help`, `/model`, and `/workspace`, see the [TUI command cheatsheet](./commands.md).

## Start and inspect

| Command | Purpose | Success feedback |
|---|---|---|
| `vesicle .` | Open the TUI in the current directory | The Chat page appears after startup; the current directory is the project root |
| `vesicle <directory>` | Open the TUI in a specified directory | A new process uses that directory as project root; a missing path is rejected |
| `vesicle launch [directory]` | Explicit command form of `vesicle .` / `vesicle <directory>` | Starts the same TUI in the target directory |
| `vesicle --resume .` / `-r .` | Open the session picker at startup | Current-project sessions are listed; no provider request occurs before selection |
| `vesicle setup` | Open guided configuration | The completion page reports configuration results and can launch one directory |
| `vesicle doctor` | Check Bun, provider, key, assets, Skills, MCP, permissions, and more | Final `Missing: none` means required items are present; optional external services may still report their own errors |
| `vesicle --version` / `-v` | Print the Vesicle version | One version line |
| `vesicle --help` / `-h` | Print global usage | Flags and top-level command summary |

`--dark` / `--light` apply to ordinary launch, `launch`, `dev`, and `setup`, and only select the initial preference; `/theme` may override it in the TUI. `--dangerously-skip-permissions` enables YOLO for this process only; see [Permissions and security](./permissions-and-security.md).

## One non-interactive turn

```bash
vesicle once <prompt>
```

It runs one model turn in the current directory and prints the response plus `Session: <path>`. If the turn needs a gate, question, permission, or quality decision, the command prints that pending type and exits; it never chooses for you in a non-interactive terminal. Run `vesicle --resume .` in the same project and select the printed session to continue.

`once` makes a real provider call and may write guarded files. It has no `--help` subcommand; omitting the prompt prints usage. Use `vesicle --help` when you only need the command list.

## Configuration management

Start with these commands to locate and validate state:

```bash
vesicle config path
vesicle config show providers
vesicle config validate
```

- `path` prints the active user configuration directory.
- `show` accepts `providers` / `env` / `permissions` / `mcp` / `quality` / `settings` / `preferences`. For `.env`, it prints only `<set>` / `<empty>`, never secret values.
- `validate` reports validation and exits zero on success; failure does not mutate files.

Write operations:

```text
vesicle config set <file> <key> <value>
vesicle config unset <file> <key>
vesicle config add-provider --json '<entry>'
vesicle config add-model <provider-id> --json '<entry>'
vesicle config remove-model <provider-id> <model-id>
vesicle config remove-provider <provider-id>
vesicle config add-mcp --json '<entry>'
vesicle config remove-mcp <server-id>
vesicle config env-set-empty <KEY>
vesicle config env-set-proxy <URL>
vesicle config env-remove <KEY>
```

Successful writes print one JSON result on stdout. Errors go to stderr, and validation failure preserves the old file. No command accepts an API key as an argument. Use `env-set-empty` to create a slot, then manually fill the key in the user `.env`. See [Configuration files](./configuration.md) for fields and examples.

## Harness and assets

```text
vesicle assets status
vesicle assets verify <extracted-pack-directory>
vesicle assets install <extracted-pack-directory>
vesicle assets use <pack-id>@<version>
vesicle assets rollback
vesicle assets materialize <assets/path> [--global]
vesicle assets init [--global]
```

These commands manage creative baselines and local overrides. A first-time user does not need them. Use them only after receiving a complete Harness Pack or when deliberately customizing a prompt or Agent. See [Harness Packs](../advanced/harness-packs.md) for order and rollback.

## Skills

```text
vesicle skills list
vesicle skills inspect <name>
vesicle skills enable <name>
vesicle skills disable <name>
vesicle skills create <name> [--scope user|project] [--force]
vesicle skills validate <skill-directory>
vesicle skills install <path-or-url> [--ref <ref>] [--path <root>] [--all] [--include-worktree]
vesicle skills update <name>
vesicle skills rollback <name>
vesicle skills uninstall <name>
vesicle skills copy-template <skill-name> <resource-path> <dest-path>
```

Run `list`, then `inspect` the target. Inspect the source before installing an external Skill. `--include-worktree` snapshots only uncommitted changes to **Git-tracked files** in a local Git directory; untracked and ignored files remain excluded, so use it only after reviewing and deliberately choosing those tracked changes. A failed `update` or `uninstall` is not reported as a successful new state; installed Skills can `rollback` to the previous snapshot. Enable, disable, install, update, rollback, and uninstall affect only **newly resolved session catalogs**; the current session's frozen Skill set is not hot-replaced. See [Skills](../advanced/skills.md) for scopes, session freezing, and `skillify`. `skills validate <directory> --draft --json [--quiet-success]` and `skills publish-draft <draft-directory> --target project|installed --json` are structured internal interfaces used by `skillify` and normally should not be called by hand.

## Prompt and diagnostics

| Command | Purpose |
|---|---|
| `vesicle prompt shape --engine <id>` | Print prompt composition, sources, and lengths without full content |
| `vesicle prompt dump --engine <id>` | Print the complete model-visible system prompt; it may include local custom instructions, so inspect it before sharing |
| `vesicle debug markdown-runtime` | Check the TUI Markdown worker and native syntax runtime |
| `vesicle debug tui-bootstrap` | Run only the TUI bootstrap diagnostic |
| `vesicle dev` | Start the TUI directly from a source/development package; ordinary installed users should use `vesicle .` |

`vesicle quality benchmark` is a developer-only real-provider evaluation entrypoint, not the user switch for Quality Guard. Ordinary users configure it with `/quality` in the TUI.

## After an error

1. Keep the exact command, stderr, and exit code. Do not paste `.env` contents.
2. Run `vesicle doctor` and `vesicle config validate`.
3. Confirm the terminal's current directory is the intended project. Config commands target user configuration, while project preferences and asset selection depend on the current project.
4. Follow the symptom in [Troubleshooting](./troubleshooting.md).
