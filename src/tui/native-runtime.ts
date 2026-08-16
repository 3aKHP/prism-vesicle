import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setRenderLibPath } from "@3akhp/opentui-core";
import {
  getCurrentNodeAssetTarget,
  getNativeAssetDescriptor,
} from "@3akhp/opentui-core/node-assets";

export type ForkNativeAsset = {
  readonly key: string;
  readonly source: string;
};

declare const VESICLE_COMPILED_BINARY: boolean | undefined;

function runningAsCompiledBinary(): boolean {
  const marker = typeof VESICLE_COMPILED_BINARY === "boolean" ? VESICLE_COMPILED_BINARY : undefined;
  return marker ?? (Bun.main.includes("~BUN/root") || Bun.main.includes("/$bunfs/root/"));
}

/**
 * Resolve the platform-native library through the fork's own asset table.
 * The descriptor performs every fork/upstream package-name mapping; this
 * side only turns the descriptor into an absolute path by resolving the
 * platform package entry and joining its declared library file.
 *
 * Returns undefined only when no platform package can be visible at all
 * (compiled binaries embed the library instead). Everything else — an
 * unresolvable package outside compiled binaries (optional dependencies
 * skipped), a resolved package missing its library file, an unsupported
 * platform, or an invalid OPENTUI_LIBC override — propagates: these are
 * install or configuration defects that the fork's own loader would only
 * report later as a cryptic dlopen failure.
 */
export function resolveForkNativeAsset(): ForkNativeAsset | undefined {
  const descriptor = getNativeAssetDescriptor(getCurrentNodeAssetTarget());
  let entryPath: string;
  try {
    entryPath = fileURLToPath(import.meta.resolve(descriptor.packageName));
  } catch {
    if (runningAsCompiledBinary()) return undefined;
    throw new Error(
      `fork platform package ${descriptor.packageName} is not installed (reinstall with optional dependencies enabled)`,
    );
  }
  const source = join(dirname(entryPath), descriptor.fileName);
  if (!existsSync(source)) {
    throw new Error(
      `fork platform package ${descriptor.packageName} is missing its native library ${descriptor.fileName} at ${source}`,
    );
  }
  return { key: descriptor.key, source };
}

let nativeLibraryConfigured = false;

/**
 * Pin the render library to the real platform-native file before the first
 * FFI touch.
 *
 * `@3akhp/opentui-core@0.5.3-zv2`'s prebundled Bun entry re-bundled its
 * platform-native dynamic imports into JavaScript chunks, so the runtime
 * file-import resolves a chunk path and dlopen fails with "invalid ELF
 * header" (in the npm bundle the same chunk resolves to a CWD-relative
 * asset path). Pinning the path through the public `setRenderLibPath`
 * before the first renderable touches FFI sidesteps that loader in every
 * channel. Remove when the fork ships a corrected Bun entry (fork-side
 * packaging defect, coordinated follow-up release).
 *
 * Failures are surfaced on stderr rather than swallowed: a visible-but-
 * unusable install must not fall back silently to the known-broken bundled
 * loader.
 */
export function configureForkNativeLibrary(): void {
  if (nativeLibraryConfigured) return;
  nativeLibraryConfigured = true;
  try {
    const native = resolveForkNativeAsset();
    if (native) setRenderLibPath(native.source);
  } catch (error) {
    console.error(
      `vesicle: unable to resolve the fork native library: ${error instanceof Error ? error.message : String(error)}; native rendering will fail until the installation is repaired`,
    );
  }
}

// Pin at module load: every rendering channel reaches this module (theme.ts
// imports it ahead of the first FFI touch) and compiled binaries skip the
// pin via the embedded-library path. See configureForkNativeLibrary for the
// fork defect this bridges.
configureForkNativeLibrary();
