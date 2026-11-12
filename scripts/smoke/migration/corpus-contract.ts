import assert from "node:assert/strict";

export type CorpusCase = {
  id: string;
  sessionId: string;
  heads: string[];
  materializeImages: boolean;
  readAgents: boolean;
  readProcesses: boolean;
  skillPaths: string[];
  candidateLeaves: string[];
  assertions: Array<{ path: string[]; equals: unknown }>;
  expectedError: { name?: string; code?: string; messageIncludes?: string } | null;
};

function object(value: unknown): asserts value is Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "expected object");
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) assert(allowed.includes(key), `unknown field: ${key}`);
}
function strings(value: unknown): asserts value is string[] {
  assert(Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0));
  assert.equal(new Set(value).size, value.length, "duplicate string entry");
}

export function parseCorpusCase(value: unknown): CorpusCase {
  object(value);
  keys(value, ["id", "sessionId", "heads", "materializeImages", "readAgents", "readProcesses", "skillPaths", "candidateLeaves", "assertions", "expectedError"]);
  for (const key of ["id", "sessionId"] as const) assert(typeof value[key] === "string" && /^[a-z0-9-]+$/.test(value[key]));
  for (const key of ["heads", "skillPaths", "candidateLeaves"] as const) strings(value[key]);
  for (const path of value.skillPaths as string[]) assert(!path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => part === ".." || part === "." || !part));
  for (const head of value.heads as string[]) assert(/^[a-zA-Z0-9-]+$/.test(head) && head !== "default");
  for (const key of ["materializeImages", "readAgents", "readProcesses"]) assert.equal(typeof value[key], "boolean");
  assert(Array.isArray(value.assertions));
  for (const item of value.assertions) {
    object(item); keys(item, ["path", "equals"]);
    // Repeated property names at different nesting levels are valid.
    assert(Array.isArray(item.path) && item.path.length > 0 && item.path.every((key) => typeof key === "string" && key.length));
    assert(Object.hasOwn(item, "equals"));
  }
  if (value.expectedError !== null) {
    object(value.expectedError); keys(value.expectedError, ["name", "code", "messageIncludes"]);
    assert(Object.keys(value.expectedError).length > 0);
    for (const item of Object.values(value.expectedError)) assert(typeof item === "string" && item.length > 0);
    assert.equal(value.assertions.length, 0, "negative cases must not carry ignored projection assertions");
  } else assert(value.assertions.length > 0, "positive case needs an independent expectation");
  return value as CorpusCase;
}

export function parseCorpus(value: unknown): CorpusCase[] {
  object(value); keys(value, ["schemaVersion", "cases"]);
  assert.equal(value.schemaVersion, 1);
  assert(Array.isArray(value.cases) && value.cases.length > 0);
  const cases = value.cases.map(parseCorpusCase);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length, "duplicate case id");
  return cases;
}

function atPath(value: unknown, path: string[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function verifyCorpusObservation(scenario: CorpusCase, observation: unknown): string[] {
  const assertions: string[] = [];
  const error = atPath(observation, ["error"]);
  if (scenario.expectedError) {
    object(error);
    for (const key of ["name", "code"] as const) if (scenario.expectedError[key]) assert.equal(error[key], scenario.expectedError[key]);
    if (scenario.expectedError.messageIncludes) assert(typeof error.message === "string" && error.message.includes(scenario.expectedError.messageIncludes));
    assertions.push("required reader failure observed");
  } else {
    assert.equal(error, undefined, `unexpected reader failure: ${JSON.stringify(error)}`);
    for (const expected of scenario.assertions) {
      assert.deepEqual(atPath(observation, expected.path), expected.equals, `${scenario.id}: ${expected.path.join("/")}`);
      assertions.push(expected.path.join("/"));
    }
  }
  return assertions;
}
