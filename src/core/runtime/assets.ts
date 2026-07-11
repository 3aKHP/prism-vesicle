import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the root that owns the editable `assets/` directory.
 *
 * A standalone binary deliberately reads `assets/` beside itself. A Bun/npm
 * installation instead falls back to the assets shipped with this package,
 * while a project-local `assets/` directory always takes precedence so users
 * can materialize and edit their own copy without modifying node_modules.
 */
export function resolveAssetsRoot(projectRoot = process.cwd()): string {
  if (existsSync(join(projectRoot, "assets"))) return projectRoot;

  const bundledRoot = bundledAssetsRoot();
  if (bundledRoot) return bundledRoot;

  throw new Error(
    `Prism assets not found. Extract the release assets/ directory beside the binary or run \"vesicle assets init\" from a Bun package installation.`,
  );
}

/** Return the package-owned asset source, independent of the active project. */
export function bundledAssetsRoot(): string | undefined {
  const candidate = dirname(fileURLToPath(new URL("../../../assets/manifest.json", import.meta.url)));
  return existsSync(candidate) ? dirname(candidate) : undefined;
}
