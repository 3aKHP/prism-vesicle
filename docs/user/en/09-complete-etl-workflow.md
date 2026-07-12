# 09 — A Complete ETL Workflow

[← Previous: Sessions and resume](./08-sessions-and-resume.md) | [Manual index](./README.md) | [简体中文](../zh-CN/09-complete-etl-workflow.md)

## What You Will Accomplish

You will complete the two core ETL workflows with an original all-ages practice character: build a Module A character card through three confirmation checkpoints, build a Module B scenario card from one of three hooks, then preview and validate both artifacts.

**Estimated time:** 45–75 minutes

**Provider usage:** Several model requests; check your provider balance before starting

**Prerequisites:** Chapters 00–08, a tool-capable configured model, and a working ETL engine

## What ETL Produces

The Prism ETL engine converts source material into structured artifacts:

- **Module A — Character Card:** identity, appearance, biography, decision process, instincts, topology, voice, and world context
- **Module B — Scenario Card:** a playable situation, opening, user role, and a three-to-five-step beat map derived from the character

The ETL engine also supports DLC transforms and Lite persona prompts, but this first complete workflow focuses on Module A and Module B.

The current Prism v9 ETL asset contract writes creative content in Simplified Chinese while keeping structural headings and labels in English. This is expected even when you follow the English manual.

## Why This Exercise Is Controlled

The practice character is original, fictional, and all-ages. The source brief contains enough information for the workflow, so the model should not need Web or MCP research. Both output paths are specified in advance, making cleanup and validation predictable.

Model responses are not deterministic. Wording will vary, but the phase order, confirmation boundaries, file paths, and required document structure should remain stable.

## Step 1 — Create the Source Material

Exit Vesicle with Ctrl+Q. In PowerShell, confirm that you are in the tutorial project:

```powershell
Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"
```

Create the source-material folder and open a new practice brief:

```powershell
New-Item -ItemType Directory -Force "source_materials"
New-Item -ItemType File -Force "source_materials\mira-brief.md"
notepad "source_materials\mira-brief.md"
```

Copy this complete brief into Notepad:

```markdown
# Mira Vale Practice Brief

Mira Vale is an original all-ages character created for this tutorial.

- Age and role: 29-year-old night-shift signal technician in the floating rail city of Bellweather.
- Appearance: compact build, dark copper hair cut at the jaw, grey work coat with reflective seams, old brass radio earpiece, ink stains on two fingers.
- Public manner: precise, quiet, and more comfortable repairing systems than explaining feelings.
- Core desire: keep every passenger safe while proving that she never needs help.
- Origin event: as a junior technician, Mira reported a repeating warning tone that her supervisor ignored; a later signal failure injured her younger sister.
- Warm memory: her father taught her to repair radios by identifying each circuit through sound.
- Stress response: becomes terse, over-responsible, and unwilling to delegate.
- Positive shift: patient trust allows dry humor, collaborative problem-solving, and honest requests for help.
- Hard limit: she will never knowingly endanger civilians to protect her reputation or complete a schedule.
- Voice: short technical sentences at baseline; under pressure, comparisons to rhythm, static, and broken signals enter her speech.
- Current situation: unexplained signal echoes are appearing on a closed midnight rail line, and Mira has been assigned one outside investigator as a partner.
- Desired tone: atmospheric mystery, professional trust, restrained warmth, no explicit or adult content.
```

Save with Ctrl+S and close Notepad.

This file is input material. It belongs under `source_materials`, not `workspace`.

If you repeat this chapter later, move or rename earlier `mira_vale` practice outputs before starting so the model does not mistake an old partial file for the intended clean run.

## Step 2 — Start a Clean ETL Session

Launch Vesicle:

```powershell
bunx vesicle
```

Submit these local commands separately:

```text
/new
```

```text
/engine etl
```

`/new` prevents earlier tutorial conversation from distracting the workflow. `/engine etl` confirms that future turns use the ETL profile. Neither command calls the provider.

## Step 3 — Request the Module A Blueprint

Submit this prompt:

```text
Use ETL Workflow A to build a Module A character card for Mira Vale from source_materials/mira-brief.md.

This is an original all-ages practice character. Do not use Web or MCP tools. Use workspace/mira_vale.md as the target path.

Start with Phase 0 only: read the required schema, template, and source material; present Target Concept, Archetype, Core Desire, and Topology Notes; then request blueprint-confirmation. Do not create or edit any file before I confirm.
```

The model should read the schema, template, and source brief, then present a blueprint in the conversation. The bottom panel should show:

```text
Stop Gate: blueprint-confirmation
```

No `workspace\mira_vale.md` file should exist yet.

## Step 4 — Review the Blueprint Gate

Read both the full blueprint in the conversation and the compact gate summary. Check that it preserves:

- Mira's responsibility and refusal to delegate
- the ignored-warning origin event
- the possibility of a positive shift toward trust and asking for help
- the hard limit against knowingly endangering civilians
- the all-ages atmospheric mystery tone

If the blueprint is acceptable, keep **Confirm — proceed to next phase** selected and press Enter.

If something important is wrong, select **Reject — discuss or request changes**, type a concrete correction in the inline input, and press Enter. The model should revise or discuss the blueprint and request confirmation again. Rejecting a gate does not end the session.

Do not confirm merely because a panel appeared. The gate exists so you can prevent a mistaken blueprint from shaping every later section.

## Step 5 — Phase 1: The Shell

After confirmation, the model should create:

```text
workspace\mira_vale.md
```

Phase 1 writes only the static YAML frontmatter and `## Visual Cortex`, then pauses at:

```text
Stop Gate: phase-confirmation
```

The gate summary should name the file, report the completed sections, and say that Phase 2 is next.

Check that the path is correct and that the summary describes only the Phase 1 shell. Confirm to continue. If the wrong file was written or the model claims to have completed later sections already, reject with a specific explanation.

The partial Phase 1 file is not expected to pass the complete Module A validator yet.

## Step 6 — Phase 2: The Neuro-Structure

After the next confirmation, the model should extend the same file with:

- `## Biography`
- `## Cognitive Stack`, including explicit `Invariant:` and `Variant:` behavior
- `## Instinct Protocol`

It should then pause at another `phase-confirmation` gate and state that Phase 3 is next.

Review the summary. Confirm when the same target file was updated and the listed sections match Phase 2. Use Reject with feedback if the model loses the original character anchors or treats runtime state as static identity.

## Step 7 — Phase 3: Topology and Voice

After the third confirmation, the model should finish the character card with:

- `## Persona Topology`
  - `### Invariant Axes`
  - `### Variant Axes`
  - `### Boundary Conditions`
- `## Narrative Engine`
- `## World Context`

Phase 3 completes Workflow A and normally ends without another confirmation gate. The assistant should provide a handoff or completion note.

At this point, `workspace\mira_vale.md` should be a complete Module A card.

## Step 8 — Preview and Validate Module A

Preview the exact file:

```text
/artifact workspace/mira_vale.md
```

The preview is intentionally bounded, so a long document may be truncated in the conversation. The file on disk remains complete.

Validate it:

```text
/validate workspace/mira_vale.md
```

A clean result says validation passed. Findings are advisory rather than fatal. Common Module A findings involve missing sections, incorrect YAML fields, too few invariant or variant axes, no positive shift, or production-only L-System labels leaking into the artifact.

If validation reports issues, keep the session and exact file. Chapter 11 will teach a disciplined inspect–revise–validate loop. You may continue this tutorial if the card exists and is recognizable, but do not treat a failing card as publication-ready.

## Step 9 — Request Three Module B Hooks

Submit:

```text
Now use ETL Workflow B with workspace/mira_vale.md.

Propose three distinct all-ages mystery hooks grounded in Mira's topology and the closed midnight rail line. Use ask_user_question so I can choose one of the three hooks. After I choose, write the selected scenario to workspace/mira_vale_scenario_practice.md.
```

The model should read the completed character card, propose three hooks, and open a question panel. Vesicle adds **Skip** and an open-ended answer option after the three model-provided choices.

For this exercise, select one of the first three hooks with Up or Down and press Enter. Do not choose Skip, because the workflow needs a selected hook to build the scenario.

## Step 10 — Let Workflow B Write the Scenario

After your selection, the model continues the same ETL turn and should create:

```text
workspace\mira_vale_scenario_practice.md
```

Workflow B does not use the Phase 0/1/2 confirmation sequence from Workflow A. The explicit hook question is its user choice boundary.

The completed scenario should contain YAML frontmatter, a three-to-five-step `beat_map`, an opening paragraph, a first line of dialogue, and a hidden HTML comment block describing the premise, neural state, and user role.

## Step 11 — Preview and Validate Module B

Preview the scenario:

```text
/artifact workspace/mira_vale_scenario_practice.md
```

Validate it:

```text
/validate workspace/mira_vale_scenario_practice.md
```

Common Module B findings involve missing beat fields, fewer than three or more than five beats, tension values outside `0–100`, a trajectory that only rises, or behavior that cannot be derived from the character's variant axes.

## Step 12 — Confirm the Files in Windows

Exit Vesicle with Ctrl+Q. Open the workspace in File Explorer:

```powershell
explorer "workspace"
```

You should see:

```text
mira_vale.md
mira_vale_scenario_practice.md
```

Open the files in a text editor if you want to inspect the complete documents. Do not edit them during this exercise; Chapter 11 will introduce revision and revalidation.

## If the Workflow Deviates

### The model writes a file before blueprint confirmation

Do not continue confirming phases as though the boundary was respected. Record what happened. For a disposable practice run, start a fresh session and repeat the Phase 0 prompt with the no-write requirement stated clearly.

### The model describes a gate but no gate panel appears

Submit: `Do not advance. Call request_confirmation for the required current gate now.` A plain-text question is not equivalent to the host gate.

### The model asks for Web research

Reject or answer that the provided brief is sufficient and external research is not authorized for this exercise.

### A provider or tool error interrupts the workflow

Do not start over immediately. Run `/resume` after reconnecting and look for the session's pending gate or question marker. Append-only sessions are designed to preserve these pauses.

### The output path differs

Tell the model to use the exact practice path before continuing. Avoid validating an unexpected file merely because it appears in the artifact list.

## Completion Check

You have completed the core ETL workflow when:

- the source brief remains under `source_materials`
- Workflow A paused at one `blueprint-confirmation` and two `phase-confirmation` gates
- `workspace\mira_vale.md` contains all seven Module A sections
- Workflow B presented three hooks through `ask_user_question`
- `workspace\mira_vale_scenario_practice.md` contains a beat map and opening
- you previewed and validated both files by exact path
- you understand that confirmation is a review decision, not a button to press automatically

The next chapter will focus on artifact inspection, validation findings, targeted revision, and revalidation.

[Return to the manual index](./README.md)
