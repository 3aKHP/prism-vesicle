import { loadQualityRuntime } from "../quality";
import type { HarnessRuntimeContext } from "./driver";
import type { VerifiedHarnessPack } from "./types";

export async function createHarnessRuntimeContext(pack: VerifiedHarnessPack): Promise<HarnessRuntimeContext> {
  return {
    packId: pack.manifest.id,
    packVersion: pack.manifest.version,
    sourceCommit: pack.manifest.sourceCommit,
    manifestSha256: pack.manifestSha256,
    driver: pack.driverContract,
    adapter: pack.hostAdapter,
    quality: await loadQualityRuntime(pack),
  };
}
