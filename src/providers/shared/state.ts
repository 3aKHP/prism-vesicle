export const providerStateEnvelopeVersion = 1 as const;
export const maxProviderStateEnvelopeBytes = 256 * 1024;

export type ProviderStateJson = null | boolean | number | string | ProviderStateJson[] | {
  [key: string]: ProviderStateJson;
};

export type ProviderStateEnvelope = {
  version: typeof providerStateEnvelopeVersion;
  protocol: string;
  providerId: string;
  model: string;
  endpointFingerprint: string;
  payload: ProviderStateJson;
};

const envelopeKeys = new Set([
  "version",
  "protocol",
  "providerId",
  "model",
  "endpointFingerprint",
  "payload",
]);
const maxProviderStateJsonDepth = 64;

/**
 * Validate provider-owned durable state without interpreting its payload.
 * Core may clone and project this envelope; only the matching adapter may
 * interpret `payload`.
 */
export function parseProviderStateEnvelope(value: unknown, label = "Provider state"): ProviderStateEnvelope {
  if (!isPlainObject(value)) throw new Error(`${label} is malformed: expected an object.`);
  const unknownKeys = Object.keys(value).filter((key) => !envelopeKeys.has(key));
  if (unknownKeys.length > 0) throw new Error(`${label} is malformed: unknown field ${unknownKeys[0]}.`);
  if (value.version !== providerStateEnvelopeVersion) {
    const version = typeof value.version === "number" ? value.version : "unknown";
    throw new Error(`${label} version ${version} is not supported by this version of Vesicle. Update Vesicle before resuming this provider state.`);
  }
  const protocol = requireBoundedString(value.protocol, `${label}.protocol`, 128);
  const providerId = requireBoundedString(value.providerId, `${label}.providerId`, 256);
  const model = requireBoundedString(value.model, `${label}.model`, 256);
  const endpointFingerprint = requireBoundedString(value.endpointFingerprint, `${label}.endpointFingerprint`, 512);
  assertJsonValue(value.payload, `${label}.payload`);
  const envelope: ProviderStateEnvelope = {
    version: providerStateEnvelopeVersion,
    protocol,
    providerId,
    model,
    endpointFingerprint,
    payload: cloneJsonValue(value.payload),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
  if (bytes > maxProviderStateEnvelopeBytes) {
    throw new Error(`${label} exceeds the ${maxProviderStateEnvelopeBytes}-byte durable-state limit.`);
  }
  return envelope;
}

export function cloneProviderStateEnvelope(value: ProviderStateEnvelope): ProviderStateEnvelope {
  return parseProviderStateEnvelope(value);
}

function requireBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, label: string): asserts value is ProviderStateJson {
  const failure = jsonValueFailure(value);
  if (failure) throw new Error(`${label} is not JSON-safe: ${failure}.`);
}

function jsonValueFailure(value: unknown, ancestors = new Set<object>(), depth = 0): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : "contains a non-finite number";
  if (typeof value !== "object") return `contains an unsupported ${typeof value} value`;
  if (ancestors.has(value)) return "contains a cycle";
  if (depth >= maxProviderStateJsonDepth) return `exceeds the maximum depth of ${maxProviderStateJsonDepth}`;
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const failure = jsonValueFailure(entry, nextAncestors, depth + 1);
      if (failure) return failure;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return "contains a non-plain object";
  if (Object.getOwnPropertySymbols(value).length > 0) return "contains a symbol-keyed property";
  for (const entry of Object.values(value)) {
    const failure = jsonValueFailure(entry, nextAncestors, depth + 1);
    if (failure) return failure;
  }
  return undefined;
}

function cloneJsonValue(value: ProviderStateJson): ProviderStateJson {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]));
  }
  return value;
}
