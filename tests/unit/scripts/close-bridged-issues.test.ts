import { describe, expect, test } from "bun:test";
import {
  collectIssueOrigins,
  extractClosingIssueNumbers,
  extractPrNumbersFromCommits,
  mapCompareCommitMessages,
} from "../../../scripts/release/close-bridged-issues";

describe("constituent PR extraction", () => {
  test("recovers native-merge PR numbers from merge-commit messages", () => {
    expect(
      extractPrNumbersFromCommits([
        { message: "Merge pull request #267 from 3aKHP/fix/working-title-quadrant-frames\n\nfix(tui): replace jittering working-title frames" },
        { message: "Merge pull request #266 from 3aKHP/chore/forward-sync-v1.0.0-rc.1" },
      ]),
    ).toEqual([266, 267]);
  });

  test("recovers squash-merged PR numbers from the trailing subject reference", () => {
    expect(
      extractPrNumbersFromCommits([
        { message: "fix(tui): replace jittering working-title frames with quadrant squares (#267)\n\nbody text mentioning #263 elsewhere" },
      ]),
    ).toEqual([267]);
  });

  test("ignores references that are neither merge announcements nor subject-trailing", () => {
    expect(
      extractPrNumbersFromCommits([
        { message: "fix: see (#123) mid-sentence\n\nbody references (#456) too" },
        { message: "chore(release): stamp 1.0.0-rc.2 for group-test installers" },
      ]),
    ).toEqual([]);
  });

  test("deduplicates numbers found through both patterns", () => {
    expect(
      extractPrNumbersFromCommits([
        { message: "Merge pull request #267 from 3aKHP/fix/x" },
        { message: "docs(readme): mark the project status badge stable for 1.0.0 (#267)" },
      ]),
    ).toEqual([267]);
  });

  test("maps the compare endpoint's nested commit payload before extraction", () => {
    // Wire-shape regression: the compare API nests messages under `.commit`,
    // and feeding raw entries to extraction crashed the v1.1.0 bridge run.
    const compareEntries = [
      { sha: "abc", commit: { message: "fix(tui): wire the strict double-tilde flavor (#305)" } },
      { sha: "def", commit: { message: "Merge pull request #307 from 3aKHP/fix/issue-298" } },
      { sha: "ghi" },
    ];
    expect(extractPrNumbersFromCommits(mapCompareCommitMessages(compareEntries))).toEqual([305, 307]);
  });
});

describe("closing keyword extraction (GitHub-native inline semantics)", () => {
  test("matches inline, past-tense, colonated, and case variants", () => {
    expect(extractClosingIssueNumbers("This closes #1, fixes #2, and Resolves: #3 in one sentence.")).toEqual([1, 2, 3]);
  });

  test("does not match keywords embedded inside larger words or bare references", () => {
    expect(extractClosingIssueNumbers("hotfix #1, prefix #2, and plain #3 do not close anything")).toEqual([]);
  });

  test("matches prose-style references exactly as GitHub native does", () => {
    expect(extractClosingIssueNumbers("Back in July we closed #177 after the audit.")).toEqual([177]);
  });

  test("returns empty for missing bodies and deduplicates repeats", () => {
    expect(extractClosingIssueNumbers(undefined)).toEqual([]);
    expect(extractClosingIssueNumbers("Closes #9 and closes #9")).toEqual([9]);
  });
});

describe("issue origin attribution", () => {
  test("attributes to the first declaring PR, keeping release-body declarations as fallback", () => {
    const origins = collectIssueOrigins([
      { number: 267, body: "Closes #263" },
      { number: 269, body: "Closes #263\n\nAlso fixes #264" },
    ]);
    expect(origins.get(263)).toBe(267);
    expect(origins.get(264)).toBe(269);
  });

  test("handles missing constituent bodies", () => {
    const origins = collectIssueOrigins([
      { number: 270, body: null },
      { number: 271, body: "resolves #84" },
    ]);
    expect(origins.get(84)).toBe(271);
    expect(origins.size).toBe(1);
  });
});
