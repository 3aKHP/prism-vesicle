# SubAgents

English | [简体中文](../../zh-CN/advanced/subagents.md)

> **Status (as of `1.0.0-alpha.4`):** 🟢 Implemented. Maturity per [`STATUS.md`](../../../../STATUS.md).

A SubAgent is a **child runtime**: the main engine delegates a self-contained task to a specialized Agent Profile, either waiting for the result (foreground) or running it asynchronously (background). Multiple `spawn_agent` calls in one response run **in parallel**.

## Two kinds of agents

| Kind | Members | Behavior |
|---|---|---|
| **Generic host Agents** (fixed whitelist) | `explore`, `general`, `plan`, `research`, `reviewer` | Ordinary concurrent SubAgents; **do not** go through Driver-contract delegation |
| **Harness Driver-contract Agents** | V10's `scene-writer`, `continuity-editor`, `chapter-reviewer`, plus custom profiles | Bound to the delegation declared by the parent engine (fixed foreground/background, purpose, retry limit, ABI error model) |

Both kinds of profile load from `assets/agents/*.agent.yaml` through the same project/user/bundled/host overlay rules as engine assets. The five generic ids bypass delegation binding; every other Agent request must bind to the parent engine's **single** declared delegation.

## The five tools

| Tool | Purpose |
|---|---|
| `spawn_agent` | Start a child task; args `profile`, `description` (≤120 chars), `prompt`, optional `mode` (foreground/background, defaulting to the profile) |
| `list_agents` | List installed profiles and this session's children (short handles + lifecycle state) |
| `send_message` | Queue additional instructions for a **running** child (by short handle; delivered at its next provider-request boundary) |
| `interrupt_agent` | Cancel a running or queued child |
| `wait_agent` | Explicitly wait for one child and return its terminal result (background usually needs no explicit wait — see below) |

Children are referenced by **short handle**, like `explore-1` (handles are unique within the parent session; there is also a host-only UUID run id for global/recovery identity).

## Foreground vs background

- **Foreground**: blocks the current turn waiting for the child's result; the TUI stays responsive.
- **Background**: returns a handle immediately without blocking. Results go into a **durable parent inbox** and are delivered when the parent session is **idle** (debounced and coalesced into a single `<subagent-results>` packet, so several completions do not each interrupt you). So background tasks **usually need no polling** — completion is reported to the conversation on the next turn automatically.

Manage children with `/agents`: `/agents` lists, `/agents <handle>` inspects, `/agents stop <handle>` interrupts, `/agents retry` retries delivery after a child terminated on a provider error. Active/ready background work is visible in the header and workspace sidebar, and each child has a dedicated Agent card that updates in place.

## Limits (stated plainly)

- **Recursion is disabled**: children do not receive the agent-control tools and cannot spawn their own children.
- Top-level children are concurrent (default maximum **4**).
- **Restart behavior**: when Vesicle restarts, children that were running are **marked failed and delivered as terminal results**; an in-flight provider request is not replayed for you.
- Handles are unique within the parent session; legacy UUID-style references are still accepted but no longer emitted.
- Weaver-Orch scene allocation, Evaluate reviewer composition, and artifact merge policy are **Harness responsibilities**; Vesicle only provides the scheduling, persistence, and delivery substrate.

## Driver-contract delegation

Contract-bound delegations run **sequentially** (not concurrently), persisting each attempt and terminal state; once transient retries are exhausted they enter the contract's declared **resumable user decision point** (similar to the Quality Guard's "retry / use current / stop"). This is the key difference between Harness-driven workflow Agents (scene-writer and friends) and generic host Agents.

## Custom Agent profiles

A profile file `assets/agents/<id>.agent.yaml` has these fields:

```yaml
id: my-agent            # lowercase letters/digits/hyphens
displayName: My Agent
description: one-line purpose
systemPrompt:           # paths must be under assets/prompts/agents/ or assets/prompts/host/
  - assets/prompts/agents/base.md
  - assets/prompts/agents/my-agent.md
tools:                  # specific tool names, or a single "*"
  - read_file
  - grep_files
contextMode: fresh      # fresh / summary / fork
modelPolicy: inherit    # only "inherit" is supported today
defaultMode: background # foreground / background
maxTurns: 20
```

A non-whitelisted custom profile must satisfy the active Driver Contract to run while a V10 Harness is active. Use `vesicle assets materialize assets/agents/<id>.agent.yaml` to copy a profile into the project or user layer for editing (same overlay rules as other assets).
