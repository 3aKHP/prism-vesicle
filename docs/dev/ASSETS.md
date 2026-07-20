# Prism Runtime Assets

Prism Vesicle ships one verified V10 Harness baseline and a small, host-owned extension layer. V9 assets are no longer present in the working tree; Git history is the migration backup.

## Bundled Layout

```text
harness-manifest.json   # exact prism-harness-pack/v1 Release manifest
assets/                 # exact 73-file V10 Harness inventory
host-assets/            # 12 Vesicle-owned host extension files
```

The current bundled Harness is `prism-engine-v10@10.1.0-rc.1`, sourced from Neural Narratology Release `harness-20260720-3` at commit `90f65c952bd5c84da9d1c5a22fbe87c3c583a70a`. The manifest SHA-256 is `a6f5f8eb096f6296794868a37ee46d2458600b827921a4b6cb8048c0603a1934`.

`assets/` must match the manifest inventory and hashes exactly. Do not add Vesicle notes, host-only profiles, or local experiments to that directory. Update the bundled baseline from a published Harness Release and verify the complete inventory rather than copying selected files from another checkout.

## Host Extension Layer

`host-assets/` supplies only an exact host whitelist for generic Vesicle Agents:

- profiles and prompts for the generic `explore`, `general`, `plan`, `research`, and `reviewer` SubAgents, including their common base prompts.

The rc.1 Harness owns all prompt sections declared by its Engine and workflow-Agent profiles, including `assets/prompts/host/`; its `externalHostAssets` list is empty. The three V10 workflow Agents (`scene-writer`, `continuity-editor`, and `chapter-reviewer`) belong to the Harness Pack and its Driver Contract. The five generic Agents remain ordinary Vesicle host extensions: they may execute concurrently and are not rebound as Harness delegations. No arbitrary project or user Agent receives that exemption.

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

## Static Prompt Asset Ledger

`assets/prompt-context-ledger.json` is a raw, static Harness prompt-asset
ledger. Its 24,000-character static asset limit is verified when a Harness is
activated, but it is not a provider context-window limit and never blocks a
request. Runtime injections and conversation history are deliberately
excluded.

For Stage, `/stage` appends the frozen Module A source to the system message
and sends the frozen Module B opening as assistant history. Those user-supplied
values are intentionally outside the static asset ledger; their length belongs
to provider/context management, not Harness asset review.
