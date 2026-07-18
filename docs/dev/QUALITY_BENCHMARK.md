# Semantic Judge Benchmarking

`vesicle quality benchmark` is a developer-only measurement command for PR 6B.
It runs the active verified Harness's Semantic Judge contract against a frozen
corpus and explicitly selected provider/model matrix. It does not change
Runtime quality policy: Semantic Judge findings remain observe-only unless a
later, separately reviewed Policy release authorizes semantic rewrite.

The command refuses to call a provider unless `--allow-live` is present. That
flag is an explicit acknowledgement that the run can send corpus text to the
selected providers and incur charges.

## Inputs

Create a versioned plan outside the repository's tracked source unless it is a
reviewed public fixture. The plan freezes the matrix, pricing, hard caps,
statistics, and early-stop thresholds for one run.

```json
{
  "schema": "quality-judge-benchmark-plan/v1",
  "runId": "pilot-2026-07-17",
  "policy": {
    "repeatsPerCase": 3,
    "confidenceInterval": "wilson-95",
    "majorSlices": ["rule", "genre", "lengthBucket", "pov", "targetType"],
    "minimumSliceN": 60,
    "requestCap": 270,
    "tokenCap": 1000000,
    "costCapUsd": 10,
    "maxInputTokensPerRequest": 20000,
    "judgeTimeoutMs": 120000,
    "minimumIntervalMs": 1000,
    "goNoGo": {
      "minimumRecall": 0.9,
      "maximumFalseRewriteRate": 0.03,
      "minimumAgreement": 0.9,
      "maximumInvalidRate": 0.02,
      "maximumP95LatencyMs": 15000
    },
    "earlyStop": {
      "invalidRate": 0.1,
      "timeoutRate": 0.1,
      "falseRewriteRate": 0.1
    }
  },
  "models": [
    {
      "providerAlias": "configured-provider-id",
      "modelId": "configured-model-id",
      "pricing": {
        "inputUsdPerMillionTokens": 0,
        "outputUsdPerMillionTokens": 0
      }
    }
  ]
}
```

Do not treat the values above as approved production defaults. Freeze them with
the rule allowlist, corpus digest, and privacy/annotation governance before a
live pilot. `maxInputTokensPerRequest` must be a conservative upper bound for
the selected request shape. `judgeTimeoutMs` is the per-evaluation Semantic
Judge deadline for this benchmark only; it must be an integer from 1,000 to
180,000 milliseconds and is part of the frozen plan hash and report. It does
not change the interactive Runtime Judge's 15-second timeout. The runner
reserves the possible two-request format-repair path before each evaluation,
so it stops before exceeding its request, token, or cost caps.

The corpus is JSONL. It accepts PR 6A calibration cases (`name`) and blinded
held-out cases (`caseId`). Every record requires `text`, target/slice metadata,
and either a matching `candidateSha256` or no hash, in which case the runner
derives one. Dev cases may supply `expectedVerdict` and `expectedRuleIds`.
Blinded cases intentionally omit them; their classification metrics are
inconclusive until a separately governed labels join occurs.

## Run And Resume

```bash
vesicle quality benchmark \
  --plan /secure/benchmark-plan.json \
  --corpus /secure/judge-dev.jsonl \
  --output /secure/judge-events.jsonl \
  --report /secure/judge-report.json \
  --allow-live
```

The JSONL output is append-only. A resumed invocation verifies the exact run
plan hash and skips completed `(provider, model, case, repeat)` combinations.
Cancellation leaves completed rows intact. Changing the plan, corpus digest,
or model matrix requires a new output path rather than mixing incomparable
measurements.

The runner is intentionally serial, which makes its concurrency cap one. It
also waits for the frozen `minimumIntervalMs` between evaluations. Parallel
benchmarking is deferred until it can preserve the same reservation and
append-only resume guarantees.

The event log and report never contain candidate text or raw provider responses.
They retain case/candidate hashes, expected labels when supplied, verdicts,
rule IDs, bounded usage, latency, and budget charges. The report uses Wilson
95% intervals, per-model and slice metrics, and records cap/early-stop reasons.

## Decision Boundary

A successful dev benchmark is not authorization for a production held-out run,
a Host Policy artifact, or semantic blocking. Follow the staged gates in
`dev/docs/working/OUTPUT_QUALITY_GUARD_PR6_FEASIBILITY_ASSESSMENT.md`: freeze
the rule/model scope and budget, complete the blinded held-out and preservation
review, then perform the independent Policy handshake and Runtime promotion.
