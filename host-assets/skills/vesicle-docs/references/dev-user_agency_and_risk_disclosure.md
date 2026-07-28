<!-- Generated from docs/dev/USER_AGENCY_AND_RISK_DISCLOSURE.md — do not edit. -->

# User Agency And Risk Disclosure

> Status: approved cross-cutting product and engineering guidance

This document defines Prism Vesicle's cross-cutting design policy for user choice, risk disclosure, warnings, confirmations, and host-enforced boundaries. It applies to Skills, process execution, MCP, providers, extensions, imports, project-local configuration, and future distribution surfaces.

## Core Principle

Vesicle should inform users about material risk without silently replacing their decisions with host policy. A valid user-selected action should proceed under the capabilities and permission mode the user already chose unless the host cannot execute it correctly, cannot represent it faithfully, or is required to enforce a separately declared boundary.

More warnings and confirmations do not automatically produce more safety. Technically experienced users can inspect sources and evaluate tradeoffs; users without that experience are not made meaningfully safer by dense jargon, repeated trust ceremonies, or a host that implies it has certified content it cannot actually understand. The product obligation is to make decision-relevant facts legible and actions observable, not to act as an infallible judge of user intent.

This principle does not remove filesystem guards, protocol validation, capability checks, permission modes, data-integrity rules, or managed organizational policy. It distinguishes those enforceable runtime contracts from speculative judgments about whether a user's chosen content or workflow is acceptable.

## Decision Classification

Before adding a rejection, warning, confirmation, quarantine state, or hidden downgrade, classify the condition:

| Condition | Product response |
|---|---|
| Technically invalid or unrepresentable | Reject with a precise explanation. Examples: malformed required schema, path escaping a declared root, ambiguous path normalization, corrupted state, or an unsupported filesystem object in a portable bundle. |
| Capability unavailable | Do not pretend to execute. Explain which capability is missing and how the user can enable or choose an applicable runtime. |
| Material ambiguity | Ask one focused question only when different interpretations would materially change the result. Do not use confirmation as a substitute for deterministic selection rules. |
| Valid but risk-bearing | Disclose source, action, authority, side effects, and reversibility, then honor the user's choice and current permission mode. |
| Destructive or externally consequential action | Route through the same existing permission or confirmation contract as an equivalent action from any other source. Do not add a second subsystem-specific gate without evidence that the ordinary contract is insufficient. |
| Explicit managed policy | Enforce it and identify the authority, such as an organization policy, Engine capability contract, or platform requirement. Do not present managed policy as if it were the user's own risk preference. |

A refusal must name the correctness, capability, or declared-policy boundary it protects. "Potentially unsafe" by itself is not a sufficient design justification.

## Required Product Behavior

### Disclose, do not certify

Show the facts the user can act on: source, resolved version or identity, requested capability, bundled executable content, expected external effects, current permission mode, and available rollback or recovery. A warning is not a security certificate. The absence of a warning must never imply that instructions, code, dependencies, or remote content have been proven benign.

Static analysis and heuristics may produce useful findings, but heuristic findings are informational unless they establish a concrete technical violation. The host should not convert uncertain semantic interpretation into a hidden denylist or content-approval system.

### Preserve the selected permission mode

The same effective action should receive the same permission treatment regardless of whether it originated in a direct user request, an activated Skill, an MCP-guided workflow, or ordinary model reasoning. An extension may not grant itself authority, but its origin alone must not silently reduce authority or force an additional approval layer.

Permission modes remain authoritative. A subsystem must not claim to honor MOMENTUM or YOLO while quietly imposing mandatory per-call confirmation, and it must not bypass MANUAL or INERTIA because metadata declares an action allowed.

### One decision, one gate

An explicit, unambiguous command is already a user decision. Do not immediately ask the user to confirm the same fact again. Additional input is appropriate for unresolved selection, missing required information, an overwrite target, or a materially different side effect that was not visible when the command was issued.

Repeated warnings should be avoided when the source, version, requested authority, and effective permission mode have not changed. Provide an inspect path for detail instead of making every user traverse the full disclosure repeatedly.

### Keep equivalent actions equivalent

Controls should attach to the effect, not to a label such as "third-party," "generated," "script," or "extension." Running a bundled Skill script through Process Runtime should follow the same process, environment, network, cancellation, output, and permission contracts as an equivalent process action. A new source category is not by itself evidence that a new security tier is needed.

### Prefer provenance and reversibility

When practical, preserve source identity, resolved commits, content hashes, diffs, durable events, immutable snapshots, and rollback. These mechanisms improve informed choice, debugging, and recovery without claiming to judge intent. Prefer making a consequential action inspectable and reversible over preventing all users from taking it.

## Enforceable Host Boundaries

Vesicle may and should enforce boundaries required for reliable execution:

- schema and protocol validity;
- path containment, canonicalization, and filesystem object compatibility;
- atomic persistence, concurrency control, identity checks, and corruption detection;
- the active Engine, Agent, provider, tool, and writable-root capability contract;
- the existing Tool Permission Runtime and Process Runtime behavior;
- credential handling, secret redaction, output bounds, cancellation, and process cleanup;
- explicit platform, organization, or distribution policy;
- honest refusal when an operation cannot be performed as represented.

These are not judgments that the user selected the wrong content. They are conditions under which Vesicle can keep its own promises. Implementations should explain this distinction in diagnostics: prefer "cannot be represented inside the Skill root" over "blocked because the Skill is untrusted."

## Disclosure UX

A risk disclosure should answer, in plain language:

1. What source or component is involved?
2. What exact action is about to occur?
3. Which filesystem, process, network, provider, or external-service authority can it use?
4. Which permission mode or managed policy will govern it?
5. What state may change, and can that change be inspected, undone, or rolled back?

Use a compact summary at the decision point and an inspection surface for details. Distinguish installed content from actions that have actually executed. Do not overload non-expert users with raw hashes, dependency graphs, or generic threat language when a plain statement of effect is available; keep technical provenance accessible for users who want it.

Warnings should be proportional, specific, and actionable. Avoid generic red banners for ordinary capabilities the user has already enabled. Do not use labels such as "safe," "trusted," or "verified" unless the product defines exactly what was verified and the claim is limited to that property.

## Anti-Patterns

Do not introduce these patterns without a concrete, reviewed reason:

- a second `trusted` state after the user explicitly installed or selected valid content;
- mandatory confirmation immediately after an unambiguous install or execution command;
- treating all scripts as a deferred or quarantined plugin class solely because they are executable;
- blocking content because a heuristic scanner considers its intent suspicious;
- silently disabling network, filesystem, process, or tool behavior while claiming to use the selected permission mode;
- making advanced users find a hidden escape hatch to perform an otherwise valid action;
- presenting a long technical warning to non-expert users without explaining the actual effect or available recovery;
- implying that content without warnings has been reviewed or certified;
- multiplying prompts to demonstrate caution rather than addressing a concrete decision boundary.

## Examples

| Scenario | Correct treatment |
|---|---|
| Install a Skill from a GitHub URL | Show repository, selected Skill root, requested ref, resolved commit, bundle inventory, and scripts. Install the immutable snapshot without a redundant trust confirmation when the command is unambiguous. |
| Execute a bundled Skill script | Show the script and effective process authority, then use the current Process and Tool Permission Runtime behavior. Do not impose a Skill-only approval mode. |
| A Skill declares `allowed-tools` | Preserve and display the metadata for compatibility. It neither grants tools nor forces a denial; the current effective tool surface remains authoritative. |
| A repository contains an escaping symlink or socket | Reject the affected portable bundle because it cannot be represented within the declared root, not because the repository is presumed malicious. |
| A remote branch changes | Resolve installations to immutable commits, show the update diff, and retain rollback. This is reproducibility and recovery, not a trust score. |
| Two nested Skills are plausible install targets | Ask the user to select one or use an explicit path. The question resolves ambiguity rather than seeking risk consent. |
| A process action deletes or overwrites data | Apply the ordinary permission and destructive-action contract for that effect, regardless of whether a Skill suggested it. |

## Review Checklist

Before accepting a new protective control, ask:

- Is the condition technically invalid, unavailable, ambiguous, destructive, or governed by an explicit external policy?
- Can the refusal be tied to a concrete contract rather than a generalized fear of third-party content?
- Has the user already made this exact decision through an unambiguous command or permission-mode choice?
- Would the same effect receive different treatment if it came from ordinary model reasoning?
- Does the warning tell the user what will happen, under which authority, and how to recover?
- Can an informed user proceed without a hidden flag or unsupported workaround?
- Does the design help a non-expert understand the effect, or merely expose more security terminology?
- Could provenance, observability, atomicity, or rollback address the risk more directly than prohibition?
- Does the UI avoid implying certification when only format or integrity was checked?
- Is every additional confirmation backed by a distinct decision that has not already been made?

## Relationship To Other Contracts

[`ARCHITECTURE.md`](./ARCHITECTURE.md) routes architecture, capability, filesystem, provider, session, and runtime boundaries to their authoritative domain contracts. [`STYLE.md`](./STYLE.md) governs source-code structure and maintainability, while [`WORKFLOW.md`](./WORKFLOW.md) governs development and publication authorization. Feature-specific documents such as [`SKILLS.md`](./SKILLS.md) apply this policy to their domain and may add concrete disclosures or technical validity rules, but must not weaken user agency through an undeclared subsystem-specific trust model.
