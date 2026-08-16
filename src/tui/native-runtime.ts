import { setRenderLibPath } from "@3akhp/opentui-core";
import { getNodeAssets } from "@3akhp/opentui-core/node-assets";
import type { NodeAssetTarget } from "@3akhp/opentui-core/node-assets";

const NATIVE_LIBRARY_ASSET_KEY = /\/(?:libopentui\.so|libopentui\.dylib|opentui\.dll)$/;

export type ForkNativeAsset = {
  readonly key: string;
  readonly source: string;
};

/**
 * Resolve the platform-native library through the fork's own asset table.
 * The fork performs every fork/upstream package-name mapping; this side only
 * describes the current platform, mirroring the fork's NodeAssetTarget
 * contract (process platform/arch plus the OPENTUI_LIBC override on Linux).
 */
export function resolveForkNativeAsset(): ForkNativeAsset | undefined {
  const libc = process.env.OPENTUI_LIBC;
  const target: NodeAssetTarget = {
    platform: process.platform as NodeAssetTarget["platform"],
    arch: process.arch as NodeAssetTarget["arch"],
    ...(process.platform === "linux" && libc === "musl" ? { libc: "musl" } : {}),
  };
  return getNodeAssets(target).find((asset) => NATIVE_LIBRARY_ASSET_KEY.test(asset.key));
}

let nativeLibraryConfigured = false;

/**
 * Pin the render library to the real platform-native file before the first
 * FFI touch.
 *
 * `@3akhp/opentui-core@0.5.3-zv2`'s prebundled Bun entry re-bundled its
 * platform-native dynamic imports into JavaScript chunks, so the runtime
 * file-import resolves a chunk path and dlopen fails with "invalid ELF
 * header". The fork's asset table still resolves the installed platform
 * package correctly, so pin that path through the public `setRenderLibPath`.
 * Channels where the table cannot resolve (compiled binaries with embedded
 * natives) keep the bundler-provided path by skipping the override. Remove
 * when the fork ships a corrected Bun entry (fork-side packaging defect,
 * coordinated follow-up release).
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
