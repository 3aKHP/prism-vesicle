# Prism Vesicle Code Style

This document defines how Prism Vesicle source code should be shaped so contributors can understand, change, and verify it safely. Architecture and runtime behavior belong in the domain contracts linked from [`ARCHITECTURE.md`](./ARCHITECTURE.md); workflow and verification commands belong in [`WORKFLOW.md`](./WORKFLOW.md).

## Tool-Enforced Baseline

- TypeScript runs in strict mode. Do not weaken compiler settings or hide an uncertain value behind `any`; narrow `unknown` at the boundary that receives it.
- Biome owns lint diagnostics. Its formatter is intentionally disabled, so preserve the surrounding source style and avoid unrelated formatting churn.
- Use Bun-native APIs and existing project dependencies where they already express the required behavior. Do not add a dependency or abstraction for a small local operation.
- Keep source, tests, scripts, and runtime assets inside their established roots. Do not mix generated state or host configuration into tracked source directories.

## Responsibility And Maintainability

Do not use line counts, function length, nesting depth, or similar numeric thresholds as hard pass/fail rules. They may help locate code worth reviewing, but they do not prove that code is well or poorly structured.

Evaluate structure from several signals together:

- Semantic cohesion: a module or function should express one recognizable domain responsibility, even when that responsibility needs substantial code.
- Reasons to change: unrelated policy, persistence, I/O, state-machine, protocol, and presentation concerns should not accumulate under one owner.
- Coupling and knowledge: watch dependency fan-out, cross-layer imports, duplicated invariants, and code that must understand several subsystems to make a local change.
- Local reasoning and testing: behavior should be understandable and testable through a narrow interface without constructing unrelated runtime state.
- Change safety: prefer boundaries that let one concern evolve without broad edits, synchronized changes across files, or fragile ordering assumptions.

Split code when these signals reveal a stable domain boundary or a recurring maintenance cost. Keep a large composition root, registry, parser, state machine, or data table intact when it remains cohesive and splitting it would scatter invariants or introduce indirect coupling.

Do not create generic `helpers.ts`, `utils.ts`, or `common.ts` piles. Name an extracted module after the domain responsibility or policy it owns.

## Prohibited God Structures

God files, god functions, and god classes are prohibited. A change that creates one, materially expands one, or moves the same mixed ownership behind a new name is blocking and must be redesigned before merge.

- A god file owns several unrelated domains or layers, accumulates independent reasons to change, or serves as the place where new behavior is added merely because it already coordinates everything.
- A god function performs substantial work across several concerns such as parsing, policy, persistence, provider or tool I/O, state transitions, and presentation instead of delegating through named boundaries.
- A god class centralizes unrelated lifecycle, scheduling, persistence, policy, resource ownership, and presentation knowledge behind one mutable object or broad method surface.
- A mega-controller, service locator, global host-state object, growing context or options bag, or generic manager is still a god structure when callers and callees must understand unrelated subsystems through it.
- A mechanical split into several files does not resolve the smell when the extracted files remain order-dependent, share broad mutable state, reach into each other's internals, or can change only in lockstep.

Size, branch count, import fan-out, state-field count, and churn are screening evidence rather than standalone verdicts. The blocking decision rests on mixed ownership, cross-domain knowledge, change coupling, and inability to reason about or test one concern independently.

A focused change is not required to rewrite every pre-existing hotspot it encounters. It must not add another unrelated responsibility or deepen the coupling; when the requested behavior would do so, extracting the affected stable boundary is part of the change rather than optional cleanup.

## Module Boundaries

- Modularization and decoupling are requirements, not optional polish. Organize code around stable domain responsibilities and expose the narrowest contract that independent callers need.
- Put behavior in the layer that owns the decision, not in the nearest caller that happens to need it. Follow the dependency direction in [`ARCHITECTURE.md`](./ARCHITECTURE.md).
- Keep composition roots thin: construct dependencies, connect lifecycle callbacks, and delegate domain decisions to their owners.
- Prefer a narrow public facade when a domain has several implementation modules. Re-export only the surface callers need; do not turn barrel files into an implicit global API.
- Avoid circular dependencies, cross-layer reach-through, and imports of another domain's internal implementation files.
- Keep dependencies explicit and one-directional. Pass a narrow capability or domain interface instead of an entire application object, manager, context, or unrelated state bundle.
- Separate policy from transport and persistence, pure projection from mutation, and host runtime state from presentation whenever those concerns can evolve independently.
- Colocate implementation and domain-specific types in the owning source domain. Place fixtures and focused tests under the corresponding subsystem within the appropriate test layer.
- Keep provider adapters, host tools, session persistence, and TUI presentation independent. A convenience import is not sufficient reason to cross one of those boundaries.
- Reuse existing domain constants and normalization functions instead of maintaining parallel arrays, enums, or path rules.
- Judge an extraction by reduced knowledge and safer independent change, not by the number of files produced. Preserve a cohesive invariant in one owner when splitting it would create chatty or cyclic pseudo-modules.

## Directory Structure

Flat directory layouts are discouraged once an area contains distinct domains, abstraction levels, or fixture and support roles. A growing heterogeneous directory makes ownership ambiguous, encourages generic naming, and turns proximity into an accidental dependency rule.

- Place a new file in the narrowest existing domain directory that owns its behavior. When a stable new domain has several related files, create a named directory instead of adding more unrelated peers to a crowded root.
- Keep directory roots for deliberate entry points, public facades, registries, and a small set of genuinely peer modules. Do not use a root as a catch-all because choosing a domain is inconvenient.
- Avoid taxonomy theatre: a directory containing one trivial file or layers of pass-through re-exports is not useful modularization.
- Shared directories such as `tests/support/` contain cross-domain infrastructure with a clear reusable contract, not miscellaneous helpers or fixtures that merely lack an owner.
- Tests use a level-first, domain-second structure: `unit/`, `component/`, `integration/`, `contract/`, and `acceptance/`, followed by the subsystem under test. System and release smoke may live in `scripts/` and CI when that is the real execution boundary.
- Test fixtures belong under the nearest suite or domain that owns their meaning. Promote a fixture or helper to shared support only after independent domains genuinely reuse the same contract.

A small, cohesive directory may remain flat when its files are true peers and further grouping would add navigation without clarifying ownership. A reviewer should block new placement that enlarges a heterogeneous flat root when a stable domain or test-layer boundary is already evident.

## Types And Contracts

- Model meaningful states with discriminated unions or explicit result types. Do not represent mutually exclusive runtime states with several independent booleans.
- Keep external input `unknown` until it has been parsed and validated. Validate at provider, filesystem, configuration, session, and model-tool boundaries before passing values into trusted code.
- Prefer immutable inputs and return values for projections and normalization. Make mutation visible in the owning API when state must change.
- Preserve protocol and persisted-data compatibility deliberately. A tolerant reader and strict writer are acceptable only when the compatibility rule is explicit and tested at the boundary.
- Do not expose host paths, secrets, provider-native payloads, or internal identifiers through shared types unless the public contract explicitly requires them.
- Keep types beside the domain that owns their meaning. Move a type to a shared module only when independent consumers genuinely share the same contract.

## Control Flow And Errors

- Return early when it makes the valid path easier to read. Avoid nesting that mixes validation, policy, I/O, and presentation in one block.
- Catch errors only where the caller can add context, classify the failure, recover, or translate it into a stable boundary result. Do not catch and silently discard unexpected failures.
- Preserve cancellation as a distinct outcome where the runtime supports it. Do not report user cancellation as provider failure or successful completion.
- Use domain-specific error types when callers need structured classification; otherwise throw an `Error` with a concise, actionable message.
- Keep retries, fallback, and fail-soft behavior at the layer that owns their policy. Lower adapters and helpers must not invent host workflow decisions.
- Make partial success explicit. Never return a success shape when required work was skipped or a durable mutation is uncertain.

## State And Side Effects

- Keep pure parsing, normalization, and projection separate from filesystem, network, process, and session mutations when that separation improves local reasoning.
- Give durable state one owner. Session records, checkpoints, process metadata, asset locks, and configuration transactions must not be written through competing code paths.
- Persist the intent or state required for recovery before starting an externally visible continuation that could be interrupted.
- Use atomic write patterns for host configuration and indexes whose partial state would be invalid. Preserve the domain's concurrency and optimistic-locking rules.
- Do not hide filesystem, provider, process, or model calls behind names that imply a pure lookup.
- Keep observability callbacks informational. Logging, progress, and rendering hooks must not change the result or lifetime of the operation they observe.

## Naming And Source Layout

- Use domain language consistently across source, types, tests, and documentation. Do not create near-synonyms for the same state or operation.
- Name booleans and predicates so their truth meaning is clear. Name commands as actions and persisted records as facts that have occurred.
- Match file names to their primary exported responsibility. A directory may use `index.ts` as a deliberate facade, but substantive behavior belongs in named modules.
- Keep abbreviations limited to established project or protocol terms such as TUI, MCP, SSE, and HTTP.
- Remove dead imports, types, helpers, and compatibility branches made obsolete by the current change. Do not perform unrelated cleanup in the same patch.

## Comments And Documentation

- Comment invariants, non-obvious compatibility constraints, and reasons a tempting alternative is unsafe. Do not narrate syntax or restate the function name.
- Keep comments accurate when behavior changes; stale rationale is worse than no comment.
- Public docs must not contain secrets, absolute local paths, or references that require an ignored local document to understand the supported contract.
- Markdown prose uses natural line wrapping: keep each paragraph or list item on one source line unless Markdown structure or meaning requires a break.
- Update the authoritative domain document when a boundary changes. Prefer a link over copying the same detailed contract into several documents.

## Tests

- Add or change tests only when they protect a user-visible behavior, security or durability boundary, external contract, or plausible regression not already covered at the appropriate layer.
- State the defect the test would catch and use an oracle derived from the product or protocol contract rather than the current implementation's statement order or source text.
- Prefer the narrowest existing test layer that can observe the behavior. Use integration, contract, acceptance, PTY, package, or platform smoke coverage when a unit test cannot exercise the real boundary.
- Treat skipped or unavailable coverage honestly. Do not return early and count an unexecuted conditional test as passing.
- Refactors should reuse existing coverage unless a risky boundary lacks characterization. Do not preserve incorrect production structure merely to satisfy implementation-locked tests.

Verification commands and the change-risk matrix live in [`WORKFLOW.md`](./WORKFLOW.md). Test counts and source line counts are not quality targets.

## Review Questions

- Does each changed module still have one recognizable owner and reason to change?
- Does the change create or expand a god file, god function, god class, mega-controller, service locator, or broad state bag?
- Did modularization reduce cross-domain knowledge, or merely distribute the same coupling across more files?
- Does each new file live in an intentional domain and abstraction-level directory rather than a heterogeneous flat root?
- Can the behavior be understood and tested without constructing unrelated runtime state?
- Are external input, side effects, persistence, and cancellation handled at explicit boundaries?
- Did the change preserve provider, tool, session, prompt, permission, and TUI separation?
- Is new complexity required by the current behavior, or is it speculative flexibility?
- Are comments, tests, and domain documentation aligned with the resulting contract?
