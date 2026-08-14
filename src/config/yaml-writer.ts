// Shared YAML emission and identifier helpers for Vesicle's deliberately
// constrained config subset. Both the provider writer and the MCP config
// editor must produce the same scalar/key quoting and id sanitization rules.

export function sanitizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "service";
}

export function uniqueId(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function yamlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : yamlScalar(value);
}

export function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@+${}-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
