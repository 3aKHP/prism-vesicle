# Synthetic session compatibility corpus

These are public, synthetic inputs for the current TS reader, not captured user sessions or Rust parity evidence. `cases.json` defines independent projection/error requirements. Each case has a project tree and an original SHA-256 manifest, including adjacent attachment, file-history, archive, Skill or background-task data where relevant. The runner always operates on a separate copy and verifies both trees afterward.

The cases cover UUID-less legacy history; opaque provider state; nested inactive candidate branches; full candidate file manifests and backup blobs; portable compaction; valid, missing and corrupted images; required unsupported versions; physical-order Harness migration and frozen Skill identity across older branch heads; unresolved gates, questions, handoffs and permissions; indeterminate processes; completed background processes and acknowledged Agent inboxes; pending quality rewrites/decisions; accepted warnings; and malformed optional quality state versus required assistant state.

The candidate-file-history fixture was derived from a synthetic TS tool-loop/candidate execution, with the prompt replaced by a synthetic marker, its session ID renamed, and unused root directories represented as absent. Its expected alpha/beta content hashes are independently specified. Other records and expectations were constructed from the public session/quality/Skill contracts and existing format examples. No observation output is promoted automatically to an expected result. Accepted quality warnings deliberately remain visible with their resolution, as required by `docs/dev/QUALITY_GUARD.md`.

Run and compare from the repository root:

```sh
bun scripts/smoke/migration/corpus.ts <clean-TS-checkout> <new-run-a>
bun scripts/smoke/migration/corpus.ts <clean-TS-checkout> <new-run-b>
bun scripts/smoke/migration/corpus-compare.ts <new-run-a> <new-run-b>
bun scripts/smoke/migration/corpus-self-check.ts <new-run-a>
```

The child imports real TS session, checkpoint, attachment, Skill, Agent and process facades from the pinned checkout. No provider is contacted; configuration is isolated and fetch/preconnect are rejected. Each child has the same 30-second hard bound as the five workflow oracles. Readers may refresh completed process metadata inside the sandbox, but these fixtures require byte-identical final trees; input originals are never used as runtime directories. This establishes replay and adjacent-data preservation for the listed cases, not every future migration transaction or fault-injection requirement.

Raw observations retain record identities, timestamps, provider signatures and payloads exactly. Only a known sandbox prefix in reader error messages becomes `<project>`. Source SHA and cleanliness are checked before and after the complete run. A failed final check leaves an explicitly failed RUN, even when every case produced a passing projection. The comparator rechecks every retained file, the original input trees, current case definitions, completion status, result provenance and assertions; it compares the complete observations. The self-check rejects raw corruption, a rehashed wrong projection, a wrong source SHA, skipped-as-passed results, a missing case, weakened case requirements and a failed RUN carrying otherwise complete results.

The `.vesicle/` input folders are intentionally tracked fixtures despite the general runtime-state ignore rule. Add changes only under this explicit corpus path with `git add -f tests/fixtures/migration/corpus`; never force-add a real project state directory. Preserve the original manifests whenever a fixture changes and have the changed semantic expectations reviewed independently.
