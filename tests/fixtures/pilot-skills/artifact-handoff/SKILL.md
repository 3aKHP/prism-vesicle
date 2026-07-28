---
name: artifact-handoff
description: Template-driven artifact handoff workflow for converting workspace drafts into delivery-ready documents. Use when asked to prepare, package, format, or hand off completed artifacts for external delivery or review.
---

# Artifact Handoff

Prepare workspace artifacts for external delivery by applying consistent formatting, metadata, and packaging conventions.

## Procedure

1. **Identify targets**: List files under `workspace/` or `novels/` matching the user's delivery scope.
2. **Validate completeness**: Confirm each target has a title heading, author/date metadata block, and no TODO/FIXME markers.
3. **Apply template**: Prepend the delivery header block (below) to each artifact that lacks one.
4. **Normalize formatting**: Ensure consistent heading hierarchy (H1 title, H2 sections, H3 subsections), remove trailing whitespace, and verify UTF-8 encoding.
5. **Generate manifest**: Write a `delivery-manifest.md` in `workspace/` listing each artifact with its path, word count, and last-modified timestamp.
6. **Report**: Summarize what was prepared, any issues found, and next steps for the user.

## Delivery Header Template

```markdown
---
title: {artifact title}
author: {from project context or user}
date: {current date}
status: delivery-ready
engine: {active engine id}
---
```

## Boundaries

- Write only to approved writable roots (`workspace/`, `novels/`, `reports/`).
- Do not modify files under `source_materials/` or `assets/`.
- Do not invoke validators or change gate state.
- If an artifact fails completeness checks, report the issue rather than guessing missing content.
