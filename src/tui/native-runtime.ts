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

/**
 * Resolve the platform-native library through the fork's own asset table.
 * The descriptor performs every fork/upstream package-name mapping; this
 * side only turns the descriptor into an absolute path by resolving the
 * platform package entry and joining its declared library file. Works from
 * source, from the precompiled npm bundle (the platform packages stay
 * external there), and skips cleanly in compiled binaries where
 * import.meta.resolve cannot see an installed package.
 */
export function resolveForkNativeAsset(): ForkNativeAsset | undefined {
  try {
    const descriptor = getNativeAssetDescriptor(getCurrentNodeAssetTarget());
    const entryPath = fileURLToPath(import.meta.resolve(descriptor.packageName));
    const source = join(dirname(entryPath), descriptor.fileName);
    if (!existsSync(source)) return undefined;
    return { key: descriptor.key, source };
  } catch {
    // No installed platform package visible from this module graph (compiled
    // binaries); callers fall back to the runtime's own pinned path.
    return undefined;
  }
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
 */
export function configureForkNativeLibrary(): void {
  if (nativeLibraryConfigured) return;
  nativeLibraryConfigured = true;
  try {
    const native = resolveForkNativeAsset();
    if (native) setRenderLibPath(native.source);
  } catch {
    // Keep the fork's default resolution (embedded/bundled channels) and let
    // its own error surface if the library genuinely cannot load.
  }
}
