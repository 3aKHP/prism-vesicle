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

/**
 * Register the fork's strict double-tilde strikethrough flavor as the default
 * markdown_inline parser before the first tree-sitter client initializes:
 * the client reads default-parser overrides at init time and posts one
 * ADD_FILETYPE_PARSER per entry to the worker, which replaces the stock
 * parser options wholesale and invalidates its parser caches. The bare
 * dynamic import keeps @3akhp/opentui-core out of the CLI entry chunk —
 * bundlers inline it, so no runtime specifier survives in packed outputs.
 * The helper returned a plain options object through 0.5.10-zv4 and a
 * promise from the bundled-resolution fix on; awaiting covers both shapes.
 */
export async function registerStrictMarkdownInlineParser(): Promise<void> {
  const { addDefaultParsers, strictMarkdownInlineParserOptions } = await import("@3akhp/opentui-core");
  addDefaultParsers([await strictMarkdownInlineParserOptions()]);
}
