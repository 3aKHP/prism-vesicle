type WrapWarning = {
  line: number;
  reason: string;
};

const MAX_WARNINGS = 20;
const EXCLUDED_PREFIXES = ["assets/", "host-assets/"];

function stripBlockquotePrefix(line: string): string | null {
  const match = line.match(/^\s*(?:>\s?)+(.*)$/);
  return match ? match[1] : null;
}

function isStructuralLine(line: string): boolean {
  return /^(?:\s{0,3}#{1,6}\s|\s{0,3}(?:[-+*]|\d+[.)])\s+|\s{0,3}(?:`{3,}|~{3,})|\s{0,3}[-*_](?:\s*[-*_]){2,}\s*$)/.test(
    line,
  );
}

function isTableLine(line: string): boolean {
  return (
    /^\s*\|/.test(line) ||
    /\|\s*$/.test(line) ||
    /^\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*$/.test(line)
  );
}

function collectTableLines(lines: string[]): Set<number> {
  const tableLines = new Set<number>();
  const delimiter = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes("|") || !delimiter.test(lines[index + 1])) continue;
    tableLines.add(index);
    tableLines.add(index + 1);
    for (let row = index + 2; row < lines.length && lines[row].trim() && lines[row].includes("|"); row += 1) {
      tableLines.add(row);
    }
  }
  return tableLines;
}

function isLinkDefinition(line: string): boolean {
  return /^\s{0,3}\[[^\]]+\]:\s/.test(line);
}

function isHtmlBlockLine(line: string): boolean {
  return /^\s{0,3}(?:<!--|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|>|\/>))/i.test(
    line,
  );
}

function collectHtmlBlockLines(lines: string[]): Set<number> {
  const htmlLines = new Set<number>();
  let terminator: RegExp | "blank" | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (terminator !== null) {
      if (terminator === "blank" && !line.trim()) {
        terminator = null;
        continue;
      }
      htmlLines.add(index);
      if (terminator !== "blank" && terminator.test(line)) terminator = null;
      continue;
    }

    if (/^\s{0,3}<!--/.test(line) && !/-->/.test(line)) terminator = /-->/;
    else {
      const rawTag = line.match(/^\s{0,3}<(script|pre|style|textarea)(?:\s|>)/i);
      if (rawTag && !new RegExp(`</${rawTag[1]}\\s*>`, "i").test(line)) {
        terminator = new RegExp(`</${rawTag[1]}\\s*>`, "i");
      } else if (isHtmlBlockLine(line) && !/^\s{0,3}<\//.test(line)) {
        terminator = "blank";
      }
    }
    if (terminator !== null || isHtmlBlockLine(line)) htmlLines.add(index);
  }

  return htmlLines;
}

function hasExplicitLineBreak(line: string): boolean {
  return / {2}$/.test(line) || /<br\s*\/?>(?:\s*)$/i.test(line);
}

function isSuspiciousBoundary(line: string, next: string): boolean {
  if (!line.trim() || !next.trim() || hasExplicitLineBreak(line)) return false;

  const quotedLine = stripBlockquotePrefix(line);
  const quotedNext = stripBlockquotePrefix(next);
  if (quotedLine !== null || quotedNext !== null) {
    if (quotedLine === null || quotedNext === null || !quotedLine.trim() || !quotedNext.trim()) return false;
    return isSuspiciousBoundary(quotedLine, quotedNext);
  }

  if (
    isTableLine(line) ||
    isTableLine(next) ||
    isLinkDefinition(line) ||
    isLinkDefinition(next) ||
    isHtmlBlockLine(line) ||
    isHtmlBlockLine(next)
  ) {
    return false;
  }

  if (/^(?: {4}|\t)/.test(line) && /^(?: {4}|\t)/.test(next)) return false;
  if (isStructuralLine(next)) return false;

  const listItem = /^\s{0,3}(?:[-+*]|\d+[.)])\s+\S/.test(line);
  if (listItem) return /^\s{2,}\S/.test(next);

  return !isStructuralLine(line) && !/^\s{0,3}</.test(line);
}

export function findSuspiciousMarkdownWraps(source: string, addedLines: ReadonlySet<number>): WrapWarning[] {
  const lines = source.split(/\r?\n/);
  const warnings: WrapWarning[] = [];
  const htmlLines = collectHtmlBlockLines(lines);
  const tableLines = collectTableLines(lines);
  let fenceMarker: "`" | "~" | null = null;

  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index];
    const next = lines[index + 1];
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0] as "`" | "~";
      if (fenceMarker === null) fenceMarker = marker;
      else if (fenceMarker === marker) fenceMarker = null;
      continue;
    }
    if (fenceMarker !== null) continue;
    if (htmlLines.has(index) || htmlLines.has(index + 1) || tableLines.has(index) || tableLines.has(index + 1)) continue;

    const firstLine = index + 1;
    const secondLine = index + 2;
    if (!addedLines.has(firstLine) && !addedLines.has(secondLine)) continue;
    if (!isSuspiciousBoundary(line, next)) continue;

    warnings.push({
      line: addedLines.has(secondLine) ? secondLine : firstLine,
      reason: addedLines.has(secondLine)
        ? "Added prose appears to continue the preceding source line."
        : "Added prose appears to continue onto the following source line.",
    });
  }

  return warnings;
}

async function runGit(args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args[0]} failed with exit code ${exitCode}`);
  return stdout;
}

function parseNulSeparated(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function parseAddedLines(diff: string): Set<number> {
  const addedLines = new Set<number>();
  for (const line of diff.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk) continue;
    const start = Number.parseInt(hunk[1], 10);
    const count = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10);
    for (let offset = 0; offset < count; offset += 1) addedLines.add(start + offset);
  }
  return addedLines;
}

async function stagedMarkdownPaths(): Promise<string[]> {
  const output = await runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z", "--", "*.md"]);
  return parseNulSeparated(output).filter((path) => !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

async function stagedFile(path: string): Promise<string> {
  return runGit(["show", `:${path}`]);
}

async function addedLinesForPath(path: string): Promise<Set<number>> {
  const diff = await runGit(["diff", "--cached", "--unified=0", "--diff-filter=ACMR", "--", path]);
  return parseAddedLines(diff);
}

export async function checkStagedMarkdownWraps(): Promise<void> {
  const findings: Array<WrapWarning & { path: string }> = [];

  for (const path of await stagedMarkdownPaths()) {
    const addedLines = await addedLinesForPath(path);
    if (addedLines.size === 0) continue;
    const source = await stagedFile(path);
    for (const warning of findSuspiciousMarkdownWraps(source, addedLines)) findings.push({ path, ...warning });
  }

  if (findings.length === 0) return;

  console.error(
    `\nMarkdown wrap advisory: ${findings.length} suspicious staged ${findings.length === 1 ? "boundary" : "boundaries"}.\n`,
  );
  for (const finding of findings.slice(0, MAX_WARNINGS)) {
    console.error(`  ${finding.path}:${finding.line}`);
    console.error(`  ${finding.reason}\n`);
  }
  if (findings.length > MAX_WARNINGS) console.error(`  ...and ${findings.length - MAX_WARNINGS} more.\n`);
  console.error("This hook is heuristic and may produce false positives. Review each warning, but if the Markdown is structurally and semantically correct, do not modify it merely to silence the hook.");
  console.error("Commit was not blocked. Amend it only when the flagged line is an unintended hard wrap.\n");
}

if (import.meta.main) {
  try {
    await checkStagedMarkdownWraps();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nMarkdown wrap advisory could not run: ${message}`);
    console.error("Commit was not blocked.\n");
  }
}
