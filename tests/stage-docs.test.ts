import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "..");

describe("Stage user documentation", () => {
  test("describes compatibility warnings without treating creative cards as an admission contract", async () => {
    const [english, chinese] = await Promise.all([
      readFile(join(root, "docs", "user", "en", "07-models-and-engines.md"), "utf8"),
      readFile(join(root, "docs", "user", "zh-CN", "07-models-and-engines.md"), "utf8"),
    ]);

    expect(english).toContain("compatibility warning");
    expect(english).toContain("does not certify, rewrite, or reject your creative work");
    expect(english).not.toContain("Vesicle validates both cards before creating the session");
    expect(chinese).toContain("兼容性提示");
    expect(chinese).toContain("不会认证、改写或拒绝你的创作内容");
    expect(chinese).not.toContain("Vesicle 会在创建会话前验证两张卡");
  });
});
