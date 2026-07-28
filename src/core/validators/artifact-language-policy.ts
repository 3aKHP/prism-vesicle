const NOT_X_BUT_Y_RULE_ID = "zh-f1-not-x-but-y";

// This intentionally mirrors the verified anti-AI Rule Pack matcher. Artifact
// Validator coverage is an advisory bridge until Quality Guard artifact
// extraction and delivery policy are designed as a separate change.
const NOT_X_BUT_Y_PATTERN = /不是[^。！？!?]{1,30}而是/u;

export function artifactLanguagePolicyWarnings(moduleName: "Module A" | "Module B", content: string): string[] {
  if (!NOT_X_BUT_Y_PATTERN.test(content)) return [];
  return [
    `${moduleName}: artifact text matches the prohibited “不是……而是……” contrast pattern (Rule ${NOT_X_BUT_Y_RULE_ID}).`,
  ];
}
