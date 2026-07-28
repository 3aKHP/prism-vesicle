import type { ValidationResult } from "./types";
import { findLeakedLSystemTags, makeValidationResult } from "./document-structure";

const RUNTIME_HUD_MARKERS = ["[Beat]", "[Tension]", "[Char]", "[Scene]", "[Turn]"];
const RUNTIME_NEURAL_CHAIN_FIELDS = ["Perception", "Instinct", "State", "Decision"];

export function validateRuntimePacket(content: string): ValidationResult {
  if (hasStageMarkers(content)) return validateStagePacket(content);
  const errors: string[] = [];
  const warnings: string[] = [];
  const comment = validateNeuralChain(content, "Runtime", RUNTIME_NEURAL_CHAIN_FIELDS, errors, warnings);
  validateOrderedPacketTail(content, comment?.end ?? 0, "Runtime", RUNTIME_HUD_MARKERS, errors);
  if (hasAnyStandaloneMarker(content, ["【Status】", "[Space-Time]", "[Physical]", "[Psychology]", "[Impression]"])) {
    errors.push("Runtime: packet mixes Runtime and Stage HUD markers.");
  }
  for (const tag of findLeakedLSystemTags(content)) errors.push(`Runtime: L-System tag "${tag}" leaked into the packet.`);
  return makeValidationResult(errors, warnings);
}

function hasStageMarkers(content: string): boolean {
  return hasAnyStandaloneMarker(content, ["【Status】", "[Space-Time]", "[Physical]", "[Psychology]", "[Impression]"]);
}

function validateStagePacket(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const comment = validateNeuralChain(content, "Stage", ["Perception", "Instinct", "State", "Strategy"], errors, warnings);
  validateOrderedPacketTail(
    content,
    comment?.end ?? 0,
    "Stage",
    ["【Status】", "[Space-Time]", "[Physical]", "[Psychology]", "[Beat]", "[Impression]"],
    errors,
  );
  if (hasAnyStandaloneMarker(content, ["[Tension]", "[Char]", "[Scene]", "[Turn]"])) {
    errors.push("Stage: packet mixes Stage and Runtime HUD markers.");
  }
  for (const tag of findLeakedLSystemTags(content)) errors.push(`Stage: L-System tag "${tag}" leaked into the packet.`);
  return makeValidationResult(errors, warnings);
}

function validateNeuralChain(
  content: string,
  owner: "Runtime" | "Stage",
  fields: readonly string[],
  errors: string[],
  warnings: string[],
): { end: number } | undefined {
  const leading = content.search(/\S/);
  if (leading < 0 || !content.startsWith("<!--", leading)) {
    errors.push(`${owner}: Part 1 must begin with a Hidden Neural Chain HTML comment.`);
    return undefined;
  }
  const close = content.indexOf("-->", leading + 4);
  if (close < 0) {
    errors.push(`${owner}: Hidden Neural Chain HTML comment is not closed.`);
    return undefined;
  }
  const comment = content.slice(leading + 4, close);
  if (!/^\s*\[!Neural Chain\]\s*$/m.test(comment)) {
    errors.push(`${owner}: Hidden Neural Chain block ([!Neural Chain]) is missing.`);
  }
  let previous = -1;
  for (const field of fields) {
    const matches = [...comment.matchAll(new RegExp(`^${field}:\\s*\\S.*$`, "gm"))];
    if (matches.length !== 1) {
      warnings.push(`${owner}: Neural Chain must contain exactly one non-empty "${field}:" line.`);
      continue;
    }
    const position = matches[0]!.index;
    if (position <= previous) errors.push(`${owner}: Neural Chain field "${field}:" is out of order.`);
    previous = position;
  }
  return { end: close + 3 };
}

function validateOrderedPacketTail(
  content: string,
  start: number,
  owner: "Runtime" | "Stage",
  markers: readonly string[],
  errors: string[],
): void {
  const tail = content.slice(start);
  let previous = -1;
  let proseStart = -1;
  let hudStart = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const suffix = marker === "【Status】" ? "[ \\t]*" : "[ \\t]*\\S.*";
    const matches = [...tail.matchAll(new RegExp(`^[ \\t]*${escaped}${suffix}$`, "gm"))];
    if (matches.length !== 1) {
      errors.push(`${owner}: Dynamic HUD must contain exactly one non-empty ${marker} line.`);
      continue;
    }
    const position = matches[0]!.index;
    hudStart = Math.min(hudStart, position);
    if (position <= previous) errors.push(`${owner}: Dynamic HUD marker ${marker} is out of order.`);
    previous = position;
    proseStart = Math.max(proseStart, position + matches[0]![0].length);
  }
  if (Number.isFinite(hudStart) && tail.slice(0, hudStart).trim()) {
    errors.push(`${owner}: content appears between Part 1 and the Dynamic HUD.`);
  }
  if (proseStart < 0 || !tail.slice(proseStart).trim()) errors.push(`${owner}: Part 3 prose content is empty.`);
}

function hasAnyStandaloneMarker(content: string, markers: readonly string[]): boolean {
  return markers.some((marker) => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^[ \\t]*${escaped}(?:[ \\t]|$)`, "m").test(content);
  });
}
