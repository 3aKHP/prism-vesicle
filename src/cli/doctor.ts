import { inspectConfig } from "../config/env";

export async function runDoctor(): Promise<void> {
  const config = inspectConfig();
  const bunVersion = Bun.version;

  console.log("Prism Vesicle Doctor");
  console.log(`Bun: ${bunVersion}`);
  console.log(`Project: ${process.cwd()}`);
  console.log(`Provider: ${config.provider}`);
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Model: ${config.model}`);
  console.log(`API key: ${config.hasApiKey ? "available" : "missing"}`);
  console.log(`Missing: ${config.missing.length > 0 ? config.missing.join(", ") : "none"}`);
}
