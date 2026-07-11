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
  return prepareMarkdownForDisplay(content)
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s{0,3}>\s?/, "› ")
      .replace(/^\s*[-*+]\s+\[ \]\s+/, "☐ ")
      .replace(/^\s*[-*+]\s+\[x\]\s+/i, "☑ ")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1"))
    .filter((line) => !/^```/.test(line.trim()))
    .join("\n");
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
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}>\s?/, "> ")
    .replace(/^\s*[-*+]\s+\[ \]\s+/, "- [ ] ")
    .replace(/^\s*[-*+]\s+\[x\]\s+/i, "- [x] ")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, url: string) => `[image${alt ? `: ${alt}` : ""}] (${url})`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/___([^_]+)___/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1");
}

export function renderLatexMath(input: string): string {
  let output = "";
  let index = 0;

  while (index < input.length) {
    if (input.startsWith("$$", index)) {
      const end = findUnescaped(input, "$$", index + 2);
      if (end >= 0) {
        output += renderDisplayMath(input.slice(index + 2, end));
        index = end + 2;
        continue;
      }
    }

    if (input.startsWith("\\[", index)) {
      const end = findUnescaped(input, "\\]", index + 2);
      if (end >= 0) {
        output += renderDisplayMath(input.slice(index + 2, end));
        index = end + 2;
        continue;
      }
    }

    if (input.startsWith("\\(", index)) {
      const end = findUnescaped(input, "\\)", index + 2);
      if (end >= 0) {
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
import { renderMarkdownFormattingExtensions } from "./markdown-formatting";
