# Prism Runtime Assets

Prism Vesicle ships one verified V10 Harness baseline and a small, host-owned extension layer. V9 assets are no longer present in the working tree; Git history is the migration backup.

## Bundled Layout

```text
harness-manifest.json   # exact prism-harness-pack/v1 Release manifest
assets/                 # exact 47-file V10 Harness inventory
host-assets/            # 12 Vesicle-owned host extension files
```

The current bundled Harness is `prism-engine-v10@10.0.1-alpha.1`, sourced from Neural Narratology Release `harness-20260714-1` at commit `1aeb8b9acef4522889e5ba22728f8711390997b6`. The manifest SHA-256 is `15624186f8e55d2f107432c417a21a5a57d8116ff35c2dffe716f58e3e9eedc2`.

`assets/` must match the manifest inventory and hashes exactly. Do not add Vesicle notes, host-only profiles, or local experiments to that directory. Update the bundled baseline from a published Harness Release and verify the complete inventory rather than copying selected files from another checkout.

## Host Extension Layer

`host-assets/` supplies only an exact host whitelist:

- the externally declared `assets/prompts/shared/vesicle-base.md` and `assets/prompts/agents/base.md` prompts;
- profiles and prompts for the generic `explore`, `general`, `plan`, `research`, and `reviewer` SubAgents.

The three V10 workflow Agents (`scene-writer`, `continuity-editor`, and `chapter-reviewer`) belong to the Harness Pack and its Driver Contract. The five generic Agents remain ordinary Vesicle host extensions: they may execute concurrently and are not rebound as Harness delegations. No arbitrary project or user Agent receives that exemption.

## Resolution And Selection

Logical `assets/...` paths resolve through:

1. sparse project overrides;
2. sparse user-global overrides;
3. the project-selected managed Harness Pack, or the verified bundled V10 Harness when no project lock exists;
4. the restricted host extension layer.

Managed and bundled Harness baselines never merge file by file. A managed Pack may read only its declared `externalHostAssets` plus the fixed generic host Agent whitelist from `host-assets/`. `vesicle assets rollback` removes the project lock and returns to the bundled V10 baseline.

Every start and resume reverifies the active Harness identity. Sessions created before bundled V10 activation do not contain that identity and must start a new session rather than silently resuming under different runtime contracts.

## Verification

Use:

```bash
vesicle assets status
vesicle prompt shape --engine etl
bun run build:assets
bun run pack:check
```

The runtime asset archive and npm package must contain `harness-manifest.json`, `assets/`, and `host-assets/` together.
