import { inspectProviderConfig, loadUserConfigEnvironment } from "../config/providers";
import { inspectMcpConfig } from "../mcp/registry";

export async function runDoctor(): Promise<void> {
  const config = await inspectProviderConfig();
  const userEnv = await loadUserConfigEnvironment();
  const mcp = await inspectMcpConfig();
  const bunVersion = Bun.version;

  console.log("Prism Vesicle Doctor");
  console.log(`Bun: ${bunVersion}`);
  console.log(`Project: ${process.cwd()}`);
  console.log(`Provider: ${config.providerId}`);
  console.log(`Protocol: ${config.provider}`);
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Model: ${config.model}`);
  console.log(`Vision input: ${config.capabilities?.vision === true ? "available" : "not declared"}`);
  console.log(`Provider config: ${config.registry.source}${config.registry.path ? ` (${config.registry.path})` : ""}`);
  console.log(`Provider env: ${config.hasProviderEnvFile ? "file" : "missing"} (${config.providerEnvPath})`);
  console.log(`API key: ${config.hasApiKey ? "available" : "missing"}`);
  console.log(`Tavily web tools: ${userEnv.effectiveEnv.TAVILY_API_KEY ? "available" : "missing"} (${userEnv.path})`);
  console.log(`MCP config: ${mcp.configured ? (mcp.enabled ? "enabled" : "disabled") : "not configured"} (${mcp.path})`);
  console.log(`MCP env: ${mcp.hasEnvFile ? "file" : "missing"} (${mcp.envPath})`);
  if (mcp.statuses.length > 0) {
    for (const status of mcp.statuses) {
      const state = status.connected ? `connected, ${status.toolCount} tools` : status.enabled ? "error" : "disabled";
      const detail = status.error ?? status.detail;
      console.log(`MCP server ${status.id}: ${state}${detail ? ` (${detail})` : ""}`);
    }
  }
  console.log(`Missing: ${config.missing.length > 0 ? config.missing.join(", ") : "none"}`);
}
