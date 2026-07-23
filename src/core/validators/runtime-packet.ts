import type { ValidationResult } from "./index";
import { findLeakedLSystemTags, makeValidationResult } from "./document-structure";

const RUNTIME_HUD_MARKERS = ["[Beat]", "[Tension]", "[Char]", "[Scene]", "[Turn]"];
const RUNTIME_NEURAL_CHAIN_FIELDS = ["Perception", "Instinct", "State", "Decision"];

export function validateRuntimePacket(content: string): ValidationResult {
  if (isStagePacket(content)) return validateStagePacket(content);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!content.includes("[!Neural Chain]")) errors.push("Runtime: Hidden Neural Chain block ([!Neural Chain]) is missing.");
  for (const field of RUNTIME_NEURAL_CHAIN_FIELDS) {
    if (!content.includes(`${field}:`)) warnings.push(`Runtime: Neural Chain field "${field}:" is missing.`);
  }
  for (const marker of RUNTIME_HUD_MARKERS) {
    if (!content.includes(marker)) errors.push(`Runtime: Dynamic HUD is missing line marker ${marker}.`);
  }
  for (const tag of findLeakedLSystemTags(content)) errors.push(`Runtime: L-System tag "${tag}" leaked into the packet.`);
  return makeValidationResult(errors, warnings);
}

function isStagePacket(content: string): boolean {
  return content.includes("【Status】") || content.includes("[Space-Time]") || content.includes("[Psychology]");
}

function validateStagePacket(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!content.includes("[!Neural Chain]")) errors.push("Stage: Hidden Neural Chain block ([!Neural Chain]) is missing.");
  for (const field of ["Perception", "Instinct", "State", "Strategy"]) {
    if (!content.includes(`${field}:`)) warnings.push(`Stage: Neural Chain field "${field}:" is missing.`);
  }
  for (const marker of ["【Status】", "[Space-Time]", "[Physical]", "[Psychology]", "[Beat]", "[Impression]"]) {
    if (!content.includes(marker)) errors.push(`Stage: Dynamic HUD is missing line marker ${marker}.`);
  }
  for (const tag of findLeakedLSystemTags(content)) errors.push(`Stage: L-System tag "${tag}" leaked into the packet.`);
  return makeValidationResult(errors, warnings);
}
