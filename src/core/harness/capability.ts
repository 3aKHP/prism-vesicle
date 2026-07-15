import type { HarnessManifest } from "./types";

/** Capabilities the current host can honor without weakening their contract. */
const supportedCapabilities = new Set([
  "prism-harness/v1",
  "prism-driver/v1",
  "prism-host/vesicle@1",
  "prism-interaction/confirmation@1",
  "prism-interaction/select@1",
  "prism-agent/delegation@1",
  "quality-guard/anti-ai-flavor@1",
]);

export const supportedHarnessCapabilities: readonly string[] = Object.freeze([...supportedCapabilities]);

export function unsupportedHarnessCapabilities(
  manifest: HarnessManifest,
): string[] {
  return manifest.requiredCapabilities.filter((capability) => !supportedCapabilities.has(capability)).sort();
}

export function harnessAdapterCompatibilityIssue(manifest: HarnessManifest): string | undefined {
  if (manifest.driver.targetHost !== "Prism Vesicle") {
    return `Harness targets ${manifest.driver.targetHost}, not Prism Vesicle.`;
  }
  if (manifest.driver.adapterId !== "vesicle-v1") {
    return `Unsupported Harness Adapter id ${manifest.driver.adapterId}.`;
  }
  const major = /^([0-9]+)\./.exec(manifest.driver.adapterVersion)?.[1];
  if (major !== "1") return `Unsupported Harness Adapter version ${manifest.driver.adapterVersion}.`;
  return undefined;
}
