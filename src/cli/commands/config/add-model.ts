// vesicle config add-model — append a model to an existing provider.
// The JSON entry is validated by the canonical validator in config/providers
// (single owner of model-entry shape), the model id must be unique within the
// provider, and the write goes through the shared registry pipeline.

import { validateModelEntryShape } from "../../../config/providers";
import { appendModelToProviderSource } from "../../../config/provider-source-edit";
import { editProviderRegistrySource } from "../../../setup/config-writer";

type AddModelResult = {
  ok: true;
  operation: "add-model";
  providerId: string;
  modelId: string;
  path: string;
  restartRequired: boolean;
};

export async function runAddModel(args: string[]): Promise<void> {
  if (args.length !== 3 || args[1] !== "--json") {
    console.error("Usage: vesicle config add-model <provider-id> --json '<entry>'");
    process.exitCode = 1;
    return;
  }
  const providerId = args[0]!;
  const jsonStr = args[2]!;
  let entry: unknown;
  try {
    entry = JSON.parse(jsonStr);
  } catch {
    console.error("Invalid JSON. Provide a valid JSON object as the --json argument.");
    process.exitCode = 1;
    return;
  }

  try {
    const result = await addModel(providerId, entry);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function addModel(providerId: string, entry: unknown): Promise<AddModelResult> {
  const model = validateModelEntryShape(entry);
  const path = await editProviderRegistrySource((source, registry) => {
    const provider = registry.providers.find((entry) => entry.id === providerId);
    if (!provider) {
      throw new Error(`Unknown provider "${providerId}". Available: ${registry.providers.map((entry) => entry.id).join(", ")}.`);
    }
    if (provider.models.some((existing) => existing.id === model.id)) {
      throw new Error(`Provider "${providerId}" already declares model "${model.id}".`);
    }
    return appendModelToProviderSource(source, providerId, model);
  });

  return {
    ok: true,
    operation: "add-model",
    providerId,
    modelId: model.id,
    path,
    restartRequired: true,
  };
}
