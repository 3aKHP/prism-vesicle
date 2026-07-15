import packageJson from "../../../package.json";

const anthropicBetaFeatures = [
  "claude-code-20250219",
  "context-1m-2025-08-07",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
].join(",");

export function defaultUserAgent(): string {
  return `prism-vesicle/${packageJson.version} runtime/bun/${Bun.version}`;
}

export function openAIChatHeaders(userAgent?: string): Record<string, string> {
  return {
    "accept": "*/*",
    "content-type": "application/json",
    "user-agent": userAgent ?? defaultUserAgent(),
  };
}

export function anthropicMessagesHeaders(userAgent?: string): Record<string, string> {
  return {
    "accept": "application/json",
    "anthropic-beta": anthropicBetaFeatures,
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "user-agent": userAgent ?? defaultUserAgent(),
    "x-app": "cli",
    "x-stainless-arch": stainlessArch(),
    "x-stainless-lang": "js",
    "x-stainless-os": stainlessOs(),
    "x-stainless-package-version": "0.94.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  };
}

export function geminiGenerateContentHeaders(userAgent?: string): Record<string, string> {
  const googleClient = `google-genai-sdk/1.30.0 gl-node/${process.version}`;
  return {
    "content-type": "application/json",
    "user-agent": userAgent ?? defaultUserAgent(),
    "x-goog-api-client": googleClient,
  };
}

function stainlessArch(): string {
  if (process.arch === "x64") return "x64";
  if (process.arch === "arm64") return "arm64";
  return process.arch;
}

function stainlessOs(): string {
  if (process.platform === "win32") return "Windows";
  if (process.platform === "darwin") return "MacOS";
  if (process.platform === "linux") return "Linux";
  return process.platform;
}
