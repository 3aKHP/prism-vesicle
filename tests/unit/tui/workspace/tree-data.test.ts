import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildFileIndex,
  classifyFile,
  flattenVisibleTree,
  matchFiles,
  readFilePreview,
  scanDirectory,
} from "../../../../src/tui/workspace/tree-data";
import { buildProjectPathIndex } from "../../../../src/core/project/path-index";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-ws-files-"));
  await mkdir(join(root, "workspace/cards"), { recursive: true });
  await mkdir(join(root, "novels"), { recursive: true });
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "workspace/cards/mira.md"), "# Mira\n\nA card.\n");
  await writeFile(join(root, "workspace/notes.txt"), "line one\nline two\n");
  await writeFile(join(root, "novels/draft.md"), "draft\n");
  await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, "data.bin"), Buffer.from([0x00, 0x01, 0x02]));
  await writeFile(join(root, "fake.txt"), Buffer.from([0x41, 0x00, 0x42])); // NUL inside
  await writeFile(join(root, ".hidden.md"), "secret\n");
  await writeFile(join(root, "node_modules/pkg/index.js"), "module.exports = 1;\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspace file classification", () => {
  test("classifies by extension with extensionless as text", () => {
    expect(classifyFile("card.md")).toBe("markdown");
    expect(classifyFile("a.PNG")).toBe("image");
    expect(classifyFile("script.ts")).toBe("text");
    expect(classifyFile("LICENSE")).toBe("text");
    expect(classifyFile("archive.zip")).toBe("binary");
  });
});

describe("workspace directory scanning", () => {
  test("hides dotfiles and noisy directories by default, dirs first", async () => {
    const nodes = await scanDirectory(root, "", { showHidden: false });
    const names = nodes.map((node) => node.name);
    expect(names).not.toContain(".hidden.md");
    expect(names).not.toContain("node_modules");
    expect(names.indexOf("novels")).toBeLessThan(names.indexOf("data.bin"));
    expect(nodes.find((node) => node.name === "logo.png")?.fileKind).toBe("image");
  });

  test("showHidden reveals dotfiles and noisy directories", async () => {
    const names = (await scanDirectory(root, "", { showHidden: true })).map((node) => node.name);
    expect(names).toContain(".hidden.md");
    expect(names).toContain("node_modules");
  });

  test("returns an empty list for a missing directory", async () => {
    expect(await scanDirectory(root, "no/such/dir", { showHidden: false })).toEqual([]);
  });
});

describe("workspace tree flattening", () => {
  test("lists only root rows when nothing is expanded, descends into expanded dirs", async () => {
    const cache = new Map();
    const collapsed = await flattenVisibleTree(root, new Set(), { showHidden: false }, cache);
    expect(collapsed.every((row) => row.depth === 0)).toBe(true);

    const expanded = await flattenVisibleTree(root, new Set(["workspace", "workspace/cards"]), { showHidden: false }, cache);
    const mira = expanded.find((row) => row.node.relPath === "workspace/cards/mira.md");
    expect(mira?.depth).toBe(2);
    expect(expanded.find((row) => row.node.relPath === "workspace")?.expanded).toBe(true);
  });
});

describe("workspace file index and matching", () => {
  test("indexes visible files and directories without following symlinks", async () => {
    await symlink(join(root, "novels"), join(root, "linked-novels"));
    await writeFile(join(root, "foo\\..\\bar.md"), "unsafe-name\n");
    const index = await buildProjectPathIndex(root, { showHidden: false });
    expect(index).toContainEqual({ path: "workspace", kind: "dir" });
    expect(index).toContainEqual({ path: "workspace/cards/mira.md", kind: "file" });
    expect(index.some((entry) => entry.path.startsWith("linked-novels"))).toBe(false);
    expect(index.some((entry) => entry.path.startsWith(".hidden"))).toBe(false);
    expect(index.some((entry) => entry.path.includes(".."))).toBe(false);
  });

  test("indexes visible files recursively, skipping hidden subtrees", async () => {
    const index = await buildFileIndex(root, { showHidden: false });
    expect(index).toContain("workspace/cards/mira.md");
    expect(index).toContain("novels/draft.md");
    expect(index).not.toContain(".hidden.md");
    expect(index.some((path) => path.startsWith("node_modules/"))).toBe(false);
  });

  test("matches subsequences with basename-prefix hits first", async () => {
    const index = await buildFileIndex(root, { showHidden: false });
    const hits = matchFiles(index, "mira");
    expect(hits[0]).toBe("workspace/cards/mira.md");
    expect(matchFiles(index, "wcd").some((path) => path.includes("workspace/cards/"))).toBe(true);
    expect(matchFiles(index, "zzz")).toEqual([]);
    expect(matchFiles(index, "").length).toBeGreaterThan(0);
  });
});

describe("workspace file preview", () => {
  test("reads text files into lines", async () => {
    const preview = await readFilePreview(root, "workspace/notes.txt");
    expect(preview?.kind).toBe("text");
    expect(preview?.lines?.slice(0, 2)).toEqual(["line one", "line two"]);
    expect(preview?.truncated).toBe(false);
  });

  test("markdown keeps its kind for source/preview switching", async () => {
    const preview = await readFilePreview(root, "workspace/cards/mira.md");
    expect(preview?.kind).toBe("markdown");
    expect(preview?.lines?.[0]).toBe("# Mira");
  });

  test("image and binary files return metadata without lines", async () => {
    const image = await readFilePreview(root, "logo.png");
    expect(image?.kind).toBe("image");
    expect(image?.lines).toBeUndefined();
    const bin = await readFilePreview(root, "data.bin");
    expect(bin?.kind).toBe("binary");
    expect(bin?.lines).toBeUndefined();
  });

  test("NUL sniff reclassifies fake text as binary", async () => {
    const preview = await readFilePreview(root, "fake.txt");
    expect(preview?.kind).toBe("binary");
    expect(preview?.lines).toBeUndefined();
  });

  test("returns null for missing files and directories", async () => {
    expect(await readFilePreview(root, "gone.md")).toBeNull();
    expect(await readFilePreview(root, "workspace")).toBeNull();
  });
});
