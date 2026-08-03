import { inspectProviderConfig, loadConfigForSelection, loadUserConfigEnvironment } from "../config/providers";
import type { ResponsesProfile } from "../config/env";
import { loadExperimentalQualitySettings } from "../config/quality";
import { inspectMcpConfig } from "../mcp/registry";
import { describeProviderProxy, formatProviderProxyDiagnostic, loadProviderProxyPolicy } from "../providers/shared/proxy";
import { inspectAssets } from "./assets";
import { inspectSkills } from "./commands/skills";
import { readActiveIndex } from "../skills";
import { loadPermissionSettings } from "../config/permissions";
import { resolveShellProfile } from "../core/process/shell-profile";

export async function runDoctor(): Promise<void> {
  const config = await inspectProviderConfig();
  const userEnv = await loadUserConfigEnvironment();
  const mcp = await inspectMcpConfig();
  const assets = await inspectAssets();
  const permissions = await loadPermissionSettings();
  const shell = resolveShellProfile(permissions.shellInterpreter);
  let qualityStatus: string;
  try {
    const quality = await loadExperimentalQualitySettings();
    if (quality.mode === "off") {
      qualityStatus = `experimental off (${quality.path})`;
    } else {
      const judge = await loadConfigForSelection({ provider: quality.providerAlias, model: quality.modelId });
      qualityStatus = `experimental ${quality.mode} ${quality.providerAlias}/${quality.modelId}; ${judge.apiKey ? "API key available" : "API key missing"}; ${quality.judgeTimeoutMs} ms (${quality.path})`;
    }
  } catch (error) {
    qualityStatus = `experimental configuration invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  let skillsStatus: string;
  try {
    const skills = await inspectSkills();
    const shadowed = skills.result.diagnostics.filter((diagnostic) => diagnostic.kind === "shadowed").length;
    const base = `${skills.result.skills.length} valid, ${skills.result.invalid.length} invalid, ${shadowed} shadowed`;
    let installed: string;
    try {
      installed = `${(await readActiveIndex()).entries.length} installed`;
    } catch {
      // A corrupted store index must not mask the harness/user scope counts.
      installed = "installed count unavailable";
    }
    skillsStatus = `${base}, ${installed}`;
  } catch (error) {
    skillsStatus = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const bunVersion = Bun.version;

  console.log("Prism Vesicle Doctor");
  console.log(`Bun: ${bunVersion}`);
  console.log(`Project: ${process.cwd()}`);
  console.log(`Provider: ${config.providerId}`);
  console.log(`Protocol: ${config.provider}`);
  if (config.provider === "openai-responses") {
    console.log(`Responses profile: ${config.responsesProfile ?? "missing"}`);
    console.log(`Responses tier: ${responsesTier(config.responsesProfile)}`);
    console.log(`Responses transport: ${config.responsesTransport ?? "http (default)"}`);
    console.log(`Responses remote compact: ${config.capabilities?.remoteCompact === true ? "enabled" : "not declared"}`);
  }
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(formatProviderProxyLine(config.baseUrl, config.fileEnv));
  console.log(`Model: ${config.model}`);
  console.log(`Vision input: ${config.capabilities?.vision === true ? "available" : "not declared"}`);
  console.log(`Provider config: ${config.registry.source}${config.registry.path ? ` (${config.registry.path})` : ""}`);
  console.log(`Provider env: ${config.hasProviderEnvFile ? "file" : "missing"} (${config.providerEnvPath})`);
  console.log(`API key: ${config.hasApiKey ? "available" : "missing"}`);
  console.log(`Tavily web tools: ${userEnv.effectiveEnv.TAVILY_API_KEY ? "available" : "missing"} (${userEnv.path})`);
  console.log(`MCP config: ${mcp.configured ? (mcp.enabled ? "enabled" : "disabled") : "not configured"} (${mcp.path})`);
  console.log(`MCP env: ${mcp.hasEnvFile ? "file" : "missing"} (${mcp.envPath})`);
  console.log(`Permissions: ${permissions.defaultMode}${permissions.exists ? "" : " (defaults)"} (${permissions.path})`);
  console.log(`Semantic Judge: ${qualityStatus}`);
  console.log(`Shell exec: ${permissions.shellExec ? "enabled; permission mode applies" : "disabled"}; interpreter ${
    shell ? `${shell.displayName} (${shell.executablePath})` : `${permissions.shellInterpreter} unavailable`
  }`);
  for (const layer of assets.layers) {
    console.log(`Assets ${layer.source}: ${layer.present ? `${layer.fileCount} files` : "missing"} (${layer.directory})`);
  }
  console.log(assets.harness
    ? `Harness: ${assets.harness.selection} ${assets.harness.identity.packId}@${assets.harness.identity.packVersion}`
    : `Assets manifest: ${assets.manifest ? `${assets.manifest.source} (${assets.manifest.path})` : "missing"}`);
  console.log(`Skills: ${skillsStatus} (host, harness, user, project, installed)`);
  if (mcp.statuses.length > 0) {
    for (const status of mcp.statuses) {
      const state = status.connected ? `connected, ${status.toolCount} tools` : status.enabled ? "error" : "disabled";
      const detail = status.error ?? status.detail;
      console.log(`MCP server ${status.id}: ${state}${detail ? ` (${detail})` : ""}`);
    }
  }
  console.log(`Missing: ${config.missing.length > 0 ? config.missing.join(", ") : "none"}`);
}

const responsesTierLabels: Record<ResponsesProfile, string> = {
  "openai-public": "OpenAI public conformance profile",
  "codex-http-relay": "narrow third-party relay profile",
  "codex-beta-2026-02-06": "frozen Codex application profile",
  "mimo-subset-2026-07-30": "third-party compatible subset",
  "deepseek-subset-2026-07-31": "DeepSeek Responses compatible subset",
};

function responsesTier(profile: ResponsesProfile | undefined): string {
  return profile ? responsesTierLabels[profile] : "unknown";
}

function formatProviderProxyLine(baseUrl: string, fileEnv: NodeJS.ProcessEnv): string {
  let destination: URL;
  try {
    destination = new URL(baseUrl);
  } catch {
    return "Provider proxy: direct (no configured route)";
  }
  try {
    const policy = loadProviderProxyPolicy({ userFileEnv: fileEnv, processEnv: process.env });
    const diagnostic = describeProviderProxy(policy, destination);
    return formatProviderProxyDiagnostic(diagnostic);
  } catch {
    // Invalid proxy configuration: fixed safe message, no value echoed.
    return "Provider proxy: invalid (set VESICLE_PROVIDER_PROXY to a complete http:// or https:// URL)";
  }
}
