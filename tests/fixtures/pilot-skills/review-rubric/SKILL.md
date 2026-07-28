---
name: review-rubric
description: Structured editorial review rubric for evaluating narrative prose quality. Use when asked to review, critique, or assess written output against defined quality dimensions. Does not replace or override the Evaluate engine's validators or pass/fail policy.
---

# Review Rubric

Apply this rubric when the user asks for a structured quality review of narrative prose. Score each dimension independently on a 1-5 scale with brief justification.

## Dimensions

### 1. Narrative Coherence (weight: high)
- Scene transitions are motivated and temporally clear
- Character actions follow from established psychology
- No unexplained knowledge leaks between POV characters

### 2. Prose Craft (weight: high)
- Sentence rhythm varies with emotional tempo
- Figurative language is earned, not decorative
- Dialogue is distinguishable by character without attribution tags

### 3. Structural Integrity (weight: medium)
- Beat map progression matches the scenario card trajectory
- Tension arc rises monotonically within each beat
- Chapter/scene boundaries align with dramatic units

### 4. Canon Fidelity (weight: medium)
- Character voice matches the Persona Topology axes
- Setting details are consistent with established world state
- L-System motifs appear at declared density without leakage

### 5. Reader Engagement (weight: low)
- Opening hook creates a question the reader wants answered
- Pacing alternates tension and release within beats
- Ending of each section creates forward pull

## Output Format

Produce a markdown table with one row per dimension, columns: Dimension | Score (1-5) | Key Evidence | Suggestion. Follow with a 2-3 sentence Overall Assessment summarizing the strongest and weakest dimensions.

## Boundaries

- This rubric supplements but does not replace the Evaluate engine's `evaluate-report` validator.
- Do not issue a PASS/CONDITIONAL/FAIL verdict; that belongs to the Evaluate engine.
- Do not modify files. This is a read-only assessment procedure.
