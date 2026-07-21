import type {
  QualityCandidateType,
  QualityFinding,
  QualityJudgeStatus,
  QualitySemanticRewritePolicy,
} from "./types";

export type QualitySemanticRewritePolicyEvaluation = {
  decision: "observe" | "inconclusive" | "eligible";
  findings: QualityFinding[];
};

/**
 * This is deliberately a pure eligibility check. Runtime rewrite remains gated
 * separately until held-out and preservation evidence promotes the policy.
 */
export function evaluateSemanticRewritePolicy(options: {
  policy: QualitySemanticRewritePolicy | undefined;
  judgeStatus: QualityJudgeStatus;
  candidateType: QualityCandidateType;
  protocol?: QualitySemanticRewritePolicy["modelScopes"][number]["protocol"];
  modelId?: string;
  findings: QualityFinding[];
}): QualitySemanticRewritePolicyEvaluation {
  const { policy } = options;
  if (!policy || policy.activation !== "active") return { decision: "observe", findings: [] };
  if (options.judgeStatus !== "valid") return { decision: "inconclusive", findings: [] };
  if (!policy.targetTypes.includes(options.candidateType) || !options.protocol || !options.modelId) {
    return { decision: "observe", findings: [] };
  }
  const scope = policy.modelScopes.find((item) => item.protocol === options.protocol && item.modelIds.includes(options.modelId!));
  if (!scope) return { decision: "observe", findings: [] };
  const findings = options.findings.filter((finding) => finding.source === "judge"
    && policy.blockingRuleIds.includes(finding.ruleId)
    && finding.confidence !== undefined
    && finding.confidence >= policy.minimumConfidenceByRule[finding.ruleId]!);
  return findings.length > 0 ? { decision: "eligible", findings } : { decision: "observe", findings: [] };
}
