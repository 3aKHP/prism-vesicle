import type { HarnessDriverContract, HarnessHostAdapter } from "./driver";

export const harnessQualityModes = ["off", "observe", "rewrite", "strict", "analyze"] as const;

export type HarnessQualityMode = typeof harnessQualityModes[number];

export type HarnessDriverIdentity = {
  contract: string;
  contractHash: string;
  contractSourceHash: string;
  adapter: string;
  adapterHash: string;
  adapterSourceHash: string;
  adapterId: string;
  adapterVersion: string;
  targetHost: string;
};

export type HarnessRuleModule = {
  id: string;
  manifest: string;
};

export type HarnessManifest = {
  schema: "prism-harness-pack/v1";
  id: string;
  version: string;
  sourceRepository: string;
  sourceCommit: string;
  sourceState: "clean" | "dirty";
  harnessConfigHash: string;
  compilerHash: string;
  requiredCapabilities: string[];
  externalHostAssets: string[];
  driver: HarnessDriverIdentity;
  ruleModules: HarnessRuleModule[];
  profileBindings: Record<string, string>;
  agentProfileBindings: Record<string, string>;
  promptBindings: Record<string, string[]>;
  agentPromptBindings: Record<string, string[]>;
  qualityBindings: Record<string, Record<string, HarnessQualityMode>>;
  agentQualityBindings: Record<string, Record<string, HarnessQualityMode>>;
  assets: Record<string, string>;
};

export type HarnessCompatibility = {
  compatible: boolean;
  unsupportedCapabilities: string[];
  missingExternalHostAssets: string[];
  issues: string[];
};

export type VerifiedHarnessPack = {
  directory: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: HarnessManifest;
  assetCount: number;
  compatibility: HarnessCompatibility;
  driverContract: HarnessDriverContract;
  hostAdapter: HarnessHostAdapter;
};
