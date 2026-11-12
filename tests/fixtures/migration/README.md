# Migration evidence

This directory owns public, synthetic migration inputs. The evidence checker is a development tool; it does not implement a Rust runtime, migrate user sessions, or establish feature parity by itself.

## Evidence contract

The version-1 interchange types live in [`scripts/check/migration/model.ts`](../../../scripts/check/migration/model.ts). An evidence bundle contains capabilities, scenarios, the classified TS source inventory, verification records, differences and human boundary gates. Keep machine-local logs and reports outside the published package. Never use private session content, endpoints or credentials as public fixtures.

Each capability names an observable behavior, source/contract anchors, its TS status and introduction, target stage, applicable conditions, scenarios, implementation locations and verification IDs. Every scenario defines its input file and SHA-256, action, observable assertions, negative case and explicitly allowed normalization. Opaque provider state and signatures are not normalization candidates.

A verification names the exact TS baseline and optional Rust candidate SHA, command, environment and tool versions, start/end timestamps, exit code, status, assertions, and hashed artifact/log files. Its result artifact is JSON with `schemaVersion: 1`, `scenarioId`, `status`, `tsSha`, `rustSha` and `assertions`; producers may add raw observations. The checker requires the producer artifact and verification bookkeeping to agree before accepting `passed`. A missing log, nonzero or absent exit code, missing assertion, stale SHA, or `skipped`/`unavailable` result cannot count as passing. The checker validates evidence consistency, not the truth of an arbitrary producer's assertions: producers require independent behavior oracles and review.

Paths are relative to the explicitly supplied evidence root. Missing files, wrong hashes, parent traversal and symlink escapes are rejected. Files are read without mutation. A file-level scan of tracked TS runtime, configuration examples, assets, package, installer and build/smoke/CI inputs provides a conservative drift backstop. It is not a semantic capability inventory; domain-level enumeration and reviewed dispositions are also required. Every scanned file must have capability ownership or a reason it is not a capability, and source changes enter the delta queue even when the path is unchanged.

## Commands

Use a detached, clean checkout of the recorded TS baseline as the source root. Do not use a Rust integration commit as an unexplained replacement for the TS lineage. Preserve the initial SHA, advance the recorded baseline only after reviewing the TS changes, and retain each prior inventory and evidence bundle.

```sh
bun scripts/check/migration/main.ts scan <TS-checkout> > scanned-files.json
bun scripts/check/migration/main.ts diff <TS-checkout> <evidence.json>
bun scripts/check/migration/main.ts check <TS-checkout> <evidence.json> <evidence-root> <reviewed-coverage.json> <S0..S6>
bun test tests/unit/migration/evidence.test.ts
```

`scan` reports tracked file identities and content hashes without inventing dispositions. `diff` returns nonzero for added, changed or removed inventory entries. `check` compares immutable capability/scenario definitions, dispositions, known difference definitions and human-gate ownership against a separately supplied reviewed coverage bundle (the same version-1 shape; execution records may be empty). Keep that reviewed input separate from producer output. The requested acceptance stage is explicit, so an execution report cannot lower its own gate. It binds the declared baseline SHA to the clean source checkout, validates evidence and returns a stage summary with required/passed counts. Failure returns nonzero. Future-stage scenarios remain in the inventory but need not have executed before their deadline. Due capabilities require verified Rust implementation; S0 baseline observations alone do not confer that status.

Human observations are separately recorded as H1 (before S2), H4 (before S5) and H5 (before S6). Each gate owns its human scenarios and a hashed observation package; a passed gate also names the observer, the separately hashed candidate artifact, its commit and matching human verification records. The instructions package and executable candidate are distinct artifacts. Prior-stage human observations retain their explicitly recorded candidate; automated current-stage regression evidence must name the current candidate. A resolved difference requires passing evidence for its scenarios. Pending human observations must not be presented as passed. The evidence command is one acceptance gate; independent code review, CI, integration and the stage handoff remain separate requirements.
