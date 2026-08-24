<!-- Generated from docs/dev/ASSETS.md — do not edit. -->

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

Logical `assets/...` paths are the only asset namespace the model, provider, prompt loader, and the `stat_path` / `list_directory` / `grep_files` / `read_file` / `view_image` / `copy_file` tools ever see. The resolver supplies `list_directory` and Project State with a merged logical view while keeping every physical layer path private. Host-only locations — the user configuration directory, `node_modules`, the executable directory, and the Bun-compiled filesystem — stay behind the resolver and never surface as model-visible paths. Asset symlinks are rejected so direct reads, merged listings, integrity fingerprints, and path-boundary checks cannot disagree. The project root for `.vesicle/`, workspaces, artifacts, and sparse project overrides is the invocation directory or an explicit project argument; a standalone binary locates its bundled release defaults relative to `process.execPath` and does not change the working directory to make resolution succeed.

Every start and resume reverifies the active Harness identity. A mismatch at interactive resume offers the one-time session migration flow — offline preflight, two-stage confirmation, archive under `.vesicle/sessions/archive/`, durable `session-migration` record — instead of a dead end (contract in [`SESSIONS.md`](./SESSIONS.md)). Sessions recorded before bundled V10 activation carry no recorded identity and may migrate with their provenance marked as unrecorded.

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

The Output Quality Guard loads Rule Pack and Detector assets only from the verified Harness (failing closed on unknown schemas, matchers, metrics, preprocessing, or binding semantics) and applies the host delivery-quality policy as a durable, separate concept — never a second permission system. Its candidate extraction, deterministic detection, experimental Semantic Judge, host policy, rewrite lifecycle, session records, and the current unconnected calibrated-policy boundary are owned by [`QUALITY_GUARD.md`](./QUALITY_GUARD.md). `/permissions` remains the only approval layer for model-visible execution; Harness and quality bindings declare delivery policy and capability but do not create parallel trust or path-authorization systems.

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

## Prompt Customization Boundary

`vesicle assets materialize assets/prompts/engines/<id>.md` copies one effective prompt file into a sparse project or user layer so it can be edited as an overlay. The materialized file is the **compiled effective layer**: it already carries the Harness-generated Host Adapter Binding section that maps abstract Prism Driver operations (`hal://` URIs) to the concrete Vesicle tools, interaction gates, and quality bindings the model must call. Editing a materialized prompt must preserve that section — removing it leaves the model without the binding between Prism Driver operations and the host tools that implement them.

Source-layer prompt editing (the abstract `hal://` prompt before Harness compilation) and a `/prompt` or `prompt edit` workflow are **not** current product capabilities. The supported customization path is overlay-based editing of the compiled layer; the Harness compilation pipeline, the HAL URI system, and the Adapter Binding generation are unchanged.
