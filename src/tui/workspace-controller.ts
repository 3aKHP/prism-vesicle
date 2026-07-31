/**
 * Compatibility re-export for the Workspace domain (W1). Callers still import
 * the public Workspace surface from this path; the thin facade lives in
 * `./workspace/index.ts`. Removed in W5 when all callers switch to the
 * workspace directory.
 */
export * from "./workspace";
