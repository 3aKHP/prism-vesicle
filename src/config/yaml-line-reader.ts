export type YamlLine = {
  number: number;
  indent: number;
  text: string;
};

/** Shared lexical reader for Vesicle's deliberately constrained YAML subset. */
export function readYamlLines(source: string): YamlLine[] {
  return source.split(/\r?\n/).flatMap((sourceLine, index) => {
    const withoutComment = stripYamlComment(sourceLine).replace(/\s+$/, "");
    if (!withoutComment.trim()) return [];
    return [{ number: index + 1, indent: leadingSpaces(withoutComment), text: withoutComment.trim() }];
  });
}

export function readYamlKeyValue(line: string, lineNumber: number, path: string, subject: string): [string, string] {
  const colon = line.indexOf(":");
  if (colon === -1) throw new Error(`${subject} parse error on line ${lineNumber} in ${path}: expected key: value.`);
  const key = line.slice(0, colon).trim();
  if (!key) throw new Error(`${subject} parse error on line ${lineNumber} in ${path}: empty key.`);
  return [key, unquoteYamlValue(line.slice(colon + 1).trim())];
}

export function unquoteYamlValue(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

export function stripYamlComment(line: string): string {
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if ((char === "\"" || char === "'") && (index === 0 || line[index - 1] !== "\\")) {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === "#" && quote === null) return line.slice(0, index);
  }
  return line;
}

function leadingSpaces(line: string): number {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}
