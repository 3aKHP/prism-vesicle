# Guided Setup And Installer

This document defines the Windows installer scope, interactive onboarding, model discovery, configuration transactions, and project-launch rules. Ownership and dependency direction live in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Installer Scope

- The Windows installer owns only the application lifecycle: complete runtime payload, per-user install location, PATH, shortcuts, upgrade identity, and uninstall. It must not parse provider/MCP schemas, accept secrets, or mutate `%APPDATA%\prism-vesicle`.
- The installed terminal command is the native `vesicle.exe`, renamed from the staged release binary during installation rather than wrapped in a batch file. Upgrades remove superseded executable, wrapper, and Start Menu launch entries. A detected installation exposes Reinstall, Repair, and Uninstall maintenance choices; Repair restores installed files and Windows integration without reopening Guided Setup.

## Onboarding

- `src/setup` owns interactive onboarding. Network discovery, masked input, configuration merge/backup, validation, optional MCP/Tavily setup, permission defaults, and project selection stay in the application so they reuse runtime contracts.
- Setup presents the wire protocol before collecting the endpoint: OpenAI-compatible Chat, official OpenAI Responses, or the dated MiMo/DeepSeek Responses subsets. It writes reviewed HTTP defaults and the exact `responsesProfile`; it never guesses a protocol, profile, WebSocket capability, or remote-compaction capability from a URL or model name.
- Setup choice pages must expose a visible backward action in addition to Escape handling, reset selection when returning to a shorter option list, and keep every rendered row clipped within compact terminal bounds.

## Model Discovery

- OpenAI-compatible model discovery may use the user-supplied Base URL and API key only for a bounded `GET /v1/models` request. Do not follow credential-bearing redirects, log the key, infer capabilities from model names, or make discovery success mandatory when exact manual ids are available.

## Configuration Writes

- Setup configuration writes are host actions, not model-visible tools. Validate the complete staged provider/MCP/environment shape, preserve unrelated secrets and profiles, create timestamped backups for existing files, and keep YOLO and `shell_exec` out of first-run persistent defaults.
- Serialization must retain `responsesProfile`, `responsesTransport`, `authMethod`, and `userAgent` for existing Responses providers. Reconfiguring a recognized endpoint preserves its exact supported profile when Setup supplies no preset or only the same coarse Responses choice; an explicit Chat preset against that endpoint is refused instead of silently discarding the Responses profile. Selecting a different representable Responses subset is an explicit profile migration.

## Project Launch

- Setup must not persist a global project pointer. An optional onboarding folder is only a one-time post-Setup launch target. Every later project launch derives its root from the invocation directory or an explicit `vesicle <directory>` argument; path-based launch starts a new process with that directory as cwd rather than changing the parent process cwd.
