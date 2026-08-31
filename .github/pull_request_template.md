<!--
  One PR, one main intent (docs/dev/WORKFLOW.md "Hard Rules").

  Grade - keep the applicable one (WORKFLOW.md § Change Grading Workflow):
    Quick PR     Bot Review, one round
    Standard PR  independent CR SubAgent + Bot Review (dual-track)
    Huge PR      topic document first; Deep-CR over the whole change
    Hot-Fix      to `main` for a blocking regression; forward-merge back to `develop`

  Issue linking: "Closes #<issue>" below is the authoritative closing
  declaration - the close-issues bridge reads this body when the commits reach
  `main` through a release PR. Closing keywords match anywhere in the body, so
  use "Refs #<issue>" for related work, and leave a tracking comment on the
  issue meanwhile. Delete the Closes line when no issue applies.
-->

Grade: Quick PR

Closes #<issue>

## Summary

- ...

## Test Plan

- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun run doctor`
- [ ] Targeted tests / smoke for the change class (see Verification Matrix)

## Notes / Follow-ups

- ...
