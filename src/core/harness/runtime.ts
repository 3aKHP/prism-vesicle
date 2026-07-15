import { loadQualityRuntime } from "../quality";
import type { HarnessRuntimeContext } from "./driver";
import type { VerifiedHarnessPack } from "./types";

export async function createHarnessRuntimeContext(pack: VerifiedHarnessPack): Promise<HarnessRuntimeContext> {
  const hasQualityModule = pack.manifest.ruleModules.some((module) => module.id === "anti-ai-flavor");
  return {
    packId: pack.manifest.id,
    packVersion: pack.manifest.version,
    sourceCommit: pack.manifest.sourceCommit,
    manifestSha256: pack.manifestSha256,
    driver: pack.driverContract,
    adapter: pack.hostAdapter,
    ...(hasQualityModule ? { quality: await loadQualityRuntime(pack) } : {}),
    identity: {
      packId: pack.manifest.id,
      packVersion: pack.manifest.version,
      sourceCommit: pack.manifest.sourceCommit,
      manifestSha256: pack.manifestSha256,
      adapterId: pack.manifest.driver.adapterId,
      adapterVersion: pack.manifest.driver.adapterVersion,
      adapterHash: pack.manifest.driver.adapterHash,
    },
  };
}
