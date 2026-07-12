import { createAssetResolver, type AssetResolver, type AssetSource } from "../runtime/assets";

export type AgentContextMode = "fresh" | "summary" | "fork";
export type AgentExecutionMode = "foreground" | "background";
export type AgentModelPolicy = "inherit";

export type AgentProfile = {
  id: string;
  displayName: string;
  description: string;
  systemPrompt: string[];
  tools: string[];
  contextMode: AgentContextMode;
  modelPolicy: AgentModelPolicy;
  defaultMode: AgentExecutionMode;
  maxTurns: number;
  asset: {
    path: string;
    source: AssetSource;
  };
};

export async function listAgentProfiles(
  rootDir = process.cwd(),
  assets: AssetResolver = createAssetResolver(rootDir),
): Promise<AgentProfile[]> {
  const files = await assets.listFiles("assets/agents").catch((error: unknown) => {
    if (error instanceof Error && error.message.includes("Prism asset not found")) return [];
    throw error;
  });
  return Promise.all(
    files
      .filter((path) => path.endsWith(".agent.yaml"))
      .map((path) => loadAgentProfile(path.slice("assets/agents/".length, -".agent.yaml".length), rootDir, assets)),
  );
}
export async function loadAgentProfile(
  id: string,
  rootDir = process.cwd(),
  assets: AssetResolver = createAssetResolver(rootDir),
): Promise<AgentProfile> {
  assertAgentId(id);
  const resolved = await assets.resolveFile(`assets/agents/${id}.agent.yaml`);
  const raw = parseFlatProfile(await assets.readText(resolved.logicalPath));
  const declaredId = readString(raw, "id");
  if (declaredId !== id) {
    throw new Error(`Agent profile mismatch: file ${resolved.logicalPath} declares id "${declaredId}" but was loaded as "${id}".`);
  }
  assertAgentId(declaredId);

  const systemPrompt = readStringList(raw, "systemPrompt");
  if (systemPrompt.length === 0) throw new Error(`Agent profile "${id}" must declare at least one systemPrompt path.`);
  for (const path of systemPrompt) {
    if (!path.startsWith("assets/prompts/agents/")) {
      throw new Error(`Agent profile "${id}" systemPrompt paths must stay under assets/prompts/agents/: ${path}.`);
    }
    await assets.resolveFile(path);
  }

  const tools = readStringList(raw, "tools");
  if (tools.length === 0) throw new Error(`Agent profile "${id}" must declare at least one tool or "*".`);
  if (tools.includes("*") && tools.length !== 1) {
    throw new Error(`Agent profile "${id}" must use "*" alone instead of mixing it with named tools.`);
  }

  return {
    id,
    displayName: readString(raw, "displayName"),
    description: readString(raw, "description"),
    systemPrompt,
    tools,
    contextMode: readEnum(raw, "contextMode", ["fresh", "summary", "fork"]),
    modelPolicy: readEnum(raw, "modelPolicy", ["inherit"]),
    defaultMode: readEnum(raw, "defaultMode", ["foreground", "background"]),
    maxTurns: readPositiveInteger(raw, "maxTurns"),
    asset: { path: resolved.logicalPath, source: resolved.source },
  };
}

export async function loadAgentSystemPrompt(
  profile: AgentProfile,
  rootDir = process.cwd(),
  assets: AssetResolver = createAssetResolver(rootDir),
): Promise<string> {
  return (await Promise.all(profile.systemPrompt.map((path) => assets.readText(path))))
    .map((part) => part.trim())
    .join("\n\n");
}

function assertAgentId(id: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error(`Invalid agent profile id "${id}". Use lowercase letters, digits, and hyphens.`);
  }
}

type ProfileValue = string | string[];

function parseFlatProfile(source: string): Map<string, ProfileValue> {
  const map = new Map<string, ProfileValue>();
  let listKey: string | undefined;
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      const item = line.trim();
      if (!listKey || !item.startsWith("- ")) {
        throw new Error(`Agent profile parse error on line ${index + 1}: unexpected indentation.`);
      }
      const current = map.get(listKey);
      map.set(listKey, [...(Array.isArray(current) ? current : []), unquote(item.slice(2).trim())]);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`Agent profile parse error on line ${index + 1}: missing key colon.`);
    const key = line.slice(0, colon).trim();
    if (map.has(key)) throw new Error(`Agent profile parse error on line ${index + 1}: duplicate field "${key}".`);
    const value = line.slice(colon + 1).trim();
    if (!value) {
      listKey = key;
      map.set(key, []);
    } else if (value === "[]") {
      listKey = undefined;
      map.set(key, []);
    } else {
      listKey = undefined;
      map.set(key, unquote(value));
    }
  }
  return map;
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function readString(map: Map<string, ProfileValue>, key: string): string {
  const value = map.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`Agent profile field "${key}" must be a non-empty string.`);
  return value;
}

function readStringList(map: Map<string, ProfileValue>, key: string): string[] {
  const value = map.get(key);
  if (!Array.isArray(value)) throw new Error(`Agent profile field "${key}" must be a list.`);
  return value;
}

function readEnum<const T extends readonly string[]>(map: Map<string, ProfileValue>, key: string, values: T): T[number] {
  const value = readString(map, key);
  if (!values.includes(value)) throw new Error(`Agent profile field "${key}" must be one of: ${values.join(", ")}.`);
  return value as T[number];
}

function readPositiveInteger(map: Map<string, ProfileValue>, key: string): number {
  const value = readString(map, key);
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`Agent profile field "${key}" must be a positive integer.`);
  return Number(value);
}
