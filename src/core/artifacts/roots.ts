/** Canonical generated-artifact roots, in TUI display and numeric-index order. */
export const artifactRoots = ["workspace", "novels", "reports", "test_runs"] as const;
export const sourceMaterialRoot = "source_materials" as const;
export const writableProjectRoots = [sourceMaterialRoot, ...artifactRoots] as const;

export type ArtifactRoot = (typeof artifactRoots)[number];
export type WritableProjectRoot = (typeof writableProjectRoots)[number];

export function artifactRootIndex(path: string): number {
  const root = path.split("/", 1)[0];
  const index = artifactRoots.indexOf(root as ArtifactRoot);
  return index === -1 ? artifactRoots.length : index;
}
