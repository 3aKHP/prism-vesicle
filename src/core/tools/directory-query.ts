/** Whether a profile exposes the unified logical directory query. */
export function declaresDirectoryQuery(names: readonly string[]): boolean {
  return names.includes("list_directory");
}
