import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProviderConfig } from "../../../src/config/providers";

export type AcceptancePrecondition = {
  ok: boolean;
  /** Skip reason when ok is false (secret-free; never includes the API key value). */
  reason: string;
  providerId: string;
  model: string;
  apiKeyLabel: string;
  baseUrl: string;
};

const UNCONFIGURED: Omit<AcceptancePrecondition, "ok" | "reason"> = {
  providerId: "",
  model: "",
  apiKeyLabel: "",
  baseUrl: "",
};

/**
 * Acceptance precondition: the operator must opt in with BUN_E2E_REAL_PROVIDER=1
 * and the selected provider must resolve with credentials. Returns a secret-free
 * status — the live apiKey is read only to confirm presence and is never surfaced.
 */
export async function checkAcceptancePrecondition(): Promise<AcceptancePrecondition> {
  if (process.env.BUN_E2E_REAL_PROVIDER !== "1") {
    return { ...UNCONFIGURED, ok: false, reason: "BUN_E2E_REAL_PROVIDER=1 is not set" };
  }
  try {
    const status = await inspectProviderConfig();
    const missing = status.missing.length > 0
      ? status.missing
      : !status.hasApiKey
        ? [status.apiKeyLabel ?? "apiKey"]
        : [];
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `selected provider credentials missing: ${missing.join(", ")}`,
        providerId: status.providerId ?? "",
        model: status.model ?? "",
        apiKeyLabel: status.apiKeyLabel ?? "",
        baseUrl: status.baseUrl ?? "",
      };
    }
    return {
      ok: true,
      reason: "ok",
      providerId: status.providerId ?? "",
      model: status.model ?? "",
      apiKeyLabel: status.apiKeyLabel ?? "",
      baseUrl: status.baseUrl ?? "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...UNCONFIGURED, ok: false, reason: `provider config unavailable: ${message}` };
  }
}

/** Create an isolated ETL project root with the bundled assets and an empty workspace. */
export async function createAcceptanceRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "vesicle-acceptance-"));
  await cp("assets", join(rootDir, "assets"), { recursive: true });
  await mkdir(join(rootDir, "workspace"), { recursive: true });
  await writeFile(join(rootDir, "workspace", ".gitkeep"), "", "utf8");
  return rootDir;
}

export async function removeAcceptanceRoot(rootDir: string): Promise<void> {
  await rm(rootDir, { recursive: true, force: true });
}

/**
 * Print one structured, secret-free summary line. Callers must never include the
 * API key, the full private prompt, or raw model prose — only metadata, lengths,
 * counts, and gate names that constitute the durable acceptance record.
 */
export function summarize(suite: string, fields: Record<string, unknown>): void {
  console.log(`[acceptance:${suite}] ${JSON.stringify(fields)}`);
}
