import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function configureTreeSitterWorkerPath(
  runtimeRoot: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.OTUI_TREE_SITTER_WORKER_PATH) {
    setGlobalTreeSitterWorkerPath(env.OTUI_TREE_SITTER_WORKER_PATH);
    return env.OTUI_TREE_SITTER_WORKER_PATH;
  }

  const externalWorkerPath = installedTreeSitterWorkerPath()
    ?? join(runtimeRoot, "node_modules", "@3akhp", "opentui-core", "parser.worker.js");
  if (existsSync(externalWorkerPath)) {
    env.OTUI_TREE_SITTER_WORKER_PATH = externalWorkerPath;
    setGlobalTreeSitterWorkerPath(externalWorkerPath);
    return externalWorkerPath;
  }

  return undefined;
}

/**
 * Resolve from this module rather than the active project directory. npm/Bun
 * bins run with the user's project as cwd, not the installed package root.
 * The fork exports its worker through the ./parser.worker subpath; the
 * resolved target is the package-root parser.worker.js file.
 */
function installedTreeSitterWorkerPath(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve("@3akhp/opentui-core/parser.worker"));
  } catch {
    return undefined;
  }
}

function setGlobalTreeSitterWorkerPath(path: string): void {
  (globalThis as typeof globalThis & { OTUI_TREE_SITTER_WORKER_PATH?: string }).OTUI_TREE_SITTER_WORKER_PATH = path;
}
