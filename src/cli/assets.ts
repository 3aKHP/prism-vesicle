import { cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bundledAssetsRoot } from "../core/runtime/assets";

/** Materialize the package defaults for users who want editable project assets. */
export async function initializeEditableAssets(projectRoot = process.cwd()): Promise<void> {
  const sourceRoot = bundledAssetsRoot();
  if (!sourceRoot) {
    throw new Error("This executable does not contain package assets. Extract the assets ZIP beside the binary instead.");
  }

  const target = join(projectRoot, "assets");
  if (existsSync(target)) {
    throw new Error(`Refusing to overwrite existing editable assets at ${target}.`);
  }

  await cp(join(sourceRoot, "assets"), target, { recursive: true, errorOnExist: true });
  console.log(`Initialized editable assets: ${target}`);
}
