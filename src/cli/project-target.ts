import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export async function resolveProjectDirectory(
  input: string,
  cwd = process.cwd(),
): Promise<string> {
  const value = input.trim();
  if (!value) throw new Error("Project directory is required.");
  const target = resolve(cwd, value);
  const info = await stat(target).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Project directory does not exist: ${target}`);
    }
    throw error;
  });
  if (!info.isDirectory()) throw new Error(`Project path is not a directory: ${target}`);
  return target;
}
