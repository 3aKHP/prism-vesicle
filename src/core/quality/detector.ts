import { createHash } from "node:crypto";
import type {
  QualityCandidate,
  QualityDetectorRule,
  QualityEvaluation,
  QualityFinding,
  QualityProtectedRange,
} from "./types";

type TextUnit = { text: string; start: number; end: number };

export function evaluateQualityCandidate(candidate: QualityCandidate, rules: readonly QualityDetectorRule[]): QualityEvaluation {
  const started = performance.now();
  const normalizedContent = normalizeCandidate(candidate.content);
  const protectedRanges = mergeRanges([
    ...builtInProtectedRanges(normalizedContent),
    ...validateProtectedRanges(candidate.protectedRanges ?? [], normalizedContent.length),
  ]);
  const masked = maskRanges(normalizedContent, protectedRanges);
  const findings = rules
    .filter((rule) => rule.targets.includes("narrative-prose"))
    .flatMap((rule) => matchRule(rule, normalizedContent, masked));
  const unique = deduplicateFindings(findings);
  return {
    normalizedContent,
    candidateHash: createHash("sha256").update(normalizedContent).digest("hex"),
    findings: unique,
    blockingFindings: unique.filter((finding) => finding.maturity === "stable" && finding.severity === "tier1"),
    detectorMs: Math.max(0, performance.now() - started),
  };
}

export function normalizeCandidate(content: string): string {
  return content.replace(/\r\n?/g, "\n").normalize("NFC");
}

function matchRule(rule: QualityDetectorRule, original: string, masked: string): QualityFinding[] {
  const units = textUnits(masked, rule.matcher.unit);
  const findings: QualityFinding[] = [];
  for (const unit of units) {
    if (rule.matcher.kind === "literal") {
      let offset = 0;
      while (offset <= unit.text.length - rule.matcher.value.length) {
        const index = unit.text.indexOf(rule.matcher.value, offset);
        if (index < 0) break;
        findings.push(finding(rule, original, unit.start + index, unit.start + index + rule.matcher.value.length));
        offset = index + Math.max(1, rule.matcher.value.length);
      }
      continue;
    }
    if (rule.matcher.kind === "regex") {
      const flags = `${rule.matcher.flags ?? ""}`.replace(/[gy]/g, "");
      const expression = new RegExp(rule.matcher.value, flags.includes("g") ? flags : `${flags}g`);
      for (const match of unit.text.matchAll(expression)) {
        const start = unit.start + (match.index ?? 0);
        const end = start + Math.max(1, match[0].length);
        findings.push(finding(rule, original, start, end));
      }
      continue;
    }
    if (rule.matcher.kind !== "metric") continue;
    const trimmed = trimUnit(unit);
    if (!trimmed.text || !metricMatches(trimmed.text, rule.matcher.metric.operator, rule.matcher.metric.threshold)) continue;
    findings.push(finding(rule, original, trimmed.start, trimmed.end));
  }
  return findings;
}

function metricMatches(text: string, operator: "gte" | "gt" | "lte" | "lt", threshold: number): boolean {
  const density = ((text.match(/—/g)?.length ?? 0) / Math.max(1, text.length)) * 100;
  switch (operator) {
    case "gte": return density >= threshold;
    case "gt": return density > threshold;
    case "lte": return density <= threshold;
    case "lt": return density < threshold;
  }
}

function finding(rule: QualityDetectorRule, content: string, start: number, end: number): QualityFinding {
  return {
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    maturity: rule.maturity,
    start,
    end,
    evidence: content.slice(start, end).slice(0, 160),
  };
}

function textUnits(content: string, unit: "candidate" | "paragraph" | "sentence"): TextUnit[] {
  if (unit === "candidate") return [{ text: content, start: 0, end: content.length }];
  const expression = unit === "paragraph" ? /(?:^|\n\s*\n)([\s\S]*?)(?=\n\s*\n|$)/g : /[^。！？!?\n]+[。！？!?]?|\n/g;
  const units: TextUnit[] = [];
  for (const match of content.matchAll(expression)) {
    const text = unit === "paragraph" ? match[1] ?? "" : match[0];
    const start = (match.index ?? 0) + (unit === "paragraph" ? match[0].indexOf(text) : 0);
    units.push({ text, start, end: start + text.length });
  }
  return units;
}

function trimUnit(unit: TextUnit): TextUnit {
  const leading = unit.text.match(/^\s*/)?.[0].length ?? 0;
  const trailing = unit.text.match(/\s*$/)?.[0].length ?? 0;
  const end = Math.max(leading, unit.text.length - trailing);
  return { text: unit.text.slice(leading, end), start: unit.start + leading, end: unit.start + end };
}

function builtInProtectedRanges(content: string): QualityProtectedRange[] {
  return [
    ...fencedCodeRanges(content),
    ...regexRanges(content, /<!--[\s\S]*?(?:-->|$)/g),
    ...regexRanges(content, /^\s*>.*$/gm),
    ...regexRanges(content, /^\s*\[(?:Beat|Tension|Char|Scene|Turn)(?:\]|:).*$/gim),
    ...regexRanges(content, /^---\s*$[\s\S]*?^---\s*$/gm),
    ...regexRanges(content, /^\s{0,3}#{1,6}\s+.*$/gm),
    ...regexRanges(content, /^\s*(?:[-+*]|\d+[.)])\s+.*$/gm),
    ...regexRanges(content, /^\s*\|.*\|\s*$/gm),
  ];
}

function fencedCodeRanges(content: string): QualityProtectedRange[] {
  const ranges: QualityProtectedRange[] = [];
  const lines = [...content.matchAll(/^.*(?:\n|$)/gm)];
  let open: { marker: string; start: number } | undefined;
  for (const line of lines) {
    const text = line[0];
    const fence = text.match(/^\s*(```+|~~~+)/)?.[1];
    if (!open && fence) open = { marker: fence[0]!, start: line.index ?? 0 };
    else if (open && fence?.[0] === open.marker) {
      ranges.push({ start: open.start, end: (line.index ?? 0) + text.length });
      open = undefined;
    }
  }
  if (open) ranges.push({ start: open.start, end: content.length });
  return ranges;
}

function regexRanges(content: string, expression: RegExp): QualityProtectedRange[] {
  return [...content.matchAll(expression)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function validateProtectedRanges(ranges: QualityProtectedRange[], length: number): QualityProtectedRange[] {
  return ranges.map((range, index) => {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)
      || range.start < 0 || range.end <= range.start || range.end > length) {
      throw new Error(`Quality protected range ${index + 1} is outside the normalized candidate.`);
    }
    return { ...range };
  });
}

function mergeRanges(ranges: QualityProtectedRange[]): QualityProtectedRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: QualityProtectedRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) merged.push({ ...range });
    else previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

function maskRanges(content: string, ranges: QualityProtectedRange[]): string {
  const chars = content.split("");
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index++) {
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
    }
  }
  return chars.join("");
}

function deduplicateFindings(findings: QualityFinding[]): QualityFinding[] {
  const seen = new Set<string>();
  return findings
    .sort((left, right) => left.start - right.start || left.ruleId.localeCompare(right.ruleId))
    .filter((finding) => {
      const key = `${finding.ruleId}\0${finding.start}\0${finding.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
