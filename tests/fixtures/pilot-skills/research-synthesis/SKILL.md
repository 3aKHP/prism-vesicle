---
name: research-synthesis
description: Research synthesis method that consolidates scattered notes and source materials into a structured brief. Use when asked to synthesize, consolidate, summarize research, or produce a brief from multiple source documents. Includes a word-count script for measuring source volume.
---

# Research Synthesis

Consolidate scattered source materials into a single structured research brief suitable for informing a subsequent writing phase.

## Procedure

1. **Scope sources**: Identify relevant files under `source_materials/` matching the user's topic or keyword constraints.
2. **Measure volume**: Run `scripts/word-count.sh` with the source paths to get per-file and total word counts. Report the volume to the user before proceeding.
3. **Extract claims**: For each source, extract the 3-5 most load-bearing factual claims or narrative premises.
4. **Cluster themes**: Group extracted claims into thematic clusters. Name each cluster with a short label.
5. **Resolve conflicts**: Where sources disagree, note the disagreement explicitly with both positions and their source attribution.
6. **Synthesize brief**: Write a structured brief to `workspace/research-brief.md` with sections: Overview, Thematic Clusters (one subsection each), Conflicts and Open Questions, Source Index.
7. **Cite**: Every claim in the brief must reference its source file by relative path.

## Script Usage

The bundled `scripts/word-count.sh` accepts file paths as arguments and prints a TSV of path, word count, and line count. It requires only POSIX sh and wc.

```
scripts/word-count.sh source_materials/note-a.md source_materials/note-b.md
```

## Boundaries

- Read only from `source_materials/` and write only to `workspace/`.
- Do not modify source files.
- Do not fabricate claims not present in the sources.
- If fewer than two sources match, ask the user whether to proceed with a single-source brief.
