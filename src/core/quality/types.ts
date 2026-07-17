import type { EngineId } from "../engine/profile";
import type { HarnessQualityMode, VerifiedHarnessPack } from "../harness/types";
import type { ProviderThinkingBlock, ResponseUsage } from "../../providers/shared/types";

export type QualityCandidateType =
  | "runtime.prose"
  | "dyad.character-response"
  | "scene.prose"
  | "orchestrator-authored-prose"
  | "audit.target-prose";

export type QualityProtectedRange = {
  start: number;
  end: number;
};

export type QualityDocumentMetricSignal =
  | "micro_action_per_1000_chars"
  | "action_list_verbs_per_paragraph"
  | "cliche_per_1000_chars"
  | "metaphor_markers_per_1000_chars"
  | "reasoning_chain_per_1000_chars"
  | "abstract_summary_per_1000_chars";

export type QualityMetricSignal = "em_dash_per_100_chars" | QualityDocumentMetricSignal;

export type QualityMetricPattern = {
  id: string;
  value: string;
  flags?: string;
  core?: boolean;
};

export type QualityMetric = {
  signal: QualityMetricSignal;
  operator: "gte" | "gt" | "lte" | "lt";
  threshold: number;
  minimumMatches?: number;
  minimumCoreMatches?: number;
  minimumBuckets?: number;
  minimumSeparators?: number;
  excludeDialogue?: true;
  patterns?: QualityMetricPattern[];
};

export type QualityMatcher =
  | {
      kind: "literal" | "regex";
      value: string;
      unit: "candidate" | "paragraph" | "sentence";
      flags?: string;
    }
  | {
      kind: "metric";
      unit: "candidate" | "paragraph" | "sentence";
      metric: QualityMetric;
    };

export type QualityDetectorRule = {
  id: string;
  tier: string;
  lang: string;
  title: string;
  severity: string;
  maturity: "experimental" | "stable";
  targets: string[];
  matcher: QualityMatcher;
  source: string;
};

export type QualityJudgeRule = {
  id: string;
  title: string;
  severity: string;
  maturity: "experimental" | "stable";
  targets: string[];
  source: string;
  evidence: {
    mode: "exact-substring";
    minCodePoints: number;
    maxCodePoints: number;
  };
};

export type QualityJudgeContract = {
  rubric: string;
  rules: QualityJudgeRule[];
};

export type QualitySemanticRewriteModelScope = {
  protocol: "openai-chat-compatible" | "anthropic-messages" | "gemini-generate-content";
  modelFamily: string;
  modelIds: string[];
};

export type QualitySemanticRewritePolicy = {
  schema: "quality-semantic-rewrite-policy/v1";
  module: "anti-ai-flavor";
  policyVersion: "quality-policy/v2";
  activation: "inactive" | "active";
  targetTypes: QualityCandidateType[];
  blockingRuleIds: string[];
  minimumConfidenceByRule: Record<string, number>;
  modelScopes: QualitySemanticRewriteModelScope[];
  onUnknownModel: "observe";
  onInconclusive: "observe";
  multiTargetAction: "inconclusive" | "rewrite-with-warning";
  calibration: {
    corpusSha256: string;
    reportSha256: string;
    thresholdVersion: string;
  };
};

export type QualityRulePackManifest = {
  schema: "rule-pack/v1";
  module: "anti-ai-flavor";
  version: string;
  primaryLanguage: string;
  sourceRepository: string;
  sourceCommit: string;
  sourceState: "clean" | "dirty";
  sourceHash: string;
  moduleInputHash: string;
  compilerHash: string;
  ruleCount: number;
  projectionCounts: {
    guidance: number;
    detector: number;
    judge: number;
    replacement: number;
  };
  requiredCapabilities: string[];
  preprocessing: {
    line_endings: "LF";
    unicode_normalization: "NFC";
    offset_basis: "normalized-candidate";
    protected_regions: string[];
  };
  artifacts: Record<string, string>;
};

export type QualityRuntimeContext = {
  packDirectory: string;
  packId: string;
  packVersion: string;
  sourceCommit: string;
  manifestSha256: string;
  ruleManifest: QualityRulePackManifest;
  rules: QualityDetectorRule[];
  judge?: QualityJudgeContract;
  semanticRewritePolicy?: QualitySemanticRewritePolicy;
  engineModes: Record<string, HarnessQualityMode>;
  agentModes: Record<string, HarnessQualityMode>;
};

export type QualityCandidate = {
  producer: EngineId | string;
  type: QualityCandidateType;
  content: string;
  protectedRanges?: QualityProtectedRange[];
};

export type QualityArtifactOperation = "create" | "write" | "replace" | "append";

export type QualityArtifactTarget = {
  id: `artifact:${string}`;
  kind: "artifact-post-image";
  candidateType: QualityCandidateType;
  path: string;
  operation: QualityArtifactOperation;
  mutationCallIds: string[];
  postImageHash: string;
  bytes: number;
  rejectedHashes: Set<string>;
};

export type DurableQualityArtifactTarget = Omit<QualityArtifactTarget, "rejectedHashes"> & {
  rejectedHashes: string[];
};

export type QualityFinding = {
  ruleId: string;
  title: string;
  severity: string;
  maturity: "experimental" | "stable";
  start: number;
  end: number;
  evidence: string;
  source?: "detector" | "judge";
  confidence?: number;
  explanation?: string;
  rewriteInstruction?: string;
  metric?: {
    signal: QualityMetricSignal;
    value: number;
    threshold: number;
  };
};

export type QualityFindingSummary = Pick<QualityFinding,
  "ruleId" | "title" | "severity" | "maturity" | "evidence" | "confidence"
> & {
  source: "detector" | "judge";
};

export type QualityJudgeStatus = "not-run" | "valid" | "invalid" | "timed-out" | "unavailable";

export type QualityAssessment = {
  targetId: string;
  candidateHash: string;
  detectorFindings: QualityFinding[];
  judgeFindings: QualityFinding[];
  judgeStatus: QualityJudgeStatus;
};

export type QualityOutcome = "clean" | "findings" | "rewrite-required" | "exhausted" | "inconclusive";

export type QualityAction = "deliver" | "observe" | "rewrite" | "ask-user";

export type QualityDecision = "pass" | "observe" | "rewrite" | "exhausted";

export type QualityEventTarget = {
  id: string;
  kind: "assistant-response" | "artifact-post-image";
  path?: string;
  candidateHash: string;
  bytes?: number;
  status: "clean" | "findings" | "rewrite-required" | "warning";
  findingIds: string[];
  findings: QualityFindingSummary[];
  warningReason?: QualityTargetWarningReason;
};

export type QualityArtifactReadResult = {
  target: QualityArtifactTarget;
  content?: string;
  warningReason?: "target-unreadable" | "target-oversize";
};

export type QualityEvent = {
  guard: "anti-ai-flavor";
  packId: string;
  packVersion: string;
  manifestSha256: string;
  ruleVersion: string;
  ruleSourceHash: string;
  producer: string;
  candidateType: QualityCandidateType;
  candidateHash: string;
  mode: HarnessQualityMode;
  attempt: number;
  outcome: QualityOutcome;
  action: QualityAction;
  policyVersion: "quality-policy/v1";
  targets: QualityEventTarget[];
  /** Legacy projection retained for existing session readers. */
  decision: QualityDecision;
  findingIds: string[];
  detectorMs: number;
  judgeMs?: number;
  judgeStatus?: QualityJudgeStatus;
  judgeProvider?: string;
  judgeModel?: string;
  judgeRequestCount?: number;
  judgeUsage?: ResponseUsage;
  usage?: ResponseUsage;
};

export type QualityEvaluation = {
  normalizedContent: string;
  candidateHash: string;
  findings: QualityFinding[];
  blockingFindings: QualityFinding[];
  detectorStatus: "complete" | "budget-exhausted";
  detectorMs: number;
};

export type QualityRewriteState = {
  attempts: number;
  rejectedHashes: Set<string>;
  candidateParts?: string[];
  targets?: QualityArtifactTarget[];
  warningId?: string;
  warningTargetIds?: string[];
  candidate?: QualityDecisionCandidate;
};

export type QualityDecisionCandidate = {
  responseId: string;
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  reasoningContent?: string;
  thinkingBlocks?: ProviderThinkingBlock[];
  finishReason?: string;
  usage?: ResponseUsage;
};

export type DurableQualityState = {
  producer: EngineId;
  packId: string;
  packVersion: string;
  manifestSha256: string;
  ruleVersion: string;
  ruleSourceHash: string;
  attempts: number;
  rejectedHashes: string[];
  candidateParts: string[];
  targets: DurableQualityArtifactTarget[];
  warningId?: string;
  warningTargetIds?: string[];
  candidate?: QualityDecisionCandidate;
};

export type QualityTargetWarningReason =
  | "judge-invalid"
  | "judge-timeout"
  | "judge-unavailable"
  | "detector-budget-exhausted"
  | "target-unreadable"
  | "target-oversize";

export type QualityWarningReason =
  | "exhausted"
  | QualityTargetWarningReason
  | "user-abandoned";

export type QualityWarningTarget = QualityEventTarget & {
  resolution?: "accepted-by-user" | "stopped-by-user";
};

export type QualityWarning = {
  id: string;
  guard: "anti-ai-flavor";
  reason: QualityWarningReason;
  producer: EngineId;
  attempt: number;
  targets: QualityWarningTarget[];
};

export type QualityResolution = {
  warningId: string;
  resolution: "revised-clean" | "accepted-by-user" | "stopped-by-user";
  targetIds: string[];
};

export type QualityDecisionRequest = {
  id: string;
  reason: "exhausted" | "interrupted";
  producer: EngineId;
  findingCount: number;
  targets: Array<{ id: string; path?: string; findingIds: string[] }>;
  canRetry: boolean;
  blockedReason?: string;
};

export type QualityDecisionPoint = {
  request: QualityDecisionRequest;
  warning: QualityWarning;
  qualityState: DurableQualityState;
  candidate: QualityDecisionCandidate;
  phase: "before-mutations" | "after-mutations";
  candidateRecorded: boolean;
};

export type QualityRuntimeSource = Pick<VerifiedHarnessPack,
  "directory" | "manifestSha256" | "manifest" | "driverContract" | "hostAdapter"
>;
