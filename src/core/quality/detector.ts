import { createHash } from "node:crypto";
import type {
  QualityCandidate,
  QualityDetectorRule,
  QualityEvaluation,
  QualityFinding,
  QualityMetric,
  QualityMetricPattern,
  QualityProtectedRange,
} from "./types";
import { isDocumentMetricSignal } from "./metrics";

type TextUnit = { text: string; start: number; end: number };

export function evaluateQualityCandidate(candidate: QualityCandidate, rules: readonly QualityDetectorRule[]): QualityEvaluation {
  const started = performance.now();
  const normalizedContent = normalizeCandidate(candidate.content);
  const protectedRanges = mergeRanges([
    ...builtInProtectedRanges(normalizedContent),
    ...validateProtectedRanges(candidate.protectedRanges ?? [], normalizedContent.length),
  ]);
  const masked = maskRanges(normalizedContent, protectedRanges);
  const documentMetricMasked = maskRanges(normalizedContent, mergeRanges([
    ...protectedRanges,
    ...documentMetricProtectedRanges(normalizedContent),
  ]));
  const findings = rules
    .filter((rule) => rule.targets.includes("narrative-prose"))
    .flatMap((rule) => matchRule(rule, normalizedContent, masked, documentMetricMasked));
  const unique = deduplicateFindings(findings);
  return {
    normalizedContent,
    candidateHash: createHash("sha256").update(normalizedContent).digest("hex"),
    findings: unique,
    blockingFindings: unique.filter((finding) =>
      finding.maturity === "stable"
      && finding.severity === "tier1"
      && !(finding.metric && isDocumentMetricSignal(finding.metric.signal))
    ),
    detectorMs: Math.max(0, performance.now() - started),
  };
}

export function normalizeCandidate(content: string): string {
  return content.replace(/\r\n?/g, "\n").normalize("NFC");
}

function matchRule(
  rule: QualityDetectorRule,
  original: string,
  masked: string,
  documentMetricMasked: string,
): QualityFinding[] {
  const metric = rule.matcher.kind === "metric" ? rule.matcher.metric : undefined;
  const units = textUnits(metric && isDocumentMetricSignal(metric.signal) ? documentMetricMasked : masked, rule.matcher.unit);
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
    const metricFinding = matchMetric(rule, original, unit, rule.matcher.metric);
    if (metricFinding) findings.push(metricFinding);
  }
  return findings;
}

function matchMetric(
  rule: QualityDetectorRule,
  original: string,
  unit: TextUnit,
  metric: QualityMetric,
): QualityFinding | undefined {
  if (metric.signal === "em_dash_per_100_chars") {
    const trimmed = trimUnit(unit);
    const local = trimmed.text.indexOf("—");
    if (local < 0) return undefined;
    const value = ((trimmed.text.match(/—/g)?.length ?? 0) / Math.max(1, [...trimmed.text].length)) * 100;
    if (!compareMetric(value, metric.operator, metric.threshold)) return undefined;
    const start = trimmed.start + local;
    return finding(rule, original, start, start + 1, {
      signal: metric.signal,
      value,
      threshold: metric.threshold,
    });
  }

  const narrative = metric.excludeDialogue ? metricProse(unit.text) : unit.text;
  let firstMatch: { start: number; end: number } | undefined;
  let matchCount = 0;
  let coreMatches = 0;
  const buckets = new Set<string>();
  for (const pattern of metric.patterns ?? []) {
    const flags = `${pattern.flags ?? "u"}g`;
    for (const match of narrative.matchAll(new RegExp(pattern.value, flags))) {
      if (!match[0]) continue;
      if (shouldSkipMetricMatch(metric.signal, pattern, narrative, match.index)) continue;
      const current = { start: match.index, end: match.index + match[0].length };
      if (!firstMatch || current.start < firstMatch.start) firstMatch = current;
      matchCount += 1;
      buckets.add(pattern.id);
      if (pattern.core) coreMatches += 1;
    }
  }
  if (!firstMatch || matchCount < (metric.minimumMatches ?? 1)) return undefined;
  if (coreMatches < (metric.minimumCoreMatches ?? 0)) return undefined;
  if (buckets.size < (metric.minimumBuckets ?? 0)) return undefined;

  let value: number;
  if (metric.signal === "action_list_verbs_per_paragraph") {
    const separators = [...narrative].filter((char) => "，、；;".includes(char)).length;
    if (separators < (metric.minimumSeparators ?? 1)) return undefined;
    value = matchCount;
  } else {
    value = (matchCount / Math.max(1, visibleLength(narrative))) * 1_000;
  }
  if (!compareMetric(value, metric.operator, metric.threshold)) return undefined;
  return finding(rule, original, unit.start + firstMatch.start, unit.start + firstMatch.end, {
    signal: metric.signal,
    value,
    threshold: metric.threshold,
  });
}

function shouldSkipMetricMatch(
  signal: QualityMetric["signal"],
  pattern: QualityMetricPattern,
  narrative: string,
  index: number,
): boolean {
  return signal === "metaphor_markers_per_1000_chars"
    && pattern.id === "material-like-phrase"
    && /好像|像是|像|仿佛|宛如|如同|犹如/u.test(narrative.slice(Math.max(0, index - 8), index));
}

function metricProse(text: string): string {
  const chars = text.split("");
  const quotePairs: Array<[string, string]> = [
    ["「", "」"],
    ["『", "』"],
    ["【", "】"],
    ["“", "”"],
    ["‘", "’"],
    ["\"", "\""],
    ["'", "'"],
  ];
  for (const [open, close] of quotePairs) {
    let cursor = 0;
    while (cursor < text.length) {
      const start = text.indexOf(open, cursor);
      if (start < 0) break;
      const end = text.indexOf(close, start + open.length);
      if (end < 0) break;
      for (let index = start; index < end + close.length; index += 1) {
        if (chars[index] !== "\n") chars[index] = " ";
      }
      cursor = end + close.length;
    }
  }
  return chars.join("");
}

function visibleLength(text: string): number {
  return text.match(/[一-鿿Ａ-ｚA-Za-z0-9]/gu)?.length ?? 0;
}

function compareMetric(value: number, operator: "gte" | "gt" | "lte" | "lt", threshold: number): boolean {
  switch (operator) {
    case "gte": return value >= threshold;
    case "gt": return value > threshold;
    case "lte": return value <= threshold;
    case "lt": return value < threshold;
  }
}

function finding(
  rule: QualityDetectorRule,
  content: string,
  start: number,
  end: number,
  metric?: QualityFinding["metric"],
): QualityFinding {
  return {
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    maturity: rule.maturity,
    start,
    end,
    evidence: content.slice(start, end).slice(0, 160),
    ...(metric ? { metric } : {}),
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
    ...regexRanges(content, /^\s*\[(?:Beat|Tension|Char|Scene|Turn|!Neural Chain)(?:\]|:).*$/gim),
    ...regexRanges(content, /^---\s*$[\s\S]*?^---\s*$/gm),
    ...regexRanges(content, /^\s{0,3}#{1,6}\s+.*$/gm),
    ...regexRanges(content, /^\s*(?:[-+*]|\d+[.)])\s+.*$/gm),
    ...regexRanges(content, /^\s*\|.*\|\s*$/gm),
  ];
}

function documentMetricProtectedRanges(content: string): QualityProtectedRange[] {
  return regexRanges(content, /^[ \t]*第[零一二三四五六七八九十百千万\d]+章(?:\s|_|$).*$/gm);
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
