/** Public, language-neutral evidence interchange. Paths are relative to the evidence root. */
export type Stage = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6";
export type VerificationStatus = "passed" | "failed" | "skipped" | "unavailable";
export interface HashedFile { path: string; sha256: string }
export interface Capability {
  id: string;
  /** Defaults to preservation. Infrastructure records acceptance work, not a Rust feature. */
  kind?: "preservation" | "infrastructure";
  domain: string;
  behavior: string;
  anchors: string[];
  introducedAt: string;
  tsStatus: "implemented" | "experimental";
  targetStage: Stage;
  scenarioIds: string[];
  conditions: string[];
  implementation: string[];
  verificationIds: string[];
  rustStatus: "not_started" | "partial" | "implemented" | "verified";
}
export interface Scenario {
  id: string;
  capabilityIds: string[];
  requiredStage: Stage;
  prerequisites: string[];
  input: HashedFile;
  action: string;
  assertions: string[];
  normalization: string[];
  negativeCase: string;
  kind: "offline" | "live" | "native" | "human";
}
export interface Verification {
  id: string;
  scenarioId: string;
  tsSha: string;
  rustSha: string | null;
  artifact: HashedFile;
  environment: string;
  toolVersions: string[];
  command: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  status: VerificationStatus;
  assertions: string[];
  log: HashedFile;
  gapReason: string | null;
}
export interface BaselineEntry {
  id: string;
  source: string;
  sourceHash: string;
  capabilityIds: string[];
  nonCapabilityReason: string | null;
}
export interface Difference {
  id: string;
  capabilityId: string;
  oldBehavior: string;
  newBehavior: string;
  classification: "regression" | "fix" | "addition";
  impact: string;
  basis: string;
  ownerDecision: string | null;
  scenarioIds: string[];
  status: "open" | "resolved";
}
export interface BoundaryGate {
  id: "H1" | "H4" | "H5";
  requiredBefore: Stage;
  scenarioIds: string[];
  package: HashedFile;
  observer: string | null;
  candidate: HashedFile | null;
  candidateSha: string | null;
  status: "pending" | "passed" | "failed";
  verificationIds: string[];
}
export interface EvidenceBundle {
  schemaVersion: 1;
  stage: Stage;
  tsBaselineSha: string;
  candidateSha: string;
  capabilities: Capability[];
  scenarios: Scenario[];
  baseline: BaselineEntry[];
  verifications: Verification[];
  differences: Difference[];
  boundaryGates: BoundaryGate[];
}
