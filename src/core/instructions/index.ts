export type {
  InstructionDiagnostic,
  InstructionDiagnosticKind,
  InstructionEngine,
  InstructionResolutionFile,
  InstructionResolutionRecord,
  InstructionScope,
  InstructionTarget,
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
