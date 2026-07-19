export type StageBootstrapSource = {
  path: string;
  sha256: string;
};

/** Frozen host-owned context for one Stage session. Never regenerated on resume. */
export type StageBootstrapMetadata = {
  schema: "prism-stage-bootstrap/v1";
  character: StageBootstrapSource;
  scenario: StageBootstrapSource;
  contextVersion: string;
  renderedCharacterContext: string;
  renderedOpening: string;
};

export function parseStageBootstrapMetadata(value: unknown): StageBootstrapMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== "prism-stage-bootstrap/v1" || raw.contextVersion !== "stage-context/v1"
    || typeof raw.renderedCharacterContext !== "string" || typeof raw.renderedOpening !== "string") return undefined;
  const parseSource = (source: unknown) => source && typeof source === "object" && !Array.isArray(source)
    && typeof (source as Record<string, unknown>).path === "string"
    && typeof (source as Record<string, unknown>).sha256 === "string"
    ? { path: (source as Record<string, string>).path, sha256: (source as Record<string, string>).sha256 }
    : undefined;
  const character = parseSource(raw.character);
  const scenario = parseSource(raw.scenario);
  return character && scenario ? {
    schema: "prism-stage-bootstrap/v1",
    character,
    scenario,
    contextVersion: "stage-context/v1",
    renderedCharacterContext: raw.renderedCharacterContext,
    renderedOpening: raw.renderedOpening,
  } : undefined;
}
