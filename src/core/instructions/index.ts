export type {
  InstructionBackupState,
  InstructionDiagnostic,
  InstructionDiagnosticKind,
  InstructionEngine,
  InstructionResolutionFile,
  InstructionResolutionRecord,
  InstructionScope,
  InstructionTarget,
  InstructionToolEvent,
  EffectiveInstructionSelection,
  LoadedInstructionFile,
} from "./types";
export { INSTRUCTION_FILE_BASE, instructionFilePath, instructionLogicalName, instructionScopeDirectory } from "./paths";
export { INSTRUCTION_COMBINED_BUDGET_BYTES, loadInstructionTarget } from "./loader";
export type { TargetLoadResult } from "./loader";
export {
  composeInstructionBlocks,
  composeSystemPromptWithInstructions,
  computeFingerprint,
  resolutionEqual,
  resolveEffectiveSelection,
  selectionToRecord,
} from "./compose";
export { freezeInstructionBlocks, readFrozenInstructionBlocks, clearFrozenInstructionBlocks } from "./instruction-context";
export {
  readInstructionsToolDefinition,
  updateInstructionsToolDefinition,
  instructionToolDefinitions,
  executeReadInstructionsTool,
  executeUpdateInstructionsTool,
} from "./tools";
export type { InstructionToolOptions } from "./tools";
export { InstructionUpdateError, updateInstructionTarget } from "./store";
export type { InstructionUpdateOutcome } from "./store";
