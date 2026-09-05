<!-- Generated from docs/user/en/advanced/README.md — do not edit. -->

# Advanced and experimental features

English | [简体中文](../../zh-CN/advanced/README.md)

This section covers capabilities that the tutorials and reference do not expand on. Best read after the [tutorials](../tutorials/README.md).

> **Status convention:** each page opens with 🟢 Implemented / 🟡 Experimental, reflecting maturity in `1.1.1`. Experimental features may stabilize over releases — **[`STATUS.md`](../../../../STATUS.md) is the authoritative current state**; the markers here may lag. When a feature graduates, update the table on this page and the status line on its page.

## Feature overview

| Feature | Current status | Summary |
|---|---|---|
| [Choose an Engine](./engines.md) | 🟢 Implemented | What each of the seven bundled Engines does and how to switch safely |
| [Host shell / Process Runtime](./shell-exec.md) | 🟢 Implemented (not a sandbox) | Let the model run host commands: foreground/background, interpreter profiles, process-tree cleanup |
| [Output Quality Guard](./quality-guard.md) | 🟢 Guard body · 🟡 Judge/Policy experimental | Deterministic checks of artifact post-images, document metrics, optional Semantic Judge |
| [SubAgents](./subagents.md) | 🟢 Implemented | Foreground/background child tasks; generic and Driver-contract agents |
| [Stage consumer engine](./stage.md) | 🟢 Implemented | Open a continuous narrative session from a character card + scenario card |
| [Skills](./skills.md) | 🟢 Implemented | On-demand procedural context: discovery, activation, resource reads, `/skill` command |
| [MCP tools](./mcp.md) | 🟢 MCP tools · 🟢 Output persistence | Connect external tools: connection setup, tool permissions, optional result archiving |
| [Harness Packs](./harness-packs.md) | 🟢 Offline management implemented | Verify, install, select, and roll back a complete creative baseline; materialize sparse overrides when needed |

## Prerequisites

- Finish the [tutorials](../tutorials/README.md); understand gates, artifacts, and permission modes.
- [Permissions and security model](../reference/permissions-and-security.md) is the shared foundation for shell_exec and SubAgents.
