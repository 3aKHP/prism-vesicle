# Output Quality Guard

English | [简体中文](../../zh-CN/advanced/quality-guard.md)

> **Status (develop snapshot, 2026-07-21):** 🟢 The guard body (deterministic findings + the anti-ai-flavor rule pack) is implemented and wired per the active Harness; 🟡 the Semantic Judge, document metrics under the rewrite binding, and the `semantic-rewrite@1` policy are **experimental**. Maturity per [`STATUS.md`](../../../../STATUS.md).

The Output Quality Guard is a **target-aware** quality layer: at the quality boundary it re-reads the complete post-image of a guarded artifact and checks the prose against an anti-ai-flavor rule pack, optionally followed by an experimental Semantic Judge. Its goal is to make produced prose read more human — not to judge whether the author was AI.

## Two layers

### 1. Deterministic guard (🟢)

Driven by the quality mode the active Harness declares for each engine/agent (`off` / `observe` / `rewrite`, plus the internal `strict` / `analyze`). The bundled V10 Harness currently wires roughly: Runtime prose runs as `rewrite` (can block); Stage / Weaver / Weaver-Orch / Scene Writer / Dyad run as `observe` (advisory only); non-prose producers like ETL are off. **Users do not toggle this layer directly** — it follows the Harness.

What it checks:

- **anti-ai-flavor rule pack** (`quality-guard/anti-ai-flavor@1`): **literal** (substring) and **regex** findings. Rules carry `maturity` (stable/experimental) and `severity` (tier1/…).
- **Six document metrics**: a finite set of regex-signal statistics. Visible in code, for example em-dash density (`em_dash_per_100_chars`), action-list verb density (`action_list_verbs_per_paragraph`), and metaphor-marker density (`metaphor_markers_per_1000_chars`); the full list is in the rule pack.
- Before checking, it **masks** regions that are not prose: code blocks, HTML comments, blockquotes, HUD rows (`[Beat]`/`[Tension]`/`[!Neural Chain]`, etc.), YAML frontmatter, headings, lists, tables, chapter headings.

**What counts as blocking:** `blockingFindings` includes only findings with `maturity: stable` + `severity: tier1` that are **not document metrics**. **Document metrics are advisory even under the rewrite binding** — they never enter blocking policy and never spend rewrite attempts. Matching has a budget (100,000 per target); exhausting it yields a `detector-budget-exhausted` inconclusive warning (not blocking, not reported clean).

**Where targets come from:** only from **successful** `create_file` / `write_file` / `replace_in_file` / `append_file` results; the complete current post-image of each guarded path is re-read at the quality boundary; each target is pending independently. A clean completion summary or an unrelated clean file cannot make an unchanged bad artifact pass.

**Rewrite lifecycle** (rewrite mode): a failing target receives at most **two** original-engine rewrites; each target's post-image hash is tracked independently, and a repeated hash stops the loop (preventing cycles). Once transient retries are exhausted, an advisory quality warning + a **decision point** is persisted: revise once more / use the current version / stop (no provider call). Cancellation, provider failure, and process restart all preserve the decision; Harness / Rule Pack / experimental-profile identity drift disables retry but still allows a local "use current / stop" record.

### 2. Semantic Judge (🟡, optional, off by default)

A user-level experimental overlay that has a **separately registered** provider/model re-check prose. Configured via `quality.yaml` (beside `providers.yaml`) or the `/quality` command; defaults to `off`.

```yaml
version: 1
mode: observe          # off / observe / rewrite
providerAlias: deepseek
modelId: deepseek-v4-flash
judgeTimeoutMs: 15000
```

It only runs when: the producer is `runtime` or `stage`, **and** the deterministic guard already decided `pass` (a second pass over an already-clean candidate). Properties:

- **Empty tool surface**, no normal conversation history, `temperature: 0` (if supported), output capped at 2048 tokens, reasoning off (if supported).
- Output must be strict JSON (`quality-judge-result/v1`); a parse failure allows at most **one repair**, after which it is recorded `invalid`.
- Timeout (default 15 seconds) / provider failure / invalid output / oversize candidate (>30000 code units) → a **persisted inconclusive warning**, not reported clean.
- `observe` mode only records findings (advisory); `rewrite` mode promotes Judge findings to blocking and enters the two-attempt rewrite lifecycle above (experimental).
- Only a **secret-free** profile snapshot (provider/model/protocol/timeout/configIdentity), bounded findings and evidence, timing, request count, and bounded usage are retained — **not** the candidate text or the raw Judge response.
- The system prompt explicitly requires: **do not call tools, and do not claim whether the text was written by AI or a human.**

> It is not a calibrated production quality policy and makes no AI-authorship claim.

### 3. Semantic Rewrite Policy (`semantic-rewrite@1`, 🟡)

When a future Harness Pack requires it, Vesicle recognizes and fail-closed hash-verifies/parses the policy (it must be active, allowlist known stable Judge rules, map every rule to a finite confidence threshold, scope exact protocol/model ids without overlap, and contain non-placeholder calibration digests). But today it **only computes eligibility** (`observe` / `inconclusive` / `eligible`) and is **not** connected to the rewrite state machine — that waits on calibration, held-out, and preservation gates. **The currently bundled Harness remains semantic-observe only.**

## Visibility and persistence

- Session rows mark interrupted / pending quality work; artifact rows mark paths with unresolved warnings; a later clean post-image explicitly resolves the matching warning.
- Observe bindings cover Dyad / Weaver / Weaver-Orch / Scene Writer / Stage; **Evaluate and Chapter Reviewer reports are not enforced recursively**.
- A quality decision takes priority over gates: an unresolved quality decision is handled before other gates.

## Developer-only

`vesicle quality benchmark` is a **developer-only** Semantic Judge measurement command (requires a frozen plan and `--allow-live`, records measurement evidence only, and cannot enable semantic blocking). It is separate from Runtime policy and is not expanded here; see [`docs/dev/QUALITY_BENCHMARK.md`](../../../dev/QUALITY_BENCHMARK.md).

## Status will change

The 🟢/🟡 markers on this page reflect maturity at the develop snapshot (`2026-07-21`). The Semantic Judge, document metrics, and Semantic Rewrite Policy may all stabilize over releases — treat [`STATUS.md`](../../../../STATUS.md) as the authoritative current state.
