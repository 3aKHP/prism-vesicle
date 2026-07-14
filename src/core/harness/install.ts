import { randomUUID } from "node:crypto";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { userConfigDirectory } from "../../config/paths";
import { assertHarnessPackCompatible, verifyHarnessPack, type HarnessVerificationOptions } from "./verify";
import type { VerifiedHarnessPack } from "./types";

export type HarnessInstallOptions = HarnessVerificationOptions;

export function harnessPacksDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(userConfigDirectory(env), "asset-packs");
}

/** Install one already-extracted immutable pack. Selection/activation is separate. */
export async function installHarnessPack(
  sourceDirectory: string,
  options: HarnessInstallOptions = {},
): Promise<VerifiedHarnessPack> {
  const verified = await verifyHarnessPack(sourceDirectory, options);
  assertHarnessPackCompatible(verified);

  const packsRoot = harnessPacksDirectory(options.env);
  const familyRoot = join(packsRoot, verified.manifest.id);
  const destination = join(familyRoot, verified.manifest.version);
  const staging = join(familyRoot, `.staging-${verified.manifest.version}-${randomUUID()}`);
  await mkdir(familyRoot, { recursive: true });
  if (await Bun.file(join(destination, "manifest.json")).exists()) {
    throw new Error(`Harness ${verified.manifest.id}@${verified.manifest.version} is already installed.`);
  }

  try {
    await cp(verified.directory, staging, { recursive: true, errorOnExist: true, force: false });
    const staged = await verifyHarnessPack(staging, options);
    assertHarnessPackCompatible(staged);
    try {
      await rename(staging, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        throw new Error(`Harness ${verified.manifest.id}@${verified.manifest.version} is already installed.`);
      }
      throw error;
    }
    return { ...staged, directory: destination, manifestPath: join(destination, "manifest.json") };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
