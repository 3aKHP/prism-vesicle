import { describe, expect, test } from "bun:test";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_LENGTH,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_LINES,
  parseSkillMarkdown,
} from "../../../src/skills";

const OK = (name: string, body = "instructions\n"): string => `---
name: ${name}
description: A skill that does something useful when a matching task appears.
---
${body}`;

describe("skill parser: positive cases", () => {
  test("parses the portable core with name and description", () => {
    const result = parseSkillMarkdown(OK("gloss-review"), "gloss-review");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.name).toBe("gloss-review");
    expect(result.metadata.description).toBe("A skill that does something useful when a matching task appears.");
    expect(result.body).toBe("instructions\n");
    expect(result.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.diagnostics).toEqual([]);
  });

  test("accepts a quoted description containing a colon", () => {
    const content = `---
name: col
description: "Reviews prose: cuts filler, keeps voice."
license: MIT
compatibility: ">=1.0"
---
body`;
    const result = parseSkillMarkdown(content, "col");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.description).toBe("Reviews prose: cuts filler, keeps voice.");
    expect(result.metadata.license).toBe("MIT");
    expect(result.metadata.compatibility).toBe(">=1.0");
  });

  test("accepts single-quoted values with escaped quotes and a metadata map", () => {
    const content = `---
name: q
description: 'It''s a skill'
metadata:
  author: tester
  tier: "2"
---
body`;
    const result = parseSkillMarkdown(content, "q");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.description).toBe("It's a skill");
    expect(result.metadata.metadata).toEqual({ author: "tester", tier: "2" });
  });
});

describe("skill parser: allowed-tools and unknown fields", () => {
  test("allowed-tools is parsed but ignored with one diagnostic", () => {
    const content = `---
name: at
description: demo
allowed-tools: read_file grep_files
---
body`;
    const result = parseSkillMarkdown(content, "at");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.allowedTools).toEqual(["read_file", "grep_files"]);
    expect(result.diagnostics.map((d) => d.kind)).toContain("allowed-tools-ignored");
  });

  test("unknown frontmatter fields are preserved and flagged", () => {
    const content = `---
name: u
description: demo
version: "1.2.3"
author: someone
---
body`;
    const result = parseSkillMarkdown(content, "u");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.unknownFields).toEqual(["author", "version"]);
    expect(result.diagnostics.map((d) => d.kind)).toContain("unsupported-field");
  });
});

describe("skill parser: name validation", () => {
  test("missing name is a hard failure", () => {
    const result = parseSkillMarkdown(`---
description: no name here
---
body`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.kind)).toContain("name-missing");
  });

  test("uppercase, hyphen-edge, and repeated-hyphen names are invalid", () => {
    for (const bad of ["BadName", "-leading", "trailing-", "double--hyphen", "with_underscore", "has space"]) {
      const result = parseSkillMarkdown(`---
name: ${bad}
description: x
---
body`, bad);
      expect(result.ok, `expected ${bad} to be invalid`).toBe(false);
    }
  });

  test("a name longer than the limit is invalid", () => {
    const long = "a".repeat(MAX_NAME_LENGTH + 1);
    const result = parseSkillMarkdown(`---
name: ${long}
description: x
---
body`, long);
    expect(result.ok).toBe(false);
  });

  test("a name that does not match its directory is a hard failure", () => {
    const result = parseSkillMarkdown(OK("real-name"), "other-name");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.kind)).toContain("name-directory-mismatch");
  });
});

describe("skill parser: description validation", () => {
  test("missing description is a hard failure", () => {
    const result = parseSkillMarkdown(`---
name: nd
---
body`, "nd");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.kind)).toContain("description-missing");
  });

  test("oversized description is a hard failure", () => {
    const description = "x".repeat(MAX_DESCRIPTION_CHARS + 1);
    const result = parseSkillMarkdown(`---
name: od
description: ${description}
---
body`, "od");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.kind)).toContain("description-oversized");
  });
});

describe("skill parser: file bounds", () => {
  test("a SKILL.md over the byte limit is rejected before parsing", () => {
    const padding = "z".repeat(MAX_SKILL_FILE_BYTES);
    const content = `---
name: big
description: x
---
${padding}`;
    const result = parseSkillMarkdown(content, "big");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.kind)).toContain("oversized-skill");
  });

  test("a SKILL.md over the line limit is rejected", () => {
    const lines = ["---", "name: many", "description: x", "---"];
    for (let i = 0; i < MAX_SKILL_LINES; i++) lines.push("line");
    const result = parseSkillMarkdown(`${lines.join("\n")}\n`, "many");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.kind)).toContain("oversized-skill");
  });
});

describe("skill parser: frontmatter structure", () => {
  test("missing leading fence is rejected", () => {
    const result = parseSkillMarkdown("name: x\ndescription: y\n", "x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.kind)).toContain("missing-frontmatter");
  });

  test("missing closing fence is rejected", () => {
    const result = parseSkillMarkdown("---\nname: x\ndescription: y\n", "x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.kind)).toContain("missing-closing-fence");
  });

  test("a plain value with an embedded colon-space is rejected to avoid mis-splitting", () => {
    const result = parseSkillMarkdown(`---
name: amb
description: plain value: with colon
---
body`, "amb");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.kind)).toContain("parse-error");
  });

  test("duplicate keys are rejected", () => {
    const result = parseSkillMarkdown(`---
name: dup
name: dup2
description: x
---
body`, "dup");
    expect(result.ok).toBe(false);
  });
});
