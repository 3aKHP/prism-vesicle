# Prism Runtime Assets

Prism Vesicle ships one verified V10 Harness baseline and a small, host-owned extension layer. V9 assets are no longer present in the working tree; Git history is the migration backup.

## Bundled Layout

```text
harness-manifest.json   # exact prism-harness-pack/v1 Release manifest
assets/                 # exact 73-file V10 Harness inventory
host-assets/            # 14 Vesicle-owned host extension files
```

The current bundled Harness is the `prism-engine-v10` V10 baseline, sourced from the Neural Narratology repository. Its version, source commit, and manifest SHA-256 are recorded in `harness-manifest.json` (the single source of truth) and are not restated here, so a Harness bump needs no doc sync.

`assets/` must match the manifest inventory and hashes exactly. Do not add Vesicle notes, host-only profiles, or local experiments to that directory. Update the bundled baseline from a published Harness Release and verify the complete inventory rather than copying selected files from another checkout.

## Host Extension Layer

`host-assets/` supplies only an exact host whitelist for generic Vesicle Agents:

- profiles and prompts for the generic `explore`, `general`, `plan`, `research`, and `reviewer` SubAgents, including their common base prompts.
- `assets/prompts/shared/vesicle-base.md` (host base rules) and `assets/prompts/shared/side-question.md` (the `/btw` side-question mode prompt).

The Harness owns all prompt sections declared by its Engine and workflow-Agent profiles, including `assets/prompts/host/`; its `externalHostAssets` list is empty. The three V10 workflow Agents (`scene-writer`, `continuity-editor`, and `chapter-reviewer`) belong to the Harness Pack and its Driver Contract. The five generic Agents remain ordinary Vesicle host extensions: they may execute concurrently and are not rebound as Harness delegations. No arbitrary project or user Agent receives that exemption.

## Resolution And Selection

Logical `assets/...` paths resolve through:

1. sparse project overrides;
2. sparse user-global overrides;
3. the project-selected managed Harness Pack, or the verified bundled V10 Harness when no project lock exists;
4. the restricted host extension layer.

Managed and bundled Harness baselines never merge file by file. A managed Pack may read only its declared `externalHostAssets` plus the fixed generic host Agent whitelist from `host-assets/`. `vesicle assets rollback` removes the project lock and returns to the bundled V10 baseline.

Every start and resume reverifies the active Harness identity. Sessions created before bundled V10 activation do not contain that identity and must start a new session rather than silently resuming under different runtime contracts.

## Managed Pack Contract

- Vesicle consumes a released Harness Pack or an explicitly selected local Pack directory. Runtime code and tests must not depend on a sibling source checkout, cross-repository symlink, or private local path.
- `core/harness` owns strict `prism-harness-pack/v1` parsing, inventory and hash verification, Adapter and capability compatibility, Profile and Prompt bindings, external host assets, and immutable installation.
- Compatibility is fail-closed. Vesicle advertises a capability only after the host enforces its complete contract; prompt guidance and a similar generic runtime are not substitutes for a declared capability.
- Installation and activation are separate. Installation verifies before and after staging, then atomically renames an immutable Pack under the user configuration directory. Activation reverifies the installed Pack and atomically writes the project asset lock.
- A selected managed Harness is one complete baseline. Missing files do not fall through to the bundled Pack unless the manifest declares the exact logical path as an external host asset.
- Project locks and initial session host metadata persist Pack, manifest, Adapter, and source identity. Start and resume require the selected content to match that identity before provider continuation.
- A persisted local decision may remain inspectable under identity drift, but any provider retry that depends on the prior Harness stays disabled until the recorded identity is restored.
- Explicit Agent Profile allowlists in a released Pack may name Vesicle built-in host tools only. Runtime-local MCP tools and parent-provided tools are not portable explicit Pack dependencies.
- The five generic host Agent ids are the only host-owned exemption from Driver delegation while a Harness is active. Other Harness, project, and user Agents require a matching Driver Contract.

## Driver And Quality Bindings

- Contract-bound delegation resolves one Driver binding from the active parent Engine and requested Agent Profile. The verified contract owns mode, purpose, retry limit, and delivery behavior; model arguments cannot widen them.
- Delegation attempts persist their id, Agent Profile, mode, categorized outcome, and terminal state. Retry intent is durable before a user-authorized continuation, and cancellation is terminal.
- `core/quality` loads Rule Pack and Detector assets only from the verified Harness and fails closed on unknown schemas, matchers, metrics, preprocessing, or binding semantics.
- Quality assessment, policy outcome, and host action are separate durable concepts. Findings retain target, bounded evidence, Pack and Rule identity, outcome, and action without becoming a second permission system.
- Artifact quality targets come only from successful structured file-mutation events and are evaluated from the complete current guarded UTF-8 post-image.
- A later mutation supersedes the same target without erasing rejected-hash history. Clean prose or a different clean target cannot resolve a blocking target.
- Runtime rewrite keeps rejected prose out of the displayed transcript, returns target-specific findings to the same Engine, uses the contract's bounded rewrite budget, and stops when a blocking target repeats its post-image hash.
- Quality decisions persist before another provider request. Retry requires the same Engine, Harness, manifest, and Rule identity; accept and stop do not call the provider and retain applicable warnings.
- Unreadable, non-UTF-8, and over-budget post-images are inconclusive warnings rather than clean assessments.
- Observe bindings record deterministic findings without blocking ordinary work. Analyze bindings describe an Agent's own audit role and are excluded from recursive Guard enforcement.
- `/permissions` remains the only approval layer for model-visible execution. Harness and quality bindings declare delivery policy and capability but do not create parallel trust or path-authorization systems.

## Verification

Use:

```bash
vesicle assets status
vesicle prompt shape --engine etl
bun run build:assets
bun run pack:check
```

The runtime asset archive and npm package must contain `harness-manifest.json`, `assets/`, and `host-assets/` together.

## Static Prompt Asset Ledger

`assets/prompt-context-ledger.json` is a raw, static Harness prompt-asset ledger. Its 24,000-character static asset limit is verified when a Harness is activated, but it is not a provider context-window limit and never blocks a request. Runtime injections and conversation history are deliberately excluded.

For Stage, `/stage` appends the frozen Module A source to the system message and sends the frozen Module B opening as assistant history. Those user-supplied values are intentionally outside the static asset ledger; their length belongs to provider/context management, not Harness asset review.
