import type { EngineId } from "../engine/profile";

/**
 * Persistent Instructions: user-authored Markdown that survives new sessions
 * and, at user scope, applies across project roots. This is the model context
 * layer described in `docs/dev/STYLE.md` § Persistent Instructions. It is not
 * automatic memory: the host never infers, summarizes, or writes instructions
 * without a model tool call (Increment B) or a direct user edit.
 */

/** Where an instruction target lives. User scope is portable across projects. */
export type InstructionScope = "user" | "project";

/**
 * `"all"` is the general target that every Engine inherits unless an exact
 * Engine override replaces it within the same scope. Any EngineId is an
 * Engine-specific override.
 */
export type InstructionEngine = "all" | EngineId;

/** One exact instruction target, identified by `{ scope, engine }` and never by an arbitrary path. */
export type InstructionTarget = {
  scope: InstructionScope;
  engine: InstructionEngine;
};

/**
 * Why a selected target was skipped. Absent targets never produce a
 * diagnostic — only targets that exist but cannot be used do. Diagnostics are
 * advisory: an invalid scope is skipped while the rest of the turn continues.
 */
export type InstructionDiagnosticKind =
  | "invalid-utf8"
  | "not-a-regular-file"
  | "linked-project-target"
  | "linked-user-target"
  | "oversized"
  | "combined-budget"
  | "read-error";

export type InstructionDiagnostic = {
  scope: InstructionScope;
  engine: InstructionEngine;
  logicalName: string;
  kind: InstructionDiagnosticKind;
  message: string;
};

/** A single instruction target resolved from disk. `empty` marks an intentional empty override. */
export type LoadedInstructionFile = {
  target: InstructionTarget;
  logicalName: string;
  /** Normalized content: leading UTF-8 BOM stripped, otherwise byte-exact. Empty string for an empty override. */
  content: string;
  /** SHA-256 of the normalized UTF-8 content the provider sees. */
  sha256: string;
  /** UTF-8 byte length of the normalized content. Zero for an empty override. */
  bytes: number;
  /** Whitespace-only or zero-byte content: a selected override that contributes no provider block. */
  empty: boolean;
};

/** The zero, one, or two instruction files selected for an Engine, plus diagnostics. */
export type EffectiveInstructionSelection = {
  engine: EngineId;
  user?: LoadedInstructionFile;
  project?: LoadedInstructionFile;
  diagnostics: InstructionDiagnostic[];
  combinedBytes: number;
  /** Ordered target identity plus per-file hash; distinguishes empty overrides and scope changes. */
  fingerprint: string;
};

/** Host-only session audit record. No full content, no absolute paths. */
export type InstructionResolutionFile = {
  target: InstructionTarget;
  logicalName: string;
  sha256: string;
  bytes: number;
  empty: boolean;
};

export type InstructionResolutionRecord = {
  version: 1;
  engine: EngineId;
  fingerprint: string;
  combinedBytes: number;
  files: InstructionResolutionFile[];
  diagnostics: InstructionDiagnostic[];
};
