import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

const sourceRoot = join(import.meta.dir, "..", "..", "..", "src");
const protocolDirectories = [
  "openai-chat",
  "anthropic-messages",
  "gemini-generate-content",
  "openai-responses",
];

describe("provider architecture boundaries", () => {
  test("core and host surfaces do not import provider protocol modules", async () => {
    const files = await sourceFiles(join(sourceRoot, "core"), join(sourceRoot, "tui"));
    const violations = await findImports(files, (specifier) => protocolDirectories.some((directory) => specifier.includes(`/providers/${directory}/`)));
    expect(violations).toEqual([]);
  });

  test("provider modules do not import host workflow, session, or TUI owners", async () => {
    const files = await sourceFiles(join(sourceRoot, "providers"));
    const forbidden = ["/core/agent-loop/", "/core/session/", "/core/side-question/", "/tui/"];
    const violations = await findImports(files, (specifier) => forbidden.some((segment) => specifier.includes(segment)));
    expect(violations).toEqual([]);
  });
});

async function sourceFiles(...roots: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        files.push(join(entry.parentPath, entry.name));
      }
    }
  }
  return files.sort();
}

async function findImports(files: string[], isForbidden: (specifier: string) => boolean): Promise<string[]> {
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*[(']\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier && isForbidden(normalizeImport(file, specifier))) {
        violations.push(`${relative(sourceRoot, file)} -> ${specifier}`);
      }
    }
  }
  return violations;
}

function normalizeImport(file: string, specifier: string): string {
  return specifier.startsWith(".") ? join(file, "..", specifier).replaceAll("\\", "/") : specifier;
}
