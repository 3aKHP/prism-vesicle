import type { EngineId } from "../engine/profile";
import type { HarnessQualityMode, VerifiedHarnessPack } from "../harness/types";
import type { ResponseUsage } from "../../providers/shared/types";

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
      metric: {
        signal: "em_dash_per_100_chars";
        operator: "gte" | "gt" | "lte" | "lt";
        threshold: number;
      };
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
};

export type QualityDecision = "pass" | "observe" | "rewrite" | "exhausted";

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
  decision: QualityDecision;
  findingIds: string[];
  detectorMs: number;
  usage?: ResponseUsage;
};

export type QualityEvaluation = {
  normalizedContent: string;
  candidateHash: string;
  findings: QualityFinding[];
  blockingFindings: QualityFinding[];
  detectorMs: number;
};

export type QualityRewriteState = {
  attempts: number;
  rejectedHashes: Set<string>;
  candidateParts?: string[];
  targets?: QualityArtifactTarget[];
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
};

export type QualityRuntimeSource = Pick<VerifiedHarnessPack,
  "directory" | "manifestSha256" | "manifest" | "driverContract" | "hostAdapter"
>;
