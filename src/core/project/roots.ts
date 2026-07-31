/** Project roots containing imported or generated source material. */
export const sourceRoots = ["source_materials"] as const;

/** Final artifact roots, in TUI display and numeric-index order. */
export const artifactRoots = ["workspace", "novels", "reports", "test_runs"] as const;

/** Model-visible scratch roots excluded from content and artifact consumers. */
export const scratchRoots = ["tmp"] as const;

/** Durable content roots eligible for existing content consumers such as /init and Stage. */
export const projectContentRoots = [...sourceRoots, ...artifactRoots] as const;

/** Every project root writable through ordinary guarded file tools. */
export const modelWritableRoots = [...projectContentRoots, ...scratchRoots] as const;

export type SourceRoot = (typeof sourceRoots)[number];
export type ArtifactRoot = (typeof artifactRoots)[number];
export type ScratchRoot = (typeof scratchRoots)[number];
export type ProjectContentRoot = (typeof projectContentRoots)[number];
export type ModelWritableRoot = (typeof modelWritableRoots)[number];

export function artifactRootIndex(path: string): number {
  const root = path.split("/", 1)[0];
  const index = artifactRoots.indexOf(root as ArtifactRoot);
  return index === -1 ? artifactRoots.length : index;
}

/** First project-relative segment, or undefined for ambiguous or absolute paths. */
export function projectPathRoot(path: string): string | undefined {
  const segments = path.replaceAll("\\", "/").split("/");
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return undefined;
  }
  return segments[0];
}

/** Fail-closed scratch classification: only unambiguous scratch-root paths qualify. */
export function isScratchProjectPath(path: string): boolean {
  const root = projectPathRoot(path);
  return root !== undefined && scratchRoots.some((candidate) => candidate === root);
}
