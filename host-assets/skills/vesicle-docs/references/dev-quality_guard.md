<!-- Generated from docs/dev/QUALITY_GUARD.md — do not edit. -->

# Output Quality Guard

The Output Quality Guard is the Vesicle host runtime that evaluates generated prose against a verified Rule Pack before it is delivered to the user or committed to downstream state. It is the host-owned delivery-quality policy for Prism narrative output. Current capability state and known limits live in [`STATUS.md`](../../STATUS.md); the developer benchmark runner is documented separately in [`QUALITY_BENCHMARK.md`](./QUALITY_BENCHMARK.md), and the user-facing `/quality` surface in the [`quality-guard`](../../docs/user/en/advanced/quality-guard.md) user-manual page.

## Responsibility Boundary

The Guard evaluates candidate prose and decides a delivery outcome. It is **not** an Engine, an Agent Profile, an MCP server, or a permission grant, and Anti-AI-Flavor is not a seventh user-switchable Engine. The responsibility split is single-threaded:

- **Validator** — Module A/B, runtime-packet, and evaluate-report structural checks remain advisory and after-the-fact. See [`STATUS.md`](../../STATUS.md).
- **Gate Runtime** — `request_confirmation`, `request_engine_switch`, and `ask_user_question` human-checkpoint boundaries. See [`TOOLS.md`](./TOOLS.md).
- **Tool Permission Runtime** — the only approval layer for model-visible execution. See [`TOOLS.md`](./TOOLS.md).
- **SubAgent Runtime** — delegated-task scheduling, lifecycle, persistence, and delivery. See [`SUBAGENTS.md`](./SUBAGENTS.md).
- **Provider Adapter** — normalized-request-to-wire translation only. See [`PROVIDERS.md`](./PROVIDERS.md).
- **Output Quality Guard** — delivery-quality policy: candidate extraction, deterministic detection, optional semantic judging, host policy, and bounded rewrite.

Harness and quality bindings declare delivery policy and capability but do not create a parallel trust or path-authorization system. `/permissions` remains the only ask/allow/deny layer; the Guard never re-approves a tool call.

## Candidate Extraction

- Candidates are extracted from the assistant response, an artifact delta, or a subagent output, depending on the binding's declared target.
- Artifact quality targets come **only** from successful structured file-mutation events and are evaluated from the complete current guarded UTF-8 post-image, not from the trailing assistant prose.
- A later mutation supersedes the same target without erasing rejected-hash history. Clean prose or a different clean target cannot resolve a blocking target.
- Unreadable, non-UTF-8, or over-budget post-images are inconclusive warnings rather than clean assessments.

## Deterministic Detector

`core/quality` loads the Rule Pack and Detector assets only from the active verified Harness and fails closed on unknown schemas, matchers, metrics, preprocessing, or binding semantics. The Detector runs the deterministic document metrics defined by the active Rule Pack, ignores non-target regions (code blocks, YAML, HUD, Hidden Neural Chain, rule examples), and returns rule id, bounded evidence, severity, and a rewrite direction. The Rule Pack, not Vesicle source, owns the rule set; Vesicle owns the runtime, extraction, retry, session, and presentation.

## Semantic Judge

The Semantic Judge is an **experimental** user-level override that defaults to `off` in `quality.yaml`. It is a single tool-free, file-free, MCP-free, subagent-free provider request over a stable rubric, with low temperature, bounded output, and a shared cancellation signal. Its findings are advisory even under Runtime `rewrite` and never enter blocking policy on their own. The Judge does not write files, generate replacement prose, mutate character state, or decide whether the user continues. The user-facing configuration surface is the `/quality` command (see the user-manual page); developer measurement is `vesicle quality benchmark` ([`QUALITY_BENCHMARK.md`](./QUALITY_BENCHMARK.md)).

## Host Policy

The Guard decides one outcome per candidate — the `QualityDecision` runtime value `pass`, `observe`, `rewrite`, or `exhausted`. The decision combines deterministic hits and severity, Judge confidence when the Judge runs, engine and candidate type, the current rewrite attempt count, whether the candidate repeats a prior failed post-image hash, and whether the Judge timed out or returned an invalid result.

Runtime `rewrite` keeps rejected prose out of the displayed transcript, returns target-specific findings to the same Engine, uses the contract's bounded rewrite budget, and stops when a blocking target repeats its post-image hash. Quality decisions persist before another provider request. A retry requires the same Engine, Harness, manifest, and Rule identity; `accept` and `stop` do not call the provider and retain applicable warnings.

## Lifecycle And Bindings

The Guard runs at delivery boundaries declared by the active Engine and Harness bindings. Observe bindings record deterministic findings without blocking ordinary work; Analyze bindings describe an Agent's own audit role and are excluded from recursive Guard enforcement. Runtime `rewrite` is wired for the Runtime engine target; other long-form engines remain observe-only. Where the Guard rewrites, it does so through the existing target/post-image lifecycle — it does not introduce a second permission path or a separate provider identity.

## Session And Observability

Quality decisions are durable records: they retain target, bounded evidence, Pack and Rule identity, outcome, and action without copying rejected full text that checkpoints or tool history already cover. Resume preserves an unfinished rewrite state or terminates it as a visible warning rather than silently losing it; it never displays a rejected candidate as a delivered assistant message. Judge token usage is accounted as auxiliary quality cost, not mingled with the main engine output counters.

## Current Unconnected Boundary

The calibrated `quality-policy/semantic-rewrite@1` policy is recognized but **not connected** to the rewrite state machine: the host exposes pure eligibility evaluation only, and the bundled Harness remains semantic-observe only until calibration, held-out evaluation, and preservation gates are complete. Promotion to default semantic blocking or a production held-out run requires separately governed rule and model scope, budget, blinded evaluation, preservation review, and independent Policy review; it is not authorized by a successful development benchmark. Open calibration and promotion questions are tracked in the local Output Quality Guard feasibility assessment and do not change this boundary until their runtime contract lands.
