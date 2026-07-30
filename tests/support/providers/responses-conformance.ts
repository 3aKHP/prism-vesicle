export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type CaptureDifference = {
  path: string;
  kind: "missing" | "unexpected" | "value" | "key-order";
  expected?: JsonValue;
  actual?: JsonValue;
};

export function compareStructuredCapture(
  expected: JsonValue,
  actual: JsonValue,
  allowedPaths: ReadonlySet<string> = new Set(),
): CaptureDifference[] {
  return compareAtPath(expected, actual, "$", allowedPaths).filter(
    (difference) => !isAllowed(difference.path, allowedPaths),
  );
}

function compareAtPath(
  expected: JsonValue | undefined,
  actual: JsonValue | undefined,
  path: string,
  allowedPaths: ReadonlySet<string>,
): CaptureDifference[] {
  if (isAllowed(path, allowedPaths)) return [];
  if (expected === undefined) return [{ path, kind: "unexpected", actual }];
  if (actual === undefined) return [{ path, kind: "missing", expected }];
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return [{ path, kind: "value", expected, actual }];
    }
    const differences: CaptureDifference[] = [];
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index++) {
      differences.push(...compareAtPath(expected[index], actual[index], `${path}[${index}]`, allowedPaths));
    }
    return differences;
  }
  if (isObject(expected) || isObject(actual)) {
    if (!isObject(expected) || !isObject(actual)) {
      return [{ path, kind: "value", expected, actual }];
    }
    const differences: CaptureDifference[] = [];
    const expectedKeys = Object.keys(expected).filter((key) => !isAllowed(`${path}.${key}`, allowedPaths));
    const actualKeys = Object.keys(actual).filter((key) => !isAllowed(`${path}.${key}`, allowedPaths));
    if (expectedKeys.join("\u0000") !== actualKeys.join("\u0000")) {
      differences.push({ path, kind: "key-order", expected: expectedKeys, actual: actualKeys });
    }
    for (const key of new Set([...expectedKeys, ...actualKeys])) {
      differences.push(...compareAtPath(expected[key], actual[key], `${path}.${key}`, allowedPaths));
    }
    return differences;
  }
  return Object.is(expected, actual) ? [] : [{ path, kind: "value", expected, actual }];
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowed(path: string, allowedPaths: ReadonlySet<string>): boolean {
  for (const allowedPath of allowedPaths) {
    if (path === allowedPath || path.startsWith(`${allowedPath}.`) || path.startsWith(`${allowedPath}[`)) return true;
  }
  return false;
}
