// vesicle config env-* — .env operations.
// Secret values are never accepted as command-line arguments. The CLI creates
// empty slots, manages the proxy URL, or removes variables. The user fills in
// actual secret values by editing .env directly.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { providerConfigPathFromEnv, parseEnvFile } from "../../../config/providers";
import { setEnvValues } from "../../../setup/config-writer";

type EnvResult = {
  ok: true;
  operation: string;
  key: string;
  path: string;
  summary: string;
  restartRequired: boolean;
};

export async function runEnvSetEmpty(key: string): Promise<void> {
  validateEnvKey(key);
  if (key === "VESICLE_PROVIDER_PROXY") {
    console.error("Use env-set-proxy to manage VESICLE_PROVIDER_PROXY.");
    process.exitCode = 1;
    return;
  }
  try {
    // Refuse to overwrite an existing value — the model cannot distinguish
    // <set> keys via show env and must not silently destroy a stored secret.
    const envPath = envFilePath();
    const existing = await readEnvFile(envPath);
    const fileEnv = parseEnvFile(existing || "", envPath);
    const existingValue = fileEnv[key];
    if (existingValue !== undefined && existingValue !== "") {
      console.error(
        `${key} already has a value in .env. Refusing to overwrite it with an empty slot. `
        + `Use env-remove first if you intend to clear it, or edit .env manually.`,
      );
      process.exitCode = 1;
      return;
    }
    const result = await setEnvKey(key, "");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function runEnvSetProxy(url: string): Promise<void> {
  try {
    new URL(url);
  } catch {
    console.error(`Invalid proxy URL "${url}". Must be a complete http:// or https:// URL.`);
    process.exitCode = 1;
    return;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.error(`Proxy URL must use http:// or https://, got "${parsed.protocol}".`);
    process.exitCode = 1;
    return;
  }
  if (parsed.username || parsed.password) {
    console.error(
      "Proxy URLs with credentials must not be passed as arguments. "
      + "Edit .env manually to set VESICLE_PROVIDER_PROXY with credentials.",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const result = await setEnvKey("VESICLE_PROVIDER_PROXY", url);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function runEnvRemove(key: string): Promise<void> {
  validateEnvKey(key);
  try {
    const result = await removeEnvKey(key);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function setEnvKey(key: string, value: string): Promise<EnvResult> {
  const envPath = envFilePath();
  const existing = await readEnvFile(envPath);
  const updated = setEnvValues(existing, { [key]: value });
  await atomicWrite(envPath, updated, true);
  const summary = value === ""
    ? `${key} created with empty value. Edit ${envPath} and paste the value after the = sign, then restart Vesicle.`
    : key === "VESICLE_PROVIDER_PROXY"
      ? `Proxy set to ${maskProxyUrl(value)}. Restart Vesicle to apply.`
      : `${key} updated. Restart Vesicle to apply.`;
  return { ok: true, operation: value === "" ? "env-set-empty" : "env-set", key, path: envPath, summary, restartRequired: true };
}

async function removeEnvKey(key: string): Promise<EnvResult> {
  const envPath = envFilePath();
  const existing = await readEnvFile(envPath);
  if (!existing) {
    console.warn(`${key} was not set in .env (no .env file); no changes needed.`);
    return { ok: true, operation: "env-remove", key, path: envPath, summary: `${key} was not set (no .env file).`, restartRequired: false };
  }

  const fileEnv = parseEnvFile(existing, envPath);
  if (!(key in fileEnv)) {
    console.warn(`${key} was not set in .env; no changes needed.`);
    return { ok: true, operation: "env-remove", key, path: envPath, summary: `${key} was not set in .env.`, restartRequired: false };
  }

  const lines = existing.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return match?.[1] !== key;
  });
  const updated = filtered.join("\n");
  await atomicWrite(envPath, updated, true);
  return { ok: true, operation: "env-remove", key, path: envPath, summary: `${key} removed. Restart Vesicle to apply.`, restartRequired: true };
}

function envFilePath(): string {
  return join(dirname(providerConfigPathFromEnv()), ".env");
}

async function readEnvFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return "";
    throw error;
  }
}

function validateEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name "${key}".`);
  }
}

function maskProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const auth = parsed.username ? "<credentials>@" : "";
    return `${parsed.protocol}//${auth}${parsed.host}`;
  } catch {
    return "<invalid-url>";
  }
}

async function atomicWrite(path: string, content: string, secret: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.staging-${randomUUID()}`;
  try {
    await writeFile(staging, content, { encoding: "utf8", flag: "wx", mode: secret ? 0o600 : 0o644 });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT");
}
