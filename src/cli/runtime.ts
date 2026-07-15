/**
 * Prefer the explicit compile-time marker over Bun's virtual module path.
 * The latter is a useful fallback for source runs, but is not stable across
 * Bun's standalone targets and runners.
 */
export function isCompiledBinaryRuntime(compiledMarker: boolean | undefined, bunMain: string): boolean {
  return compiledMarker ?? (bunMain.includes("~BUN/root") || bunMain.includes("/$bunfs/root/"));
}
