# SubAgent Runtime Contract

This document defines Vesicle's host-level SubAgent runtime. Agent profiles are independent of Prism engine profiles: an engine owns the parent workflow, while an agent profile defines one delegated worker's instructions, tools, context, and execution defaults.

Concrete Weaver-Orch, Evaluate, and future Harness workflows may select and combine agents, but the host owns scheduling, persistence, cancellation, delivery, and provider tool-call correctness.

## Execution Model

Foreground/background and sequential/parallel are independent dimensions.

| Mode | Parent behavior | Result delivery |
|------|-----------------|-----------------|
| Foreground | The parent provider loop waits while the host and TUI remain responsive. | The final child answer completes the original `spawn_agent` tool call. |
| Background | The tool call immediately returns an accepted handle and the parent may continue. | Completion enters the durable parent inbox and schedules a continuation when the parent is idle. |

Multiple tool calls emitted in one assistant response launch concurrently. Foreground calls join before the parent provider loop continues; background calls return handles without joining.

Awaiting a foreground child never blocks Bun's event loop. Child activity is forwarded as host events so the TUI can keep rendering progress and accept cancellation while the parent model is logically paused.

## Identity And User Visibility

Every child has two identifiers. `runId` is a host-only UUID used for metadata files, ownership locks, recovery, and unambiguous internal joins. `handle` is a short parent-session-scoped name such as `explore-1`; it is the only identifier normally shown to the model or user. Handles use `<profile>-<ordinal>`, remain stable across resume, and continue their ordinal after restart. Control tools resolve handles within the current parent session while accepting legacy full ids for compatibility.

SubAgents are first-class TUI activity, not ordinary tool cards. A card appears at the spawn position and follows queued, running, terminal, and background delivery state. Active or ready background work also remains visible in the header and Workspace sidebar. Background execution and result delivery are distinct: a completed child can be `ready`, `integrating`, or `integrated`. `/agents <handle>` shows durable details and `/agents stop <handle>` interrupts a queued or running child.

## Agent Profiles

Effective profiles are sparse runtime assets under `assets/agents/`. They use the existing project, user-global, and bundled asset precedence. Profiles may therefore be shipped by Vesicle, installed by a Harness Pack, or customized by the user without changing TypeScript.

An agent profile declares:

- a stable id, display name, and model-visible description;
- one or more prompt assets;
- a tool allowlist or `*` for the parent's complete effective surface;
- a context policy (`fresh`, `summary`, or `fork`);
- a provider/model policy (`inherit` in the initial runtime);
- a default foreground/background mode and maximum turn count.

`fresh` receives a self-contained task. `summary` receives a bounded parent handoff plus the task. `fork` keeps the parent's already-rendered system prompt as an exact first prefix, appends the independent Agent Profile prompt, and reuses the parent conversation prefix. It must not reconstruct an approximately equivalent parent prompt because byte drift harms both semantics and provider prefix caching.

## Parent/Child Persistence

Session branching and SubAgent ownership are different graphs. `SessionRecord.parentUuid` remains the append-only branch edge inside one session. A child session instead records host metadata including:

- `parentSessionId`;
- `parentToolCallId`;
- host-only `runId`, public `handle`, and agent profile id;
- execution mode and lifecycle status;
- provider/model identity and effective tool scope.

Background completion and failure are written to a durable inbox before they are exposed to the parent. Inbox entries move through `pending`, `delivered`, and `acknowledged` states so restart recovery cannot lose or duplicate results. Explicit cancellation persists the Agent terminal state but does not enqueue a result or wake the parent because there is no child result to integrate.

## Parent Continuation

The continuation scheduler serializes all parent provider turns:

1. A child commits its terminal state and inbox result.
2. If the parent is busy, delivery waits without mutating the in-flight request.
3. When the parent becomes idle, pending results are coalesced into one
   host-owned user-role packet.
4. The packet is appended durably before the provider continuation starts.
5. Successful consumption acknowledges the delivered inbox entries.

User input may arrive while children run. It is serialized with completion delivery; Vesicle never starts two provider requests for the same parent session concurrently.

If delivery exhausts provider-level retries, Vesicle leaves the durable entries ready and pauses automatic redelivery to avoid an unbounded charged retry loop. The user can submit `/agents retry`, while an ordinary new prompt also re-enables delivery.

## Capability And Write Semantics

SubAgents are trusted to perform the work assigned to their profiles. Tool scope is nevertheless deterministic: `*` inherits the parent's exact effective surface, while an explicit profile allowlist may select guarded Vesicle host tools even when the parent Engine does not expose them. MCP tools remain subject to their configured server and Engine scope. The installed profile is the authority; a task prompt cannot widen it.

Profiles may be write-capable. Parallel writers should receive distinct artifact paths or isolated workspaces from their Harness workflow. The host must detect conflicting concurrent mutations rather than globally forcing children to be read-only. Parent Engine file tools participate in the same path ownership table while background children are active.

## Lifecycle And Control

The durable lifecycle is:

```text
created -> running -> completed
                   -> failed
                   -> cancelled
```

The model-visible control surface includes `spawn_agent`, `list_agents`, `send_message`, `interrupt_agent`, and `wait_agent`. Waiting is explicit; spawning never implies polling. Parent-turn cancellation cancels foreground children but leaves background children running. If the Vesicle process exits first, restart recovery marks any in-flight child failed and delivers that terminal result instead of replaying its provider request.

## Initial Built-in Profiles

- `explore`: broad source and project discovery with evidence-rich findings.
- `plan`: turn a supplied goal and context into an executable plan.
- `research`: combine project and web evidence with source attribution.
- `reviewer`: independently assess a supplied artifact or decision.
- `general`: execute a focused task using the explicitly available tools.

These are defaults, not a closed enum. Harness and user profiles are first-class and use the same loader and runtime.
