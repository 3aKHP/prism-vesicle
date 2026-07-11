import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAssetsRoot } from "../runtime/assets";

/**
 * Engine identity. Mirrors the engine folders under assets/engines/ and
 * assets/prompts/engines/. Keep this as the single source of truth for the
 * set of engines Vesicle recognises.
 */
export type EngineId = "etl" | "runtime" | "evaluate" | "weaver" | "weaver-orch" | "dyad";

export const engineIds: readonly EngineId[] = [
  "etl",
  "runtime",
  "evaluate",
  "weaver",
  "weaver-orch",
  "dyad",
];

export type EngineProfile = {
  id: EngineId;
  displayName: string;
  protocolVersion: string;
  /**
   * Project-relative paths to prompt files, in composition order. The first
   * entry is typically the shared Vesicle base contract; subsequent entries
   * are the engine-specific prompts. Loaded and concatenated by the prompt
   * composer.
   */
  systemPrompt: string[];
  /**
   * Names of tools this engine is allowed to surface to the model. M0
   * resolves these against the built-in tool registry; unknown names are a
   * loader error so profiles cannot silently widen the surface.
   */
  defaultTools: string[];
  /**
   * Validator names that should run on this engine's outputs. Empty in M0
   * for every engine except etl once Module A/B validators land.
   */
  validators: string[];
  /**
   * Stop-gate identifiers this engine declares. The agent loop uses these to
   * recognise request_confirmation calls that belong to a declared gate and
   * to reject gates the engine did not declare.
   */
  stopGates: string[];
  /**
   * Project-relative directory roots this engine treats as durable state.
   * Informational in M0; the tool runtime enforces its own readable/writable
   * root allowlists independently.
   */
  stateRoots: string[];
};

/**
 * Load and parse an engine profile YAML from assets/engines/<id>.profile.yaml.
 *
 * The profile schema is intentionally narrow (scalars + string lists), so we
 * parse with a tiny hand-written reader instead of pulling a YAML dependency.
 * A profile that does not match the expected shape throws with a precise
 * message — profiles are author-controlled runtime assets and silent
 * mis-parsing would be a real hazard.
 */
export async function loadEngineProfile(
  engine: EngineId,
  rootDir = process.cwd(),
): Promise<EngineProfile> {
  const assetRoot = resolveAssetsRoot(rootDir);
  const profilePath = join(assetRoot, "assets", "engines", `${engine}.profile.yaml`);
  const source = await readFile(profilePath, "utf8");
  const raw = parseProfileYaml(source);

  const id = readString(raw, "id");
  const displayName = readString(raw, "displayName");
  const protocolVersion = readString(raw, "protocolVersion");
  const systemPrompt = readStringList(raw, "systemPrompt");
  const defaultTools = readStringList(raw, "defaultTools");
  const validators = readStringList(raw, "validators");
  const stopGates = readStringList(raw, "stopGates");
  const stateRoots = readStringList(raw, "stateRoots");

  if (id !== engine) {
    throw new Error(
      `Engine profile mismatch: file ${profilePath} declares id "${id}" but was loaded as "${engine}".`,
    );
  }

  if (systemPrompt.length === 0) {
    throw new Error(`Engine profile "${engine}" must declare at least one systemPrompt path.`);
  }

  return {
    id,
    displayName,
    protocolVersion,
    systemPrompt,
    defaultTools,
    validators,
    stopGates,
    stateRoots,
  };
}

// --- minimal YAML reader for the profile schema ----------------------------

type YamlValue = string | string[] | YamlMap | null;
type YamlMap = Map<string, YamlValue>;

/**
 * Parse the subset of YAML used by engine profiles: top-level `key: value`
 * pairs where value is either a scalar or a `- item` list. No nesting, no
 * quotes, no flow style. Anything else is rejected.
 */
function parseProfileYaml(source: string): YamlMap {
  const map: YamlMap = new Map();
  const lines = source.split(/\r?\n/);
  let currentListKey: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const line = rawLine.replace(/\s+$/, "");

    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    if (line.startsWith(" ") || line.startsWith("\t")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("- ")) {
        throw new Error(`Profile parse error on line ${index + 1}: unexpected indented line "${rawLine}".`);
      }
      if (currentListKey === null) {
        throw new Error(`Profile parse error on line ${index + 1}: list item without a key.`);
      }
      const item = trimmed.slice(2).trim();
      const existing = map.get(currentListKey);
      const next = Array.isArray(existing) ? [...existing, item] : [item];
      map.set(currentListKey, next);
      continue;
    }

    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`Profile parse error on line ${index + 1}: missing key colon in "${rawLine}".`);
    }

    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (value === "") {
      currentListKey = key;
      if (!map.has(key)) {
        map.set(key, []);
      }
      continue;
    }

    // Flow-style empty list: `key: []`. The profile schema has no other flow
    // collections, so we treat this specifically rather than supporting flow
    // syntax generally.
    if (value === "[]") {
      currentListKey = null;
      map.set(key, []);
      continue;
    }

    currentListKey = null;
    map.set(key, value);
  }

  return map;
}

function readString(map: YamlMap, key: string): string {
  const value = requireKey(map, key);
  if (typeof value !== "string") {
    throw new Error(`Profile field "${key}" must be a scalar string, got ${describe(value)}.`);
  }
  return value;
}

function readStringList(map: YamlMap, key: string): string[] {
  const value = requireKey(map, key);
  if (!Array.isArray(value)) {
    throw new Error(`Profile field "${key}" must be a list, got ${describe(value)}.`);
  }
  return value;
}

function requireKey(map: YamlMap, key: string): YamlValue {
  if (!map.has(key)) {
    throw new Error(`Profile is missing required field "${key}".`);
  }
  return map.get(key) as YamlValue;
}

function describe(value: YamlValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value;
}
