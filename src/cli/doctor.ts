import { inspectProviderConfig } from "../config/providers";

export async function runDoctor(): Promise<void> {
  const config = await inspectProviderConfig();
  const bunVersion = Bun.version;

  console.log("Prism Vesicle Doctor");
  console.log(`Bun: ${bunVersion}`);
  console.log(`Project: ${process.cwd()}`);
  console.log(`Provider: ${config.providerId}`);
  console.log(`Protocol: ${config.provider}`);
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Model: ${config.model}`);
  console.log(`Provider config: ${config.registry.source}${config.registry.path ? ` (${config.registry.path})` : ""}`);
  console.log(`API key: ${config.hasApiKey ? "available" : "missing"}`);
  console.log(`Missing: ${config.missing.length > 0 ? config.missing.join(", ") : "none"}`);
}
