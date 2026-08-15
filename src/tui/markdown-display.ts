const GREEK_COMMANDS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};

const SYMBOL_COMMANDS: Record<string, string> = {
  times: "×",
  cdot: "·",
  div: "÷",
  pm: "±",
  mp: "∓",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  sim: "∼",
  equiv: "≡",
  infty: "∞",
  sum: "∑",
  prod: "∏",
  int: "∫",
  partial: "∂",
  nabla: "∇",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  subseteq: "⊆",
  superset: "⊃",
  supseteq: "⊇",
  emptyset: "∅",
  forall: "∀",
  exists: "∃",
  neg: "¬",
  land: "∧",
  lor: "∨",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  degree: "°",
};

const STRIP_COMMANDS = new Set([
  "left",
  "right",
  "big",
  "Big",
  "bigg",
  "Bigg",
  "mathrm",
  "mathit",
  "mathbf",
  "text",
]);

const SUPERSCRIPT_CHARS: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
};

const SUBSCRIPT_CHARS: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
};

type TextSegment = {
  text: string;
  fenced: boolean;
};

export function prepareMarkdownForDisplay(content: string): string {
  return splitFencedCodeSegments(content)
    .map((segment) => segment.fenced ? segment.text : renderMarkdownFormattingExtensions(renderLatexMath(segment.text)))
    .join("");
}

export function renderArtifactMarkdownPreview(content: string): string {
  let fenced = false;
  return prepareMarkdownForDisplay(content)
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : cleanArtifactPreviewLine(line);
    })
    .filter((line) => !/^```/.test(line.trim()))
    .join("\n");
}

function cleanArtifactPreviewLine(line: string): string {
  const { line: withoutSpans, spans } = protectCodeSpanContents(line);
  return restoreCodeSpanContents(
    unescapeMarkdownPunctuation(
      withoutSpans
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}>\s?/, "› ")
        .replace(/^\s*[-*+]\s+\[ \]\s+/, "☐ ")
        .replace(/^\s*[-*+]\s+\[x\]\s+/i, "☑ ")
        .replace(
          /\[([^\]]+)\]\(([^)]+)\)/g,
          (match, label: string, url: string, offset: number, source: string) => {
            if (hasEscapedDelimiter(source, match, offset, 1)) return match;
            if (source[offset - 1] === "!" && isUnescapedBackslashBefore(source, offset - 1)) return match;
            return `${label} (${url})`;
          },
        )
        .replace(/`([^`]+)`/g, (match, code: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 1)) return match;
          return code;
        })
        .replace(/\*\*([^*]+)\*\*/g, (match, value: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 2)) return match;
          return value;
        })
        .replace(/__([^_]+)__/g, (match, value: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 2)) return match;
          return value;
        })
        .replace(/\*([^*]+)\*/g, (match, value: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 1)) return match;
          return value;
        })
        .replace(/_([^_]+)_/g, (match, value: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 1)) return match;
          return value;
        }),
    ),
    spans,
  );
}

export function renderMarkdownPlainText(content: string): string {
  const lines: string[] = [];
  let fenced = false;

  for (const rawLine of prepareMarkdownForDisplay(content).split(/\r?\n/)) {
    const fence = rawLine.match(/^\s*```(.*)$/);
    if (fence) {
      fenced = !fenced;
      const language = fence[1]?.trim();
      lines.push(fenced
        ? `--- code${language ? `: ${language}` : ""} ---`
        : "--- end code ---");
      continue;
    }

    if (fenced) {
      lines.push(rawLine);
      continue;
    }

    lines.push(cleanMarkdownLine(rawLine));
  }

  return lines.join("\n");
}

function cleanMarkdownLine(line: string): string {
  const { line: withoutSpans, spans } = protectCodeSpanContents(line);
  return restoreCodeSpanContents(
    unescapeMarkdownPunctuation(
      withoutSpans
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}>\s?/, "> ")
        .replace(/^\s*[-*+]\s+\[ \]\s+/, "- [ ] ")
        .replace(/^\s*[-*+]\s+\[x\]\s+/i, "- [x] ")
        .replace(
          /!\[([^\]]*)\]\(([^)]+)\)/g,
          (match, alt: string, url: string, offset: number, source: string) => {
            if (isUnescapedBackslashBefore(source, offset)) return match;
            return `[image${alt ? `: ${alt}` : ""}] (${url})`;
          },
        )
        .replace(
          /\[([^\]]+)\]\(([^)]+)\)/g,
          (match, label: string, url: string, offset: number, source: string) => {
            if (isUnescapedBackslashBefore(source, offset)) return match;
            if (source[offset - 1] === "!" && isUnescapedBackslashBefore(source, offset - 1)) return match;
            return `${label} (${url})`;
          },
        )
        .replace(/`([^`]+)`/g, (match, code: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 1)) return match;
          return code;
        })
        .replace(/\*\*\*([^*]+)\*\*\*/g, (match, value: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 3)) return match;
          return value;
        })
        .replace(/___([^_]+)___/g, (match, value: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 3)) return match;
          return value;
        })
        .replace(/\*\*([^*]+)\*\*/g, (match, value: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 2)) return match;
          return value;
        })
        .replace(/__([^_]+)__/g, (match, value: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 2)) return match;
          return value;
        })
        .replace(/\*([^*]+)\*/g, (match, value: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 1)) return match;
          return value;
        })
        .replace(/_([^_]+)_/g, (match, value: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 1)) return match;
          return value;
        })
        .replace(/~~([^~]+)~~/g, (match, value: string, offset: number, source: string) => {
          if (hasEscapedDelimiter(source, match, offset, 2)) return match;
          return value;
        }),
    ),
    spans,
  );
}

/**
 * True when either delimiter of a matched marker pair is backslash-escaped,
 * in which case the marker is literal content and must survive the strip.
 * `markerLength` is the delimiter width in characters (1 for `*`/`` ` ``,
 * 2 for `**`/`~~`, 3 for `***`).
 */
function hasEscapedDelimiter(source: string, match: string, offset: number, markerLength: number): boolean {
  return isUnescapedBackslashBefore(source, offset)
    || isUnescapedBackslashBefore(source, offset + match.length - markerLength);
}

/**
 * Decode CommonMark backslash escapes as the final plain-text step: `\X`
 * (X ASCII punctuation) becomes `X`, `\\` becomes `\`. The regex consumes
 * pairs left to right, so `\\~` decodes to a literal backslash followed by
 * a plain tilde.
 */
function unescapeMarkdownPunctuation(line: string): string {
  return line.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

/**
 * Length of the backslash run that ends at `index` (inclusive). Used for
 * backslash-led delimiters (`\[`, `\(`): only a run of exactly 1 is the
 * LaTeX opener this renderer honors — a longer run means literal
 * backslashes followed by a plain (run length 2, 4, …) or escaped
 * (run length 3, 5, …) bracket, neither of which opens math.
 */
function backslashRunEndingAt(input: string, index: number): number {
  let run = 0;
  for (let cursor = index; cursor >= 0 && input[cursor] === "\\"; cursor -= 1) {
    run += 1;
  }
  return run;
}

/**
 * Replace the content of unescaped inline code spans with inert sentinels so
 * the marker strips and the final escape decode cannot touch it (CommonMark
 * escapes do not apply inside code). Backticks stay in place for the strip
 * pass; `restoreCodeSpanContents` puts the original content back afterwards.
 */
const CODE_SPAN_SENTINEL_OPEN = "";
const CODE_SPAN_SENTINEL_CLOSE = "";

function protectCodeSpanContents(line: string): { line: string; spans: string[] } {
  const spans: string[] = [];
  const protectedLine = line.replace(/`([^`]+)`/g, (match, code: string, offset: number, source: string) => {
    // Only the opening backtick can be escaped away. A content-final
    // backslash does not escape the closing backtick: code-span content is
    // literal, so `a\` is a span containing "a\".
    if (isUnescapedBackslashBefore(source, offset)) return match;
    spans.push(code);
    return `\`${CODE_SPAN_SENTINEL_OPEN}${spans.length - 1}${CODE_SPAN_SENTINEL_CLOSE}\``;
  });
  return { line: protectedLine, spans };
}

function restoreCodeSpanContents(line: string, spans: string[]): string {
  return line.replace(
    new RegExp(`${CODE_SPAN_SENTINEL_OPEN}(\\d+)${CODE_SPAN_SENTINEL_CLOSE}`, "g"),
    (_match, index: string) => spans[Number(index)] ?? "",
  );
}

export function renderLatexMath(input: string): string {
  let output = "";
  let index = 0;

  while (index < input.length) {
    if (input.startsWith("$$", index)) {
      const end = findUnescaped(input, "$$", index + 2);
      if (end >= 0) {
        if (isUnescapedBackslashBefore(input, index)) {
          // Parity-blocked opener: this `$$` and its closer are an escaped
          // literal. Emit both verbatim and jump past the closer, or the
          // literal's own closing `$$` would re-open math and swallow a
          // following real block.
          output += input.slice(index, end + 2);
        } else {
          output += renderDisplayMath(input.slice(index + 2, end));
        }
        index = end + 2;
        continue;
      }
    }

    if (input.startsWith("\\[", index) && backslashRunEndingAt(input, index) === 1) {
      const end = findUnescaped(input, "\\]", index + 2);
      if (end >= 0 && renderFormulaSignal(input.slice(index + 2, end))) {
        output += renderDisplayMath(input.slice(index + 2, end));
        index = end + 2;
        continue;
      }
    }

    if (input.startsWith("\\(", index) && backslashRunEndingAt(input, index) === 1) {
      const end = findUnescaped(input, "\\)", index + 2);
      if (end >= 0 && renderFormulaSignal(input.slice(index + 2, end))) {
        output += renderFormula(input.slice(index + 2, end));
        index = end + 2;
        continue;
      }
    }

    if (input[index] === "$" && !input.startsWith("$$", index) && !isEscaped(input, index)) {
      const end = findInlineDollarClose(input, index + 1);
      if (end >= 0) {
        const formula = input.slice(index + 1, end);
        if (isLikelyInlineMath(formula)) {
          output += renderFormula(formula);
          index = end + 1;
          continue;
        }
      }
    }

    output += input[index];
    index += 1;
  }

  return output;
}

function splitFencedCodeSegments(content: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const lines = content.split(/(\r?\n)/);
  let buffer = "";
  let fenced = false;

  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index] ?? "";
    const newline = lines[index + 1] ?? "";
    const fullLine = line + newline;
    const opensOrClosesFence = /^\s*```/.test(line);

    if (opensOrClosesFence) {
      if (buffer) {
        segments.push({ text: buffer, fenced });
        buffer = "";
      }
      fenced = !fenced;
      segments.push({ text: fullLine, fenced: true });
      continue;
    }

    buffer += fullLine;
  }

  if (buffer) {
    segments.push({ text: buffer, fenced });
  }

  return segments;
}

function renderDisplayMath(formula: string): string {
  const rendered = renderFormula(formula);
  return `⟦ ${rendered} ⟧`;
}

function renderFormula(formula: string): string {
  let rendered = formula.trim();

  rendered = replaceLatexBinaryCommand(rendered, "frac", (numerator, denominator) => `(${renderFormula(numerator)})/(${renderFormula(denominator)})`);
  rendered = replaceLatexUnaryCommand(rendered, "sqrt", (value) => `√(${renderFormula(value)})`);

  rendered = rendered
    .replace(/\\[,;:!]\s*/g, " ")
    .replace(/\\([A-Za-z]+)/g, (_match, command: string) => {
      if (GREEK_COMMANDS[command]) return GREEK_COMMANDS[command];
      if (SYMBOL_COMMANDS[command]) return SYMBOL_COMMANDS[command];
      if (STRIP_COMMANDS.has(command)) return "";
      return command;
    })
    .replace(/\\([{}$])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  rendered = replaceScripts(rendered);

  return rendered
    .replace(/\s*([=+\-×·/<>≤≥≈≠])\s*/g, "$1")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

function replaceLatexBinaryCommand(
  input: string,
  command: string,
  replacement: (left: string, right: string) => string,
): string {
  let output = "";
  let index = 0;
  const marker = `\\${command}`;

  while (index < input.length) {
    const start = input.indexOf(marker, index);
    if (start < 0) {
      output += input.slice(index);
      break;
    }

    const first = readBraceGroup(input, start + marker.length);
    const second = first ? readBraceGroup(input, first.end) : undefined;
    if (!first || !second) {
      output += input.slice(index, start + marker.length);
      index = start + marker.length;
      continue;
    }

    output += input.slice(index, start);
    output += replacement(first.value, second.value);
    index = second.end;
  }

  return output;
}

function replaceLatexUnaryCommand(input: string, command: string, replacement: (value: string) => string): string {
  let output = "";
  let index = 0;
  const marker = `\\${command}`;

  while (index < input.length) {
    const start = input.indexOf(marker, index);
    if (start < 0) {
      output += input.slice(index);
      break;
    }

    const group = readBraceGroup(input, start + marker.length);
    if (!group) {
      output += input.slice(index, start + marker.length);
      index = start + marker.length;
      continue;
    }

    output += input.slice(index, start);
    output += replacement(group.value);
    index = group.end;
  }

  return output;
}

function readBraceGroup(input: string, start: number): { value: string; end: number } | undefined {
  let index = start;
  while (/\s/.test(input[index] ?? "")) index += 1;
  if (input[index] !== "{") return undefined;

  let depth = 0;
  const valueStart = index + 1;
  for (; index < input.length; index += 1) {
    if (input[index] === "{" && !isEscaped(input, index)) depth += 1;
    if (input[index] === "}" && !isEscaped(input, index)) {
      depth -= 1;
      if (depth === 0) {
        return { value: input.slice(valueStart, index), end: index + 1 };
      }
    }
  }

  return undefined;
}

function replaceScripts(input: string): string {
  return input
    .replace(/\^\{([^{}\n]{1,16})\}/g, (_match, value: string) => mapScript(value, SUPERSCRIPT_CHARS))
    .replace(/_\{([^{}\n]{1,16})\}/g, (_match, value: string) => mapScript(value, SUBSCRIPT_CHARS))
    .replace(/\^([A-Za-z0-9+\-=()])/g, (_match, value: string) => mapScript(value, SUPERSCRIPT_CHARS))
    .replace(/_([A-Za-z0-9+\-=()])/g, (_match, value: string) => mapScript(value, SUBSCRIPT_CHARS));
}

function mapScript(value: string, map: Record<string, string>): string {
  return Array.from(value).map((char) => map[char] ?? char).join("");
}

function renderFormulaSignal(formula: string): boolean {
  return /[\\^_=+\-*/<>]|[A-Za-z]\d|\d[A-Za-z]/.test(formula);
}

function isLikelyInlineMath(formula: string): boolean {
  return formula.length > 0
    && formula.length <= 160
    && formula.trim() === formula
    && !formula.includes("\n")
    && renderFormulaSignal(formula);
}

function findInlineDollarClose(input: string, start: number): number {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === "\n") return -1;
    if (input[index] === "$" && !isEscaped(input, index) && !input.startsWith("$$", index)) {
      return index;
    }
  }
  return -1;
}

function findUnescaped(input: string, needle: string, start: number): number {
  let index = input.indexOf(needle, start);
  while (index >= 0) {
    if (!isEscaped(input, index)) return index;
    index = input.indexOf(needle, index + needle.length);
  }
  return -1;
}

function isEscaped(input: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && input[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}
import { isUnescapedBackslashBefore, renderMarkdownFormattingExtensions } from "./markdown-formatting";
