export function sameInboxIds(value: unknown, expected: string[]): boolean {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return false;
  const actual = [...new Set(value as string[])].sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}
