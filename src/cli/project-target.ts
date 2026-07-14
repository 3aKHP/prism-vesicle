import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export async function resolveProjectDirectory(
  input: string,
  cwd = process.cwd(),
): Promise<string> {
  const target = resolve(cwd, input.trim() || ".");
  const info = await stat(target).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Project directory does not exist: ${target}`);
    }
    throw error;
  });
  if (!info.isDirectory()) throw new Error(`Project path is not a directory: ${target}`);
  return target;
}
